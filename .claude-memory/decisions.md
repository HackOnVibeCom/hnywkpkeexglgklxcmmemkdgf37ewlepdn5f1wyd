# Decisions (ADR log)

## ADR-001 — Product is an async credit exchange, not live moderated testing
Decision: Founders swap 2–3 min tests of public URLs for Test Credits; structured async feedback.
Rejected: WebRTC/PeerJS live sessions (my first, wrong interpretation; user corrected it).
Consequence: no realtime layer, no signaling; everything is request/response against Supabase.

## ADR-002 — Supabase (Postgres + Anonymous Auth + RLS + RPC) behind a static Vite SPA
Decision: Persistent DB is source of truth; browser has read-only RLS access; every write is a SECURITY DEFINER RPC keyed on `auth.uid()`.
Reason: hosting is static-only (Cloudflare Pages); balances/spends must be atomic and tamper-proof, which client code cannot guarantee.
Consequence: credits = append-only ledger + `profiles.credit_balance` mirror updated in the same transaction; unique partial indexes make starter/reward/spend idempotent.

## ADR-003 — Server-side hiding of other users' data via RPC, not public policies
Decision: No public/anon policies. Discovery and test-page data come from `list_open_campaigns` / `get_campaign_for_test`. `tester_id` is column-revoked.
Reason: avoids exposing owner ids/URLs in bulk and keeps feedback private by default (`share_consent` default false).
Consequence: clients must select explicit columns on `test_submissions`.

## ADR-004 — One-response campaigns for MVP
Decision: `max_responses = 1` (CHECK). First valid submission wins; campaign locks `FOR UPDATE` to serialize racers.
Consequence: race loser gets `campaign_closed`, no credit. Expand later by relaxing the CHECK + pricing.

## ADR-005 — supabase-js pinned to ~2.105; build must stay Node-20 clean
Reason: 2.110+ declare `node >=22`; CI workflow uses Node 20. Verified `npm ci` + build with real Node 20.20 and zero EBADENGINE warnings.

## ADR-006 — Env injection via committed `.env.production` (public values only)
Reason: deploy.yml is managed centrally and passes no env to the build; Vite inlines VITE_* at build time. Anon/publishable key is public by design (RLS-protected). The app refuses a service_role/secret key at startup.

## ADR-007 — Next phase (APPROVED direction 2026-11-13, NOT yet implemented): anti-abuse, Turnstile, referral growth
Baseline: commit `120b943` is the stable checkpoint (tested MVP). Existing migrations 1-3 are applied to the live project and must never be edited — all changes go in NEW migration files, applied only after `supabase db push --dry-run` + explicit user approval.
Priorities (user-set):
1. Anti-abuse: 7-day campaign expiry, 15-min reservation (`start_test`), 60 s minimum time on task, 5 rewarded tests / rolling 24 h per identity.
2. Security: Cloudflare Turnstile on anonymous sign-in (user creates keys; secret goes only into the Supabase dashboard, never the repo; site key is public). Reservations must expire safely; refunds idempotent (unique ledger index per campaign, never twice); existing feedback is never deleted or lost (expiry/cancel only change status; never cascade-delete submissions).
3. Zero-CAC: organic sharing, referral links, shareable proof card. Sharing must give a genuine reason to invite (referrer earns +1 credit only after the invitee's first valid test; cap ~3). Proof card is consent-gated (`share_consent`) and needs an anon-callable RPC -> requires explicit approval of that loosening before building.
4. Testing before any deploy: PGlite DB suite, browser suite, and real-Supabase two-user run (incl. races, refunds, expiry, reservation timeout).
Still forbidden without approval: push, merge to main, deploy, production DB changes.

## ADR-008 — Phase 1 lifecycle: lazy settlement, reservations, single refund path
Decision: expiry and reservation lapse are evaluated lazily with time comparisons (no cron). Refunds go through ONE internal function (`close_campaign_refund`) guarded by the status transition under the campaign row lock plus a unique ledger index. Lock order is campaign -> profile everywhere; the multi-row settler takes profile locks with SKIP LOCKED so it can never wait. A tester holding a live reservation may finish after the campaign expired (settlement skips reserved campaigns) so typed feedback is never stranded. The website URL is revealed only to the reservation holder.
Rejected: pg_cron (not guaranteed on every plan, extra moving part); client-side expiry (untrusted); reward-then-clawback for junk feedback (negative-balance complexity) - deferred.
Consequence: refunds happen when anyone loads Discover/Dashboard; reservation griefing by many identities is possible until Turnstile; migration 4 replaces submit_test, so UI and migration must be deployed together.
