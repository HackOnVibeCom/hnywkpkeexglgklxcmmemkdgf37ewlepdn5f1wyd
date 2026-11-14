# PeerProbe — project instructions

Peer-to-peer human usability-testing credit exchange (HackOnVibe MVP). Read `.claude-memory/` first; it holds decisions and current state. `README.md` has setup.

## Commands
- `npm run dev` / `npm run typecheck` / `npm run build` (CI runs the build on **Node 20**)
- `npm run test:db` — real-Postgres (PGlite) tests of the Supabase migrations (core + lifecycle + upgrade rehearsal)
- Phase 2 (referrals + Turnstile) code lives in `src/lib/{referral,turnstile}.ts`, `src/components/Share.tsx`; migration `20261114000200_referrals.sql` is NOT applied until the user approves a reviewed dry-run; **never enable Supabase CAPTCHA before the Turnstile-aware frontend is deployed**.
- `npm run test:browser` — real Chrome vs a **stubbed** API (builds the app twice into a temp dir)
- `PEERPROBE_LIVE_TESTS=1 node tests/live/live-e2e.mjs` — writes to the REAL Supabase project in `.env.local`; only after migration 4 is applied and with the user's OK

## Hard rules (from the user)
- **No login wall, ever.** All core features work via Supabase Anonymous Auth, created silently.
- Frontend only is static (Vite → `dist/index.html`). No SSR/Next/Express/WebRTC/PeerJS.
- **Do not edit** `.github/workflows/deploy.yml` or `.wrangler/cache/*`.
- **Never push or deploy without the user's explicit approval** (push to `main` = production deploy).
- Never put a `service_role`/secret key in the browser, `.env*` committed files, or docs. Only the public anon/publishable key.
- No fake testers, feedback, results, or usage metrics — empty states must be honest.
- All DB writes go through `SECURITY DEFINER` RPCs; clients are read-only via RLS. Keep it that way.

- **Migrations 1–3 are applied in production: never edit them.** Change the schema only with new migration files, rehearse with `supabase db push --dry-run --remote`; applying anything to the live DB needs explicit user approval.

## Gotchas
- Vite inlines `VITE_*` at build time and the CI workflow cannot pass env vars → committed `.env.production` (public values only) or repo var `BUILD_CMD`.
- Keep `@supabase/supabase-js` on the `~2.105` line: 2.110+ declare `node >=22`, CI uses Node 20.
- `test_submissions.tester_id` is column-revoked; always list columns explicitly (no `select *`).
- Don't write `useEffect(() => someFn(), …)`: an expression-bodied effect returns the call's result, and a non-function return crashes React on unmount (this bit us with `window.scrollTo`).
- JS edits of SQL: `String.replace(a, "...$$...")` turns `$$` into `$` (use `split/join`); inline `node - <<EOF` scripts have been flaky on this machine — write scripts to files.
- Don't run two Vite dev servers against the same checkout (shared `node_modules/.vite` cache on OneDrive → duplicate-React errors).
