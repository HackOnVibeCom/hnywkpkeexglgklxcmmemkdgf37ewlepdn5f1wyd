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

## ADR-010 - Host the public site on Vercel (decided 2026-11-14)
Decision: Vercel serves the static Vite build; Supabase stays the backend; the HackOnVibe GitHub repo keeps the history. Deploys use the Vercel CLI from the working tree (no GitHub integration with the private org). `vercel.json` = build + SPA rewrite + security headers; VITE_* values are Vercel project env vars, not committed files.
Reason: the organisers' Cloudflare pipeline silently skips every deploy step in this repo (org secret CLOUDFLARE_API_TOKEN not available), so there is no verifiable live URL from it.
Rejected: waiting on the organisers' token; committing a .env.production.
Consequence: public/_headers (Cloudflare) is inert on Vercel; env changes need a redeploy; the Turnstile hostname is the Vercel production hostname; Vercel preview URLs are behind Vercel auth by default, the production URL is public.

## ADR-009 - Phase 2 growth: referral reward paid by lazy settlement; results card is client-side only
Decision: a referrer earns +1 credit (cap 3) when an invitee finishes their FIRST rewarded test after claiming. Payment is a separate idempotent settle_referral_rewards() (SKIP LOCKED, never waits) run on Discover/Dashboard loads - NOT inside submit_test - so no new lock order enters the money path. Idempotency: referrals PK(referee) + unique ledger index (referee_id). Invitee ids are hidden from clients (credit_ledger column grants). The shareable "results/proof card" is computed in the browser from the founder's own data (aggregates + consented quotes only); NO anon-callable public endpoint was added. Turnstile is opt-in by build env (VITE_TURNSTILE_SITE_KEY); the secret lives only in the Supabase dashboard; CAPTCHA must be enabled server-side only AFTER the Turnstile-aware frontend is deployed.
Rejected: public proof pages (needs anon RPC, loosens "anon gets nothing"); paying the referrer at signup (trivially farmable); paying inside submit_test (new lock inversion).
Consequence: referral credits mint new credits (total = identities + referral rewards); farming is bounded by CAPTCHA + 60 s real test + cap 3 per referrer, not prevented (the cap shapes the tree; it is not an anti-abuse control).
Review amendments (independent security review, all fixed before the migration was ever applied): (1) cap + parked-failure filter live in the settlement CURSOR (rows that can never be paid must not fill the 25-row window and starve others); (2) a qualifying test must be on a campaign NOT owned by the referrer (timing de-anonymisation of the tester + alt-identity self-dealing); (3) credit_ledger.referee_id has NO foreign key (FK = KEY SHARE wait on the invitee profile and ON DELETE SET NULL conflicted with the CHECK, blocking deletion of paid invitees); (4) claim_referral answers caller-state first and mutual as invalid_code (no code-existence oracle) + pair advisory lock; (5) the claim is not awaited at boot, Turnstile script load has a 20 s timeout; (6) the cap of 3 and the `rewarded` count are read from credit_ledger (durable), NOT from referrals rows, so deleting paid invitees (admin purge of anonymous users) cannot re-open the cap. After deleting an invitee: their referrals row + own ledger cascade away, the referrer keeps credit + ledger row (opaque dangling referee_id, unreadable by clients), the unique index still blocks re-payment. After deleting a referrer: their invitees' referrals cascade, invitees keep their own credits.
