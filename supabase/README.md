# Supabase backend

Apply `migrations/*.sql` in filename order (SQL Editor or `supabase db push`).

| File | Purpose |
|---|---|
| `…0100_schema.sql` | Tables, constraints, URL validator, ledger idempotency indexes, self-test trigger |
| `…0200_rls.sql` | `REVOKE ALL` then `SELECT`-only grants + RLS policies (own rows only) |
| `…0300_rpc.sql` | The only write path: atomic `SECURITY DEFINER` functions |

## Data model

- `profiles` — 1 row per anonymous user (`id = auth.users.id`), holds `credit_balance` (≥ 0).
- `projects` — a website to test. `campaigns` — one requested test (task) for a project; MVP: `max_responses = 1`.
- `test_submissions` — feedback; `UNIQUE (campaign_id, tester_id)`; `share_consent` default `false`.
- `credit_ledger` — append-only history. Invariant: `profiles.credit_balance = SUM(credit_ledger.delta)` (asserted in tests).

## RPC functions (all `authenticated` only; `anon` has no EXECUTE)

| Function | What it does |
|---|---|
| `ensure_profile()` | Idempotent. Creates profile + exactly one starter credit. Called automatically on every app load. |
| `create_project_with_campaign(name, url, description, task)` | Validates, locks the caller's profile, spends 1 credit, creates project + campaign. |
| `list_open_campaigns()` | Discovery feed (no URL, no owner id). Excludes own and already-tested campaigns. |
| `get_campaign_for_test(id)` | One eligible campaign incl. the URL. Empty if own / closed / already tested. |
| `submit_test(campaign, completed, friction, suggestion, rating, consent)` | Locks the campaign, validates, stores feedback, awards 1 credit, closes the campaign. |

Errors are raised as short codes (`insufficient_credits`, `own_campaign`, `campaign_closed`, …) that the frontend maps to friendly text.

## Access matrix (authenticated browser client)

| Table | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| profiles, projects, campaigns, credit_ledger | own rows | none (RPC only) |
| test_submissions | rows you wrote **or** on campaigns you own; `tester_id` column hidden | none (RPC only) |

Because `tester_id` is not granted, clients must list columns explicitly (`select *` on `test_submissions` is rejected by Postgres). `src/lib/api.ts` does this.

## Tests

```bash
npm run test:db     # from repo root; installs PGlite in supabase/tests/ and runs run.mjs
```

Runs the real migrations in real Postgres (WASM) with stubbed Supabase roles/`auth` schema. Covers: anon denied, starter credit once, no direct writes, RLS isolation, URL validation, spend/earn atomicity, self-test blocked, duplicate reward blocked, race loser gets no credit, tester anonymity, ledger = balance.

**Not covered** (PGlite is single-connection and has no PostgREST/GoTrue): true parallel races, PostgREST request handling, real Supabase default privileges, JWT handling. Re-verify these on the real project (see root README step 3).
