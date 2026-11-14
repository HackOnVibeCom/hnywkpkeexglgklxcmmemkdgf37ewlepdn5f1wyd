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
| Database schema, RLS, atomic RPCs (migrations 1–3) | Implemented, **applied to the project and verified end-to-end** (API script + real browser, incl. true parallel races). |
| **Phase 1: campaign lifecycle + anti-abuse (migration 4)** | Implemented and tested locally. **NOT yet applied to the live project** — it needs your approval (see [Applying migration 4](#applying-migration-4-phase-1)). 7-day expiry, 15-min reservations, 60 s minimum testing time, 5 rewarded tests / rolling 24 h, cancel + refund (exactly once), expired/reserved campaigns never block Discover. |
| **Phase 2: referrals, sharing, Turnstile** | Pushed to `feat/peerprobe-mvp`. Migration 5 (`20261114000200_referrals.sql`) is **applied to the production Supabase project** (2026-11-14) and verified live (44/44 referral + 57/57 earlier checks). Supabase CAPTCHA is still **off** (enable it only after the Turnstile-aware frontend is deployed); see [Growth](#growth-referral-links-and-sharing) and [Turnstile](#cloudflare-turnstile-human-check-on-first-sign-in). |
| Automated tests | `npm run test:db` (PGlite: 119 core + 118 lifecycle + 19 upgrade-rehearsal assertions), `npm run test:browser` (real Chrome, stubbed API: 58 + 77 checks). Real-project test: `tests/live/live-e2e.mjs` (needs migration 4 applied). |
| 5 screens (landing, discover, create, test, dashboard) | Implemented, typechecked, builds on Node 20. Layout checked in Chrome at 1280px and 360px. |
| Deployed site | Shows an explicit "Backend not configured" notice until a `.env.production` with the public Supabase values is committed (nothing is mocked). |
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
   - `supabase/migrations/20261114000100_lifecycle_antiabuse.sql` *(Phase 1 — see below before applying)*
   - `supabase/migrations/20261114000200_referrals.sql` *(Phase 2 — referral links; apply only after a reviewed dry-run)*
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

## How a test works now (Phase 1 rules)

| Rule | Value | Enforced by |
|---|---|---|
| Campaign lifetime | 7 days, then it expires and the founder's credit is refunded | `campaigns.expires_at`, `settle_expired_campaigns()` (run lazily by Dashboard/Discover loads; no cron) |
| Reservation | A tester *reserves* a task (`start_test`) → it is hidden from others and the website URL is revealed **only to the holder**, for 15 minutes; it frees itself by time alone | `test_reservations`, `now()`-based |
| Minimum testing time | ≥ 60 s since the first reservation before feedback is accepted | `submit_test` |
| Reward cap | 5 rewarded tests per identity per rolling 24 h | `start_test` + `submit_test` (counted from the ledger) |
| One live reservation per tester | and at most 3 reservations per (task, tester) | `start_test` |
| Cancel | Founder can cancel an unanswered task → credit refunded; refused while a tester holds a live reservation | `cancel_campaign` |
| Refund | Exactly 1 credit, at most once, only if the campaign received **no** feedback | status transition under row lock + unique ledger index |
| Feedback | Never deleted by any RPC; completed campaigns can never be cancelled/expired/refunded | guards in `close_campaign_refund`, tested |

The constants live in the migration; `src/lib/limits.ts` mirrors them for display only.

### Applying migration 4 (Phase 1)

Prerequisite: migrations 1–3 are already applied. Migration 4 **replaces `submit_test`** (it now needs a reservation) and **drops/recreates `list_open_campaigns` and `get_campaign_for_test`** (new return shape), so the old UI cannot submit tests and the new UI cannot work without it. **Apply migration 4 and deploy this UI together.** (Today the deployed site has no Supabase env, so nothing user-facing breaks in between.)

1. Rehearse: `supabase db push --dry-run --remote` must list *only* `20261114000100_lifecycle_antiabuse.sql`. If it also lists migrations 1–3, they were applied through the SQL Editor and are missing from the CLI's history table: run `supabase migration repair --status applied 20261113000100 20261113000200 20261113000300` first (this only writes history rows).
2. Apply (`supabase db push --remote`, or paste the file into the SQL Editor).
3. Run the real-project test (≈ 75 s, writes ~9 anonymous test identities and 4 campaigns, closes them all):
   `PEERPROBE_LIVE_TESTS=1 node tests/live/live-e2e.mjs` (PowerShell: `$env:PEERPROBE_LIVE_TESTS="1"; node tests/live/live-e2e.mjs`).

#### Manual check of expiry on a real project

7-day expiry and 15-minute lapse cannot be waited out through the public API. To check them once on the real project: create a campaign in the UI, then in the SQL Editor run
`update public.campaigns set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = '<campaign id>';`
and reload the Dashboard of that founder: the campaign must show *Expired — credit refunded* and the balance must be +1 exactly once.

## Hosting on Vercel (public site)

The site is a static Vite build, so Vercel needs no server code. `vercel.json` sets the build (`npm ci` → `npm run build` → `dist`), a single-page-app rewrite (every non-asset path serves `index.html`, so `/discover`, `/create`, `/test/:id`, `/dashboard` and unknown URLs work on a hard refresh) and basic security headers. Hashed files in `/assets` are cached immutably; a missing asset is a real 404. `public/_headers` is a Cloudflare file and is ignored by Vercel.

**Environment variables** live in the Vercel project (Settings → Environment Variables), never in the repo. All three are public by design and are inlined at build time, so changing one needs a **redeploy**:

| Name | Value | Required |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` | yes |
| `VITE_SUPABASE_ANON_KEY` | the publishable (anon) key — never a secret/service_role key; the build fails if one is found | yes |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile **site** key | later; leave unset until the widget exists |

**Deploy from this checkout (no GitHub integration needed):** `npx vercel login`, `npx vercel link`, add the variables above, `npx vercel deploy` (preview), then `npx vercel deploy --prod`. `.vercel/` (project ids, pulled env) is git-ignored and `.vercelignore` keeps `.env*`, `supabase/`, `tests/` and notes out of the upload. Node: any of 20–24 works (tested on 20 and 24); pick 24.x in Project Settings.

**Order for Turnstile:** deploy without the site key (CAPTCHA off in Supabase) and test → create the Turnstile widget for the final hostname → add `VITE_TURNSTILE_SITE_KEY` → redeploy and test → only then enable CAPTCHA in Supabase.

## Growth: referral links and sharing

Every identity has a public **invite link** `https://<site>/?ref=<code>` (12-char random code). It is shown right after a founder requests a test and right after they earn a credit, and on the Dashboard.

| Rule | Detail |
|---|---|
| The reason to invite | When a friend joins through your link and **finishes their first real test**, you earn **+1 Test Credit** (= one free test of your own product). The friend still gets the normal starter credit. The card says this in plain words — it is never a hidden incentive. |
| Cap | 3 rewarded referrals per referrer, counted from the permanent ledger — deleting invitees later never re-opens the cap. |
| Idempotent | One referral per invitee, one reward per invitee (primary key + unique ledger index); payment is a separate idempotent settlement run on page loads (like expiry refunds), not inside `submit_test`. |
| Which test counts | The invitee's test must be on **someone else's** campaign, never the referrer's own (otherwise the referrer could time the invitee's test against the feedback they receive and unmask the tester, and an alt identity could "complete" its owner's campaign to harvest credits). |
| Who can be referred | Only brand-new participants: refused after the first earned reward, self-referral and mutual referral refused; the first link a visitor opens wins. |
| Privacy | The referrer sees only counts (invited / finished a first test / rewarded). Invitee identities are never exposed (the ledger's `referee_id` column is not granted to clients). |
| Results card | "Share your results" on the Dashboard is built **in the browser** from the founder's own results: number of tests, how many completed the task, average rating. A quote appears only if that tester ticked *allow public quoting*; private feedback and tester identities are never included; nothing is published until the founder posts it. No public endpoint exists. |

**Honest limits:** anonymous identities can't prove they are different people. A determined person can create friends-of-themselves, but each fake invitee must pass the human check (when Turnstile is on), reserve a task, wait 60 s and complete a *real* test of another founder's product (which is real value to that founder), and each referrer is capped at 3 rewards. This raises the cost; it does not make farming impossible. The cap of 3 shapes the referral tree, it is **not** an anti-abuse control: every extra identity mints a starter credit and (as an invitee) one referral credit for its parent, so a person with many identities earns roughly twice per identity. The brakes are Turnstile + Supabase's per-IP sign-in limits, the 60 s minimum and the one-live-reservation rule. Other people's codes cannot be probed: `claim_referral` answers caller-state questions first and gives an unknown-code answer for mutual links, so a code is only ever confirmed by a successful claim (which uses up that identity's single claim).

## Cloudflare Turnstile (human check on first sign-in)

Anonymous sign-in is the only place identities are created, so it is the place for the check. New visitors pass an (invisible unless needed) Cloudflare Turnstile challenge before their anonymous account is created; returning browsers already have a session and are never challenged.

1. Cloudflare dashboard → Turnstile → add a widget for your deployed hostname (plus `localhost` for development). You get a **site key** (public) and a **secret**.
2. Put the **site key** in `VITE_TURNSTILE_SITE_KEY` (`.env.local` for dev, the committed `.env.production` for the deploy). It is public by design. For local development Cloudflare publishes an always-pass test key: `1x00000000000000000000AA`.
3. Deploy the frontend, **then** enable it server-side: Supabase dashboard → Authentication → Attack Protection → *Enable CAPTCHA protection* → Turnstile → paste the **secret** there. The secret never goes into this repo or the browser bundle.

**Order matters:** if Supabase CAPTCHA is switched on before the compatible frontend is live, every new visitor's anonymous sign-in fails. With no site key set the app behaves exactly as before.

## Tests

| Command | What it proves |
|---|---|
| `npm run test:db` | Real Postgres (PGlite) with the **real migration files**: security/atomicity of the MVP core (`run.mjs`), Phase 1 lifecycle with simulated time (`lifecycle.mjs`), and a rehearsal of the production upgrade on a populated database with *exposure disabled + auto-RLS* (`upgrade.mjs`). Mutation-tested: 25 of 26 deliberately broken migrations are caught (the 26th, a lock-skip that prevents a deadlock, is only observable under real concurrency). |
| `npm run test:browser` | Builds the app and drives **real Chrome** against a *stubbed* Supabase API (fresh incognito-like contexts): UI wiring, request payloads, timers, error states, mobile layout. Does **not** test the database. |
| `tests/live/live-e2e.mjs` | The real project: real anonymous auth, PostgREST, RLS, and genuinely parallel requests. Guarded by `PEERPROBE_LIVE_TESTS=1`. |
| `tests/live/referral-e2e.mjs` | Same for referrals (needs migration 5): parallel claims, six concurrent settlers racing for one referrer's cap of 3, anonymity, invariants. |
| `supabase/tests/referrals.mjs` | Referral rules in real Postgres: claim rules, first-test-only, idempotent + capped rewards, privileges, invariants; mutation-tested (17/17 broken migrations caught). |

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
- **Junk feedback is limited, not prevented (Phase 1 mitigation).** One identity can now earn at most 5 credits per rolling 24 h, must hold a reservation, and must wait 60 s — but `submit_test` still only checks text length (≥10 chars, whitespace-only rejected), the 60 s is elapsed time not proven engagement, and a founder still cannot dispute/reject feedback or claw back the credit. Many identities multiply all of this (see the first bullet); Cloudflare Turnstile on anonymous sign-in is the planned brake.
- **Reservation griefing by many identities.** A reservation hides a task from other testers for up to 15 minutes and blocks the founder's Cancel, and the holder never has to submit. One identity can hold only one task at a time (3 reservations per task), so the effect of a single identity is small, but a script minting many anonymous identities could keep many tasks reserved. Nothing is ever permanently blocked (it all lapses by time), and the only throttle today is Supabase's anonymous-sign-in rate limit; Turnstile is the planned fix.
- **Settlement is lazy.** There is no scheduler: expired campaigns are refunded when *anyone* loads Discover or Dashboard (up to 25 per call). Until then they are already invisible to testers, but a founder's balance is only restored on the next page load by anyone.
- **Deleting anonymous identities deletes their feedback** (pre-existing `ON DELETE CASCADE` from `auth.users`). No code does this, but do not purge anonymous users in the Supabase dashboard without exporting feedback first.
- **No CSP** in `public/_headers` (React escapes all user text and nothing uses `dangerouslySetInnerHTML`, so this is defence in depth). Add one once the Supabase URL is known.
- **Hosts are only syntactically validated:** names like `foo.localhost` or `127.0.0.1.nip.io` pass; testers are warned that sites are unvetted, but there is no reporting/blocklist. The URL is only ever opened in the tester's own browser (no server-side fetch).
- **Two tabs opened simultaneously on a first visit** can each create an anonymous identity (one unused credit is orphaned).
- **Slow failure when a returning user is offline:** supabase-js retries the token refresh for ~50 s before the retryable error appears. The identity is preserved (verified), only the wait is poor.
- **Credits are tied to one browser.** Clearing site data = new identity = lost credits. An optional (never mandatory) "save my identity" via Supabase identity linking is a possible later feature.
- **One-response campaigns:** the task is now exclusive to one reserved tester at a time, so two testers no longer race. If a reservation lapses, the typed answers stay on the device (sessionStorage) and the tester can re-reserve (if nobody else took it) and submit immediately.
- Feedback quality is only length-validated (≥10 characters per text answer).
- The React UI tests (`npm run test:browser`) run against a stubbed API, so they verify the client, not the database; the database is verified by `npm run test:db` and `tests/live/live-e2e.mjs`.

## Repository layout

```
src/                    React app (pages/, components/, lib/, context/)
supabase/migrations/    Schema, RLS, RPC functions (apply in filename order)
supabase/tests/         PGlite-based SQL test-suites (isolated package; not part of the app build)
tests/browser/          Real-Chrome tests of the built app against a stubbed API (isolated package)
tests/live/             Real-project end-to-end test (guarded; needs migration 4 applied)
public/_headers         Security headers + no-store (mirrors what the CI would add)
.env.example            Public Supabase settings template
.github/workflows/      Managed centrally by HackOnVibe — do not edit
```
