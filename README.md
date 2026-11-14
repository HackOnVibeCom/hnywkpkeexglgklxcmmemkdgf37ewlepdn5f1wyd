# PeerProbe

**Peer-to-peer human usability testing exchange.** Founders swap 2–3 minute tests of each other's products:

1. A founder submits a public website URL and one specific task (costs **1 Test Credit**).
2. Another founder opens the site, does the task, and submits structured feedback (task completed? friction, suggested improvement, 1–5 UX rating).
3. The tester earns **1 Test Credit** for each valid, unique completed test.
4. Every new anonymous user gets exactly **one starter credit**.
5. Founders read the real feedback on their dashboard.

**No registration, email, password or OAuth — ever.** Identity is a Supabase *Anonymous Auth* user created silently on first visit.

> Built for HackOnVibe. **Live site: <https://peerprobe.vercel.app>** — a static Vite build on Vercel, backend on Supabase, human check by Cloudflare Turnstile (see [Hosting on Vercel](#hosting-on-vercel-public-site)).

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 19 + TypeScript + Tailwind CSS 4 + React Router |
| Hosting | Vercel (static `dist/`, configured in `vercel.json`). The HackOnVibe GitHub Actions workflow (Cloudflare Pages) is **not modified**; it needs an organisation token this repository does not have, so it skips its deploy steps. |
| Backend | Supabase: Postgres, Anonymous Auth, Row Level Security, SQL RPC functions |
| Human check | Cloudflare Turnstile on the first anonymous sign-in, enforced server-side by Supabase CAPTCHA protection |
| AI summaries | *Not built yet.* Planned as a Supabase Edge Function with a server-side key (never in the browser) |

No SSR, Node server, WebRTC or PeerJS.

## Status — read this first

