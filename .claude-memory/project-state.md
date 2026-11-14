# PeerProbe — project state

_Last updated: 2026-11-14 (branch `feat/peerprobe-mvp`, not pushed). Stable checkpoint commit: `120b943` (tested MVP). Phase 1 work below is UNCOMMITTED._

## What exists
- Vite + React 19 + TS + Tailwind 4 SPA, 5 screens: Landing, Discover, CreateTask, TestTask, Dashboard.
- Supabase migrations 1-3 (schema / RLS / atomic RPCs) **applied to the live project** (ref `zrzkacgarquzbemsnosw`; Data API on, auto table exposure OFF, auto RLS ON, anonymous sign-ins ON) and verified end-to-end on 2026-11-13 (API 54/54, real browser 23/23, true parallel races).
- Auto anonymous auth bootstrap (`src/context/AuthContext.tsx`): `getSession` → `signInAnonymously` if none → `ensure_profile` RPC.
- When env missing/placeholder/secret-key: app shows "Backend not configured" (never mock data). Local `.env.local` (gitignored) holds URL + publishable key.

## Phase 1 (2026-11-14) — committed locally (f692d2b), migration 4 APPLIED to the live project
New migration `supabase/migrations/20261114000100_lifecycle_antiabuse.sql` (+ UI): 7-day expiry, 15-min reservations (`start_test`, `test_reservations`), URL revealed only to the reservation holder, 60 s minimum testing time, 5 rewarded tests / rolling 24 h, `cancel_campaign` + `settle_expired_campaigns` (refund exactly once via `close_campaign_refund`), `get_my_status`; Discover/Dashboard/TestTask UI; drafts kept in sessionStorage.
- Tests: `npm run test:db` = 119 core + 118 lifecycle + 19 upgrade-rehearsal assertions (PGlite); `npm run test:browser` = 58 + 77 (real Chrome, stubbed API); `tests/live/live-e2e.mjs` (57 checks) validated only against a local PostgREST emulator, **not yet run against the real project**. Mutation-tested: 25/26 mutants caught (survivor = lock-skip deadlock fix, only observable under real concurrency).
- Independent security review (reviewer-security): no CRITICAL/HIGH. Fixed from it: settle-vs-settle deadlock (profile `SKIP LOCKED`), poison-campaign isolation, already_tested on lost-response retry, `clock_timestamp()` after lock waits, stale drafts. Accepted/documented: Sybil reservation griefing (needs Turnstile), lazy settlement, identity purge cascades feedback.
- **Applied 2026-11-14** via `supabase db push --remote --skip-vault --yes` (user-approved); remote history lists all 4 migrations. Real-project run of tests/live/live-e2e.mjs: **57/57 passed** (true parallel races: one reservation winner, one refund among 6 parallel cancels, one reward among 2 parallel submits, credits conserved). **Manual expiry/lapse check DONE on prod 2026-11-14: 19/19 passed** (7-day expiry hidden before settlement, refunded exactly once incl. parallel settles; lapsed reservation freed the task with no cron, lapsed tester got reservation_expired, founder cancel refunded; user ran the 2 marked UPDATEs in the SQL Editor). Earlier plan (kept for reference): manual expiry/lapse check = `tests/live/expiry-check.mjs prepare` -> user reviews + runs 2 marked UPDATEs in the SQL Editor -> `verify` (rehearsed 19/19 on the emulator, NOT yet run on prod). UI not deployed (no push).
- (superseded) **Next step needed user approval:** `supabase db push --dry-run --remote` → apply migration 4 → run `PEERPROBE_LIVE_TESTS=1 node tests/live/live-e2e.mjs` → manual expiry check (README) → commit. Apply migration 4 and deploy the UI together (old UI can't submit, new UI needs the new RPCs).

## Not done / blocked
- Deploy env injection: CI can't pass env; needs committed `.env.production` (public values) or `BUILD_CMD` repo var (needs user approval to commit/push; push to `main` = production deploy).
- Phase 2 (approved direction, ADR-007): Cloudflare Turnstile on anonymous sign-in (user creates keys; secret only in the Supabase dashboard), referral links, shareable consent-gated proof card (needs an anon-callable RPC → ask first).
- AI summary (Edge Function) — post-MVP.
- Live DB contains E2E test rows (≈10 anonymous identities, closed campaigns, test feedback); no open campaigns.

## Known risks
- Anonymous identity ≠ anti-Sybil: unlimited starter credits via new incognito identities; many identities can also grief reservations. Mitigation planned: Turnstile. Documented in README/UI.
- Feedback quality is only length-validated; no founder dispute/clawback.
- CSP not set; `.wrangler/cache` tracked with an account email (user forbade touching it); multi-tab first visit can create two identities.

## PRE-LAUNCH SECURITY CHECKLIST (must be resolved or explicitly accepted before real users)
- [ ] Anonymous-user deletion cascade: `test_submissions`, `credit_ledger`, `profiles`, `projects`, `campaigns` all cascade from `auth.users` (ON DELETE CASCADE, migration 1). Purging/deleting anonymous users in the Supabase dashboard (or any auth cleanup job) silently DELETES their feedback and ledger history, which also breaks "never delete feedback" and credit conservation. Before launch: document "never purge anonymous users", and/or add a migration that preserves feedback (e.g. anonymise tester_id / ON DELETE SET NULL / retention table). Export feedback before any purge.
- [ ] Cloudflare Turnstile on anonymous sign-in (Sybil starter credits + reservation griefing).
- [ ] CSP header in public/_headers once the Supabase URL is final.
- [ ] `.wrangler/cache` is tracked and contains an account email (user forbade editing it).
- [ ] Multi-tab first visit can create two anonymous identities (orphan identity, no credit).
- [ ] Apply migration 4 together with the matching UI; run tests/live/live-e2e.mjs on the real project; manual expiry check (README).


