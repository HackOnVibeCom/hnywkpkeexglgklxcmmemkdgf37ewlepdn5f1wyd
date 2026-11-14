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