| Area | State |
|---|---|
| Database schema, RLS, atomic RPCs (migrations 1–5) | **Applied to the production Supabase project and verified** with real-project scripts: 57 + 44 checks (true parallel races, one reward / refund per event, credit conservation) and a 19-check expiry/lapse run. |
| **Phase 1: campaign lifecycle + anti-abuse** | Live (migration 4): 7-day expiry, 15-minute reservations, 60-second minimum testing time, 5 rewarded tests per rolling 24 h, founder cancel, refund exactly once, feedback never deleted. |
| **Phase 2: referrals, sharing, Turnstile** | Live (migration 5 + frontend): referral links (3 rewarded referrals max), invite cards, a results card built in the browser, and Cloudflare Turnstile with Supabase CAPTCHA **enforced** (sign-ups without a valid token are rejected with HTTP 400). |
| Automated tests | `npm run test:db` (PGlite: 119 core + 118 lifecycle + 91 referral + 31 upgrade-rehearsal assertions), `npm run test:browser` (real Chrome, stubbed API: 58 + 77 + 62 checks), `tests/browser/csp-check.mjs` (CSP policy under real Chrome). Real-project scripts in `tests/live/` are opt-in and, with CAPTCHA now enforced, need a token path (e.g. a temporary CAPTCHA pause). |
| 5 screens (landing, discover, create, test, dashboard) | Implemented and typechecked; layouts checked at 360, 390, 768 and 1280 px. |
| Deployed site | <https://peerprobe.vercel.app> (Vercel Production). Security headers are set in `vercel.json`; a Content-Security-Policy is configured in **Report-Only** mode (see [Known limitations](#known-limitations-honest-list)). |
| AI summary of recurring problems | Not implemented (dashboard says so). |
| Public proof pages | Not built, by design: the results card is generated in the browser and shared by the founder; there is no public endpoint. |

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
5. **Human check and sign-in hygiene (done for the live project).** Enable Cloudflare Turnstile and Supabase CAPTCHA in the order described under [Cloudflare Turnstile](#cloudflare-turnstile-human-check-on-first-sign-in). Turn **off** every sign-in provider except anonymous (*Authentication → Sign In / Providers → Email = off*) and set *Authentication → URL Configuration → Site URL* to your deployed address.

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

> Migrations 1–5 are already applied to the production project. This is the procedure that was followed; keep it for fresh projects.

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
2. Put the **site key** in `VITE_TURNSTILE_SITE_KEY` (`.env.local` for dev, a Vercel project environment variable for the deploy). It is public by design. For local development Cloudflare publishes an always-pass test key: `1x00000000000000000000AA`.
3. Deploy the frontend (the widget's allowed hostnames must include the deployed host; Vercel preview URLs are not allowed, so keep the variable Production-only), **then** enable it server-side: Supabase dashboard → Authentication → Attack Protection → *Enable CAPTCHA protection* → Turnstile → paste the **secret** there. The secret never goes into this repo or the browser bundle.

**Troubleshooting (what the visitor and you will see).** The app shows Cloudflare's code in the error message.
- `600010` (the `600*` family, Cloudflare: "generic challenge failure — bot behavior detected"): Cloudflare itself refused this browser session. It is not a site/hostname/key error (those are 110xxx/400xxx and fail before any click) and not our CSP. The app retries twice with `turnstile.reset()`, then shows the code and a *Try again* button. Typical causes: private windows, VPN/proxy, privacy extensions or hardened browsers, no GPU/WebGL, automated browsers. Cloudflare's own always-fail test key `2x00000000000000000000AB` produces exactly this code, and its always-pass key `1x00000000000000000000AA` signs in through the same code path.
- `110200` hostname not allowed / `110100`, `110110` bad sitekey / `400*` key problems: configuration; never retried; the message says it is a site problem. Fix in Cloudflare → Turnstile → the widget → Hostname Management.
- `CSP violation ... Connecting to 'data:,'` in the console comes from the *challenge frame's own* policy on challenges.cloudflare.com and is harmless. This site sends **no** Content-Security-Policy. If you add one later, allow `https://challenges.cloudflare.com` in `script-src`, `frame-src` and `connect-src`; do not try to silence those `data:,` messages.
- The Cloudflare dashboard (Turnstile → widget → Analytics) shows solve/fail counts and is the place to check whether real visitors are being failed.

**Order matters:** if Supabase CAPTCHA is switched on before the compatible frontend is live, every new visitor's anonymous sign-in fails. With no site key set the app behaves exactly as before.

## Tests

| Command | What it proves |
|---|---|
| `npm run test:db` | Real Postgres (PGlite) with the **real migration files**: security/atomicity of the MVP core (`run.mjs`), Phase 1 lifecycle with simulated time (`lifecycle.mjs`), referrals (`referrals.mjs`, incl. deleting paid invitees/referrers), and a rehearsal of the production upgrade on a populated database with *exposure disabled + auto-RLS* (`upgrade.mjs`). Mutation-tested: every deliberately broken migration is caught except one (the profile `SKIP LOCKED` detail, only observable under real concurrency). |
| `npm run test:browser` | Builds the app and drives **real Chrome** against a *stubbed* Supabase API (fresh incognito-like contexts): UI wiring, request payloads, timers, error states, mobile layout. Does **not** test the database. |
| `tests/live/live-e2e.mjs` | The real project: real anonymous auth, PostgREST, RLS, and genuinely parallel requests. Guarded by `PEERPROBE_LIVE_TESTS=1`. With Supabase CAPTCHA enforced it needs a token path (e.g. a temporary, approved CAPTCHA pause). |
| `tests/live/referral-e2e.mjs` | Same for referrals (needs migration 5): parallel claims, six concurrent settlers racing for one referrer's cap of 3, anonymity, invariants. |
| `supabase/tests/referrals.mjs` | Referral rules in real Postgres: claim rules, own-campaign tests never qualify, idempotent + capped rewards (cap survives deleting invitees), no starvation by unpayable rows, privileges, invariants; mutation-tested (26/26 broken migrations caught). |
| `node tests/browser/csp-check.mjs` | Builds the app, serves it with the Content-Security-Policy taken from `vercel.json` **enforced**, and drives sign-in, Dashboard (results card), Create and Test pages in real Chrome: fails on any violation raised by our own page. Run it before tightening the policy. |

## Deployment

**Canonical:** Vercel — see [Hosting on Vercel](#hosting-on-vercel-public-site). Deployments are made from a checkout with the Vercel CLI; no GitHub integration is required.

**HackOnVibe workflow (unchanged, do not edit):** `.github/workflows/deploy.yml` runs on every push to `main` and on manual dispatch. It only deploys to Cloudflare Pages when the organisation secret `CLOUDFLARE_API_TOKEN` is available to this repository; without it the job turns green but **skips the build and deploy steps**. If the organisers enable it, that build has no `VITE_*` variables and would show "Backend not configured" (and the Turnstile widget only allows the Vercel hostname), so the Cloudflare address is **not** the product URL. Point judges and users at the Vercel URL.

**Pushing to `main` does not deploy the Vercel site**; production is updated deliberately with `npx vercel deploy --prod`.

## Security model (summary — details in [supabase/README.md](supabase/README.md))

- Browsers have **read-only** table access via RLS (own rows only). **All writes go through `SECURITY DEFINER` RPCs** that use `auth.uid()`; the `anon` role has no access.
- Starter credit: `INSERT … ON CONFLICT DO NOTHING` + a unique partial index → exactly once per identity.
- Spend / reward: row locks (`FOR UPDATE`) + ledger inserts + balance update in one transaction; unique indexes make double-spend/double-reward impossible even if code regresses.
- Self-testing blocked in the RPC **and** by a trigger. One submission per tester per campaign (unique constraint). One-response campaigns: the first valid submission closes it.
- Testers stay anonymous to founders (`tester_id` is not column-granted). Feedback is private unless the tester ticks the optional sharing box; nothing in the MVP exposes feedback publicly.
- URLs are validated (public http(s) host only; no localhost/IPs/credentials/`javascript:`), rendered with `rel="noopener noreferrer"`; user text is rendered as text, never HTML.
- Sign-in is anonymous only (Email, phone and OAuth providers are off). Cloudflare Turnstile + Supabase CAPTCHA gate identity creation: a sign-up without a valid token is refused with HTTP 400. Every function is `SECURITY DEFINER` with an empty `search_path` and is callable only by signed-in users; the anonymous role can run none of them.

## Known limitations (honest list)

- **Anonymous identity does not prevent multi-account abuse.** One person can clear storage / open incognito windows to mint unlimited starter credits and farm rewards by testing their own products from another identity. The constraints are per-identity only. Mitigations to add: CAPTCHA on anonymous sign-in (above), per-IP/rate limits, minimum time-on-task enforced server-side, a quality/flagging step before crediting, reputation.
- **Junk feedback is limited, not prevented (Phase 1 mitigation).** One identity can now earn at most 5 credits per rolling 24 h, must hold a reservation, and must wait 60 s — but `submit_test` still only checks text length (≥10 chars, whitespace-only rejected), the 60 s is elapsed time not proven engagement, and a founder still cannot dispute/reject feedback or claw back the credit. Many identities multiply all of this (see the first bullet); Cloudflare Turnstile on anonymous sign-in is the planned brake.
- **Reservation griefing by many identities.** A reservation hides a task from other testers for up to 15 minutes and blocks the founder's Cancel, and the holder never has to submit. One identity can hold only one task at a time (3 reservations per task), so the effect of a single identity is small, but a script minting many anonymous identities could keep many tasks reserved. Nothing is ever permanently blocked (it all lapses by time), and the only throttle today is Supabase's anonymous-sign-in rate limit; Turnstile is the planned fix.
- **Settlement is lazy.** There is no scheduler: expired campaigns are refunded when *anyone* loads Discover or Dashboard (up to 25 per call). Until then they are already invisible to testers, but a founder's balance is only restored on the next page load by anyone.
- **Deleting anonymous identities deletes their feedback** (pre-existing `ON DELETE CASCADE` from `auth.users`). No code does this, but do not purge anonymous users in the Supabase dashboard without exporting feedback first.
- **CSP is Report-Only.** `vercel.json` sends `Content-Security-Policy-Report-Only` (self + Cloudflare Turnstile + this Supabase project; no inline scripts; frames denied). Violations show in the browser console; there is no collection endpoint. Enforce it only after the policy has been observed on the real Turnstile widget. Expected, harmless console noise: Cloudflare's own challenge frame reports `data:,` violations of *its* policy.
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
tests/live/             Real-project end-to-end scripts (guarded by PEERPROBE_LIVE_TESTS=1; they write test data)
public/_headers         Cloudflare-style headers (inert on Vercel; kept for the HackOnVibe path)
vercel.json             Vercel build, SPA rewrite, security headers, CSP (Report-Only)
.vercelignore           Files the Vercel CLI never uploads
.env.example            Public Supabase settings template
.github/workflows/      Managed centrally by HackOnVibe — do not edit
```
