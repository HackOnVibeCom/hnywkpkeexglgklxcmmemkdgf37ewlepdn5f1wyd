# PeerProbe — project state

_Last updated: 2026-11-13 (branch `feat/peerprobe-mvp`, not pushed)_

## What exists
- Vite + React 19 + TS + Tailwind 4 SPA, 5 screens: Landing, Discover, CreateTask, TestTask, Dashboard.
- Supabase migrations (schema / RLS / atomic RPCs) in `supabase/migrations/`; PGlite test-suite in `supabase/tests/` (118 assertions green; independent security review done — no CRITICAL/HIGH; fixed: expired-session identity overwrite, whitespace-only inputs, future-object default privileges, build-time secret-key guard).
- Auto anonymous auth bootstrap (`src/context/AuthContext.tsx`): `getSession` → `signInAnonymously` if none → `ensure_profile` RPC. Singleton promise guards StrictMode double-run.
- When env missing/placeholder/secret-key: app shows "Backend not configured" (never mock data).

## Not done / blocked
- **Live Supabase project verified (2026-11-13):** project ref `zrzkacgarquzbemsnosw`, settings: Data API on, auto table exposure OFF, auto RLS ON, anonymous sign-ins ON. 3 migrations applied (migration 2 now also has `grant usage on schema public to authenticated`, needed when exposure is off). Real-API script 54/54 and real-browser two-session run 23/23 passed, incl. true parallel races (one winner; no overspend; starter credit once). Local `.env.local` (gitignored) holds URL + publishable key. Still TODO: committed `.env.production` for the Cloudflare deploy (needs user approval to commit/push).
- E2E left test rows in the live DB (6+ anonymous identities, closed campaigns, test feedback). No open campaigns remain.
- Deploy env injection: CI can't pass env; needs committed `.env.production` (public values) or `BUILD_CMD` repo var.
- AI summary (Edge Function), referrals, proof cards, CAPTCHA on anonymous sign-in, claim/reservation of a task, cancel/refund: all post-MVP.

## Open review findings (need product decisions)
- M1 single identity can drain campaigns with junk feedback (needs start_test + min time, rate cap, founder dispute/refund).
- M2 feed starvation (needs expiry, cancel_campaign + refund, pagination, per-owner cap).
- Also: CSP, `.wrangler/cache` tracked with account email (user forbade touching it), multi-tab first-visit double identity.

## Known risks
- Anonymous identity ≠ anti-Sybil: unlimited starter credits via new incognito identities; self-farming from a second identity possible. Documented in README/UI.
- One-response campaign race: loser of a simultaneous submit loses typed feedback and gets no credit.
