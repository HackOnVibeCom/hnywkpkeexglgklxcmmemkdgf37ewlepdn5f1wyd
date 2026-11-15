# UXBarter (formerly PeerProbe) — project instructions

Peer-to-peer human usability-testing credit exchange (HackOnVibe MVP). Read `.claude-memory/` first; it holds decisions and current state. `README.md` has setup.

**Naming:** the product is **UXBarter** (tagline "Give feedback. Get feedback."); always write it with that capitalization in anything user-facing. Infrastructure keeps the old name on purpose and must NOT be renamed: Vercel project `peerprobe` and the secondary URL https://peerprobe.vercel.app (still a working domain and a Turnstile hostname; the primary URL is https://uxbarter.vercel.app), branch `feat/peerprobe-mvp`, Supabase project/objects/migrations, `PEERPROBE_*` test env vars, package names, `pp:*` storage keys. See README → Naming.

## Commands
- `npm run dev` / `npm run typecheck` / `npm run build` (the HackOnVibe workflow would build on **Node 20**; Vercel project uses Node 24.x; both must stay clean)
- `npm run test:db` — real-Postgres (PGlite) tests of the Supabase migrations (core + lifecycle + upgrade rehearsal)
- Phase 2 (referrals + Turnstile) code lives in `src/lib/{referral,turnstile}.ts`, `src/components/Share.tsx`; migration `20261114000200_referrals.sql` is APPLIED to production (2026-11-14) - do not edit it, change the schema only with a new migration; **never enable Supabase CAPTCHA before the Turnstile-aware frontend is deployed**.
- `npm run test:browser` — real Chrome vs a **stubbed** API (builds the app twice into a temp dir)
- `npm run test:unit` — Node unit tests of `src/lib/matching.ts` (erasable TS only so Node can import it directly).
- **Targeted Tester Matching v1 is LIVE** (migration `20261115000100_tester_matching.sql` applied to production 2026-11-15, UI deployed, merged to `main`). Rollback of the UI = promote the previous deployment (see .claude-memory/project-state.md); the migration stays in place. Any further schema change = a NEW migration, applied to production only with the user's explicit approval, BEFORE deploying the UI that needs it.
- **Matching v2 (open vs targeted testing + screening)** lives on branch `feat/matching-v2`: migration `20261115000200_matching_v2.sql` is **NOT applied** and the UI is **NOT deployed**; both, and the PR merge, need the user's explicit approval (plan + rollback: docs/MATCHING_V2_ROLLOUT.md, verification: docs/verify-migration7.sql). Apply the migration BEFORE deploying the UI. Eligibility is enforced by a trigger on `test_reservations`; never move that logic into the UI. Screening is self-reported: never call it "verified".
- `PEERPROBE_LIVE_TESTS=1 node tests/live/live-e2e.mjs` — writes to the REAL Supabase project in `.env.local` and only with the user's OK. Supabase CAPTCHA is now enforced, so new anonymous identities need a Turnstile token: these scripts cannot run unattended any more.
- `node tests/browser/csp-check.mjs` — enforces the CSP from `vercel.json` in real Chrome (stub API).
- Hosting = Vercel (team `peer-probe`, project `peerprobe`, primary https://uxbarter.vercel.app, secondary https://peerprobe.vercel.app). `vercel.json` holds build/rewrite/headers/CSP-Report-Only. Deploys are CLI-only and need the user's approval; **a Vercel project's FIRST deployment becomes Production automatically**.

## Hard rules (from the user)
- **No login wall, ever.** All core features work via Supabase Anonymous Auth, created silently.
- Frontend only is static (Vite → `dist/index.html`). No SSR/Next/Express/WebRTC/PeerJS.
- **Do not edit** `.github/workflows/deploy.yml` or `.wrangler/cache/*`.
- **Never push, merge, deploy, change Supabase/Vercel/Cloudflare settings or enable/disable CAPTCHA without the user's explicit approval.** (Push to `main` does not deploy the Vercel site, but it runs the HackOnVibe workflow.)
- Never put a `service_role`/secret key in the browser, `.env*` committed files, or docs. Only the public anon/publishable key.
- No fake testers, feedback, results, or usage metrics — empty states must be honest.
- All DB writes go through `SECURITY DEFINER` RPCs; clients are read-only via RLS. Keep it that way.

- **Migrations 1–3 are applied in production: never edit them.** Change the schema only with new migration files, rehearse with `supabase db push --dry-run --remote`; applying anything to the live DB needs explicit user approval.

## Gotchas
- Vite inlines `VITE_*` at build time. On Vercel they are project env vars (Config type): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (Production + Preview) and `VITE_TURNSTILE_SITE_KEY` (Production only: the widget is bound to uxbarter.vercel.app and peerprobe.vercel.app - both must stay in the widget). The HackOnVibe workflow cannot pass env vars and has no token for this repo.
- Vercel CLI on Windows Git Bash: prefix with `MSYS_NO_PATHCONV=1` for paths like `/discover`; `vercel link` writes `VERCEL_OIDC_TOKEN` into `.env.local` (remove it); `vercel env rm` needs `--confirm-name`.
- Cloudflare Turnstile code 600010 = Cloudflare refused the browser session (generic challenge failure), not a config error; see README → Turnstile troubleshooting.
- Keep `@supabase/supabase-js` on the `~2.105` line: 2.110+ declare `node >=22`, CI uses Node 20.
- `test_submissions.tester_id` is column-revoked; always list columns explicitly (no `select *`).
- Don't write `useEffect(() => someFn(), …)`: an expression-bodied effect returns the call's result, and a non-function return crashes React on unmount (this bit us with `window.scrollTo`).
- JS edits of SQL: `String.replace(a, "...$$...")` turns `$$` into `$` (use `split/join`); inline `node - <<EOF` scripts have been flaky on this machine — write scripts to files.
- Don't run two Vite dev servers against the same checkout (shared `node_modules/.vite` cache on OneDrive → duplicate-React errors).
