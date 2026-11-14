# PeerProbe

**Peer-to-peer human usability testing exchange.** Founders swap 2–3 minute tests of each other's products:

1. A founder submits a public website URL and one specific task (costs **1 Test Credit**).
2. Another founder opens the site, does the task, and submits structured feedback (task completed? friction, suggested improvement, 1–5 UX rating).
3. The tester earns **1 Test Credit** for each valid, unique completed test.
4. Every new anonymous user gets exactly **one starter credit**.
5. Founders read the real feedback on their dashboard.

**No registration, email, password or OAuth — ever.** Identity is a Supabase *Anonymous Auth* user created silently on first visit.

> Built for HackOnVibe. Live site = Cloudflare Pages static deploy of `dist/` (see [Deployment](#deployment)).

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 19 + TypeScript + Tailwind CSS 4 + React Router |
| Hosting | Cloudflare Pages (static) via the existing GitHub Actions workflow — **not modified** |
| Backend | Supabase: Postgres, Anonymous Auth, Row Level Security, SQL RPC functions |
| AI summaries | *Not built yet.* Planned as a Supabase Edge Function with a server-side key (never in the browser) |

No SSR, Node server, WebRTC or PeerJS.

## Status — read this first

| Area | State |
|---|---|
| Database schema, RLS, atomic RPCs | Implemented. **118 assertions pass against real Postgres (PGlite)** — `npm run test:db`. Not yet applied to a live Supabase project. |
| 5 screens (landing, discover, create, test, dashboard) | Implemented, typechecked, builds on Node 20. Layout checked in Chrome at 1280px and 360px. |
| End-to-end against a real Supabase project | **Not done — blocked on Supabase credentials.** Until then the deployed site shows an explicit "Backend not configured" notice (nothing is mocked). |
| AI summary of recurring problems | Not implemented (dashboard says so). |
| Referrals, public proof cards | Not implemented (post-MVP, by design). |

## Setup

### 1. Create the Supabase project (≈5 min, you must do this)

1. Create a project at <https://supabase.com>.
2. **Enable anonymous sign-ins:** *Authentication → Sign In / Providers → Allow anonymous sign-ins* → ON. *(Without this the app shows a setup error.)*
3. **Apply the migrations** in order — paste each file into *SQL Editor → Run*, or use the Supabase CLI (`supabase link` then `supabase db push`):
   - `supabase/migrations/20261113000100_schema.sql`
   - `supabase/migrations/20261113000200_rls.sql`
   - `supabase/migrations/20261113000300_rpc.sql`
4. Copy from *Project Settings → API*: the **Project URL** and the **anon / publishable key**.
   Use **only** the public anon/publishable key. The app refuses to start if it detects a `service_role`/secret key.
5. *(Strongly recommended)* *Authentication → Attack Protection → CAPTCHA* (e.g. Cloudflare Turnstile) to make mass-creating anonymous identities harder. This needs a small client change (pass the captcha token to `signInAnonymously`) that is **not** implemented yet.

### 2. Run locally

```bash
cp .env.example .env.local      # then fill in the two values
npm install
npm run dev                     # http://localhost:5173
```

Other scripts: `npm run typecheck`, `npm run build`, `npm run preview`, `npm run test:db`.

### 3. Verify the full flow (fresh incognito windows)

Anonymous identity lives in browser storage, so use **two separate incognito windows (or two browsers)** as two founders:

1. **Window A:** open the site → *Request a test* → post a task (spends A's starter credit → balance 0).
2. **Window B:** open the site (gets its own starter credit) → *Discover* → *Start test* → submit feedback → B's balance becomes 2.
3. **Window A:** *Dashboard* → feedback from B is visible.
4. Check: A cannot see their own task in Discover; B cannot test the same task twice; A cannot request another test at 0 credits.

## Deployment

The existing workflow `.github/workflows/deploy.yml` (do **not** edit it) detects `package.json` → runs `npm ci` + `npm run build` on Node 20 → publishes `dist/` to Cloudflare Pages on every push to `main`, adding `_redirects` (SPA fallback) automatically. This repo is compatible with it (verified with a clean `npm ci` + build under Node 20.20).

**⚠️ The workflow cannot pass environment variables to the build.** Vite inlines `VITE_*` values at build time, so without them the live site shows "Backend not configured". Pick one:

- **Recommended:** create a committed `.env.production` containing *only* the two public values (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). They are public by design — the anon key is protected by RLS. **Never** put the `service_role`/secret key in any committed file.
- Alternative: set the repo variable `BUILD_CMD` (Settings → Secrets and variables → Actions → Variables) to  
  `VITE_SUPABASE_URL=https://xxx.supabase.co VITE_SUPABASE_ANON_KEY=xxx npm run build`

**Pushing to `main` deploys to production immediately** (no preview for PRs). Work on branches; merge deliberately.

## Security model (summary — details in [supabase/README.md](supabase/README.md))

- Browsers have **read-only** table access via RLS (own rows only). **All writes go through `SECURITY DEFINER` RPCs** that use `auth.uid()`; the `anon` role has no access.
- Starter credit: `INSERT … ON CONFLICT DO NOTHING` + a unique partial index → exactly once per identity.
- Spend / reward: row locks (`FOR UPDATE`) + ledger inserts + balance update in one transaction; unique indexes make double-spend/double-reward impossible even if code regresses.
- Self-testing blocked in the RPC **and** by a trigger. One submission per tester per campaign (unique constraint). One-response campaigns: the first valid submission closes it.
- Testers stay anonymous to founders (`tester_id` is not column-granted). Feedback is private unless the tester ticks the optional sharing box; nothing in the MVP exposes feedback publicly.
- URLs are validated (public http(s) host only; no localhost/IPs/credentials/`javascript:`), rendered with `rel="noopener noreferrer"`; user text is rendered as text, never HTML.

## Known limitations (honest list)

- **Anonymous identity does not prevent multi-account abuse.** One person can clear storage / open incognito windows to mint unlimited starter credits and farm rewards by testing their own products from another identity. The constraints are per-identity only. Mitigations to add: CAPTCHA on anonymous sign-in (above), per-IP/rate limits, minimum time-on-task enforced server-side, a quality/flagging step before crediting, reputation.
- **A single identity can drain open campaigns with junk feedback.** `submit_test` only checks text length (≥10 chars, whitespace-only rejected). One scripted identity could close every open one-response campaign in seconds, each time earning a credit and costing an honest founder theirs. There is no per-identity rate limit, no server-side time-on-task, no way for a founder to reject/dispute feedback, and no refund. Priority fixes: `start_test` RPC recording a server timestamp + minimum elapsed time, a per-identity hourly cap, and a founder "unhelpful" flag that refunds the credit.
- **Feed can be starved.** `list_open_campaigns` shows the 50 oldest open campaigns with no expiry, cancel RPC, pagination or per-owner cap, so abandoned or spam campaigns can crowd out new ones.
- **No CSP** in `public/_headers` (React escapes all user text and nothing uses `dangerouslySetInnerHTML`, so this is defence in depth). Add one once the Supabase URL is known.
- **Hosts are only syntactically validated:** names like `foo.localhost` or `127.0.0.1.nip.io` pass; testers are warned that sites are unvetted, but there is no reporting/blocklist. The URL is only ever opened in the tester's own browser (no server-side fetch).
- **Two tabs opened simultaneously on a first visit** can each create an anonymous identity (one unused credit is orphaned).
- **Slow failure when a returning user is offline:** supabase-js retries the token refresh for ~50 s before the retryable error appears. The identity is preserved (verified), only the wait is poor.
- **Credits are tied to one browser.** Clearing site data = new identity = lost credits. An optional (never mandatory) "save my identity" via Supabase identity linking is a possible later feature.
- **First-come one-response campaigns:** if two testers work on the same task at once, the slower one gets "task already completed" and no credit (their typed feedback is lost). A claim/reservation step would fix this.
- Feedback quality is only length-validated (≥10 characters per text answer).
- No cancel/refund of an unanswered request yet.
- No automated tests for the React UI beyond a manual browser pass; the DB layer has the automated suite.

## Repository layout

```
src/                    React app (pages/, components/, lib/, context/)
supabase/migrations/    Schema, RLS, RPC functions (apply in filename order)
supabase/tests/         PGlite-based SQL test-suite (isolated package; not part of the app build)
public/_headers         Security headers + no-store (mirrors what the CI would add)
.env.example            Public Supabase settings template
.github/workflows/      Managed centrally by HackOnVibe — do not edit
```
