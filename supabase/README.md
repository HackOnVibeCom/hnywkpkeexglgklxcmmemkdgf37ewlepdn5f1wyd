# Supabase backend

Apply `migrations/*.sql` in filename order (SQL Editor or `supabase db push`).

| File | Purpose |
|---|---|
| `…0100_schema.sql` | Tables, constraints, URL validator, ledger idempotency indexes, self-test trigger |
| `…0200_rls.sql` | `REVOKE ALL` then `SELECT`-only grants + RLS policies (own rows only) |
| `…0300_rpc.sql` | The only write path: atomic `SECURITY DEFINER` functions |
| `20261114000200_referrals.sql` | **Phase 2**: referral links. `profiles.ref_code`, `referrals`, ledger reason `referral_reward` (+ `credit_ledger.referee_id`, a plain uuid with no FK, hidden from clients by column grants), `claim_referral`, `settle_referral_rewards`, `get_my_referrals`. |
| `20261114000100_lifecycle_antiabuse.sql` | **Phase 1**: 7-day expiry, 15-min reservations (`test_reservations`), 60 s minimum + 5/24 h reward cap, cancel + refund, settlement. Replaces `submit_test`; recreates `list_open_campaigns` / `get_campaign_for_test`. Never edit migrations 1–3: they are applied in production. |

## Data model

- `profiles` — 1 row per anonymous user (`id = auth.users.id`), holds `credit_balance` (≥ 0).
- `projects` — a website to test. `campaigns` — one requested test (task) for a project; MVP: `max_responses = 1`.
- `test_submissions` — feedback; `UNIQUE (campaign_id, tester_id)`; `share_consent` default `false`.
- `credit_ledger` — append-only history. Invariant: `profiles.credit_balance = SUM(credit_ledger.delta)` (asserted in tests). Reasons: `starter`, `test_reward`, `campaign_spend`, `campaign_refund` (one per campaign, unique index), `referral_reward` (one per invitee, unique index; migration 5).
- `test_reservations` — one row per (campaign, tester): `first_started_at` (never moves; the 60 s clock), `started_at`/`expires_at` (15-min hold), `consumed_at`, `starts` (≤ 3). Active = `consumed_at IS NULL AND expires_at > now()`. Founders can read `campaign_id, expires_at, consumed_at` of reservations on their campaigns, never `tester_id`.
- `campaigns.status`: `open` → `completed` (feedback received) | `cancelled` (founder) | `expired` (7 days, nobody tested). `closed_at` is set exactly for cancelled/expired. `expires_at` defaults to creation + 7 days.

**Lock order everywhere: campaign row → profile row.** `settle_expired_campaigns` additionally takes profile locks with `SKIP LOCKED` so it can never wait (and so never deadlock) while holding campaign locks.

## RPC functions (all `authenticated` only; `anon` has no EXECUTE)

| Function | What it does |
|---|---|
| `ensure_profile()` | Idempotent. Creates profile + exactly one starter credit. Called automatically on every app load. |
| `create_project_with_campaign(name, url, description, task)` | Validates, locks the caller's profile, spends 1 credit, creates project + campaign. |
| `list_open_campaigns()` | Discovery feed (no URL, no owner id). Excludes own, already-tested, **expired and other testers' reserved** campaigns — filtered in SQL *before* `LIMIT 50`, so dead campaigns can never starve it. Shows my own live reservation first. |
| `get_campaign_for_test(id)` | One eligible campaign. The website URL is returned **only to the holder of a live reservation**. Also returns reservation/min-time timestamps and `server_now`. |
| `start_test(id)` | Reserve for 15 min (idempotent for the holder). Errors: `own_campaign`, `campaign_closed`, `campaign_expired`, `campaign_reserved`, `reservation_exists`, `daily_limit`, `reservation_limit`, `already_tested`. |
| `submit_test(campaign, completed, friction, suggestion, rating, consent)` | Needs a live reservation and ≥ 60 s since the first one; enforces the 5 / rolling-24 h cap; stores feedback, awards 1 credit, completes the campaign. Errors add `reservation_required`, `reservation_expired`, `too_fast`, `daily_limit`. A retry after success returns `already_tested`. |
| `cancel_campaign(id)` | Owner only. Refunds the spend exactly once; refused (`campaign_reserved`) while a tester holds a live reservation; refused (`campaign_closed`) once feedback exists; idempotent on already cancelled/expired. |
| `settle_expired_campaigns()` | Expires + refunds overdue campaigns that have no live reservation (max 25 per call, `SKIP LOCKED`, per-campaign error isolation). Any signed-in client may call it; idempotent. |
| `get_my_status()` | Caller's rewards in the last 24 h, next free slot, live reservation (for honest UI). |
| `claim_referral(code)` | Links the caller to the identity owning `code`; returns `{claimed, reason}` instead of raising. Only brand-new users; no self/mutual (mutual is answered as `invalid_code`); one referrer per invitee ever. Caller-state answers (`already_referred`, `already_active`) never depend on the code, so the function cannot be used to probe which codes exist. A pair-level advisory lock closes the A-claims-B / B-claims-A race. |
| `settle_referral_rewards()` | Pays +1 to referrers whose invitee finished a rewarded test after the claim on a campaign NOT owned by the referrer; max 3 per referrer (filtered in the cursor so capped referrers can never starve the 25-row window, and re-checked under the referrer's profile lock); rows that fail 3 times are parked (`settle_failures`); bounded to 25 rows per call; `SKIP LOCKED` everywhere (never waits), per-row error isolation. Any signed-in client may call it. |
| `get_my_referrals()` | Caller's code + real counts (invited / converted / rewarded / cap). Never returns invitee identities. |
| `close_campaign_refund(id, status)` | **Internal** (not callable via the API). The single code path that closes + refunds a campaign. |

Errors are raised as short codes (`insufficient_credits`, `own_campaign`, `campaign_closed`, …) that the frontend maps to friendly text.

## Access matrix (authenticated browser client)

| Table | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| profiles, projects, campaigns, credit_ledger | own rows | none (RPC only) |
| test_submissions | rows you wrote **or** on campaigns you own; `tester_id` column hidden | none (RPC only) |

Because `tester_id` is not granted, clients must list columns explicitly (`select *` on `test_submissions` is rejected by Postgres). `src/lib/api.ts` does this.

## Tests

```bash
npm run test:db     # from repo root; installs PGlite in supabase/tests/ and runs run.mjs, lifecycle.mjs, upgrade.mjs
```

Runs the real migrations in real Postgres (WASM) with stubbed Supabase roles/`auth` schema. Covers: anon denied, starter credit once, no direct writes, RLS isolation, URL validation, spend/earn atomicity, self-test blocked, duplicate reward blocked, race loser gets no credit, tester anonymity, ledger = balance.

`referrals.mjs` covers the referral rules (see root README). `lifecycle.mjs` simulates time by shifting stored timestamps (clients cannot) and covers reservations, the 60 s minimum, the reward cap, cancel/refund idempotency, expiry settlement, the 52-expired-campaigns feed-starvation scenario, and global invariants. `upgrade.mjs` applies migration 4 on a populated database under *exposure disabled + auto-RLS*.

**Not covered** (PGlite is single-connection and has no PostgREST/GoTrue): true parallel races (including the settle-vs-settle deadlock avoidance), PostgREST request handling, real Supabase default privileges, JWT handling. Those are exercised on the real project by `tests/live/live-e2e.mjs` (needs migration 4 applied).
