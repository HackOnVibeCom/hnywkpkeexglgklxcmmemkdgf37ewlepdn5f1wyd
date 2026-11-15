# UXBarter

**UXBarter — Give feedback. Get feedback.** A credit-based, peer-to-peer usability-testing exchange where founders and developers earn credits by testing each other's products, and spend them to get their own product tested. *(Formerly PeerProbe: the Vercel project and URL, the Supabase project and several internal identifiers keep the old name — see [Naming](#naming-uxbarter-vs-peerprobe).)*

How it works — founders swap 2–3 minute tests of each other's products:

1. A founder submits a public website URL and one specific task (costs **1 Test Credit**).
2. Another founder opens the site, does the task, and submits structured feedback (task completed? friction, suggested improvement, 1–5 UX rating).
3. The tester earns **1 Test Credit** for each valid, unique completed test.
4. Every new anonymous user gets exactly **one starter credit**.
5. Founders read the real feedback on their dashboard.

**No registration, email, password or OAuth — ever.** Identity is a Supabase *Anonymous Auth* user created silently on first visit.

> Built for HackOnVibe. **Live site: <https://uxbarter.vercel.app>** (the original hostname <https://peerprobe.vercel.app> still serves the same deployment) — a static Vite build on Vercel, backend on Supabase, human check by Cloudflare Turnstile (see [Hosting on Vercel](#hosting-on-vercel-public-site)).

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
| **Targeted Tester Matching v1** | **Live** (2026-11-15): migration 6 applied to production, UI deployed, merged into `main` (see [below](#targeted-tester-matching-v1)). |
| **Matching v2: Open vs Targeted testing + screening** | Built and tested on branch `feat/matching-v2` (migration 7, **not applied, not deployed** — see [below](#matching-v2-open-vs-targeted-testing-and-screening)). |
| Automated tests | `npm run test:db` (PGlite: 119 core + 118 lifecycle + 91 referral + 31 upgrade-rehearsal assertions), `npm run test:browser` (real Chrome, stubbed API: 58 + 77 + 62 checks), `tests/browser/csp-check.mjs` (CSP policy under real Chrome). Real-project scripts in `tests/live/` are opt-in and, with CAPTCHA now enforced, need a token path (e.g. a temporary CAPTCHA pause). |
| 5 screens (landing, discover, create, test, dashboard) | Implemented and typechecked; layouts checked at 360, 390, 768 and 1280 px. |
| Deployed site | <https://uxbarter.vercel.app> (Vercel Production; the original <https://peerprobe.vercel.app> stays attached as a secondary domain). Security headers are set in `vercel.json`; a Content-Security-Policy is configured in **Report-Only** mode (see [Known limitations](#known-limitations-honest-list)). |
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

**Growth model (zero paid acquisition).** UXBarter has no ad spend and no paid channel. The product is built so that using it brings in more users: every test needs a second founder, a founder who has requested a test has a concrete reason to ask others to join, and the app provides the tools — an invite link with a capped, plainly disclosed reward, share prompts at the moments of value (after requesting a test, after earning a credit), and a results card the founder can post. These are mechanisms, not results: this repository and the site contain **no traction, revenue, conversion or testimonial claims**, and none should be added until they are real and measured.

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

## Targeted Tester Matching (v1)

> **Status: live in production since 2026-11-15** (migration 6 applied and verified, UI deployed, merged into `main` via PR #2). The rollout record and rollback plan are in [docs/TARGETED_MATCHING_ROLLOUT.md](docs/TARGETED_MATCHING_ROLLOUT.md).

Founders can say which kinds of testers they would like; testers can say what kind of tester they are; Discover lists the tasks that fit a tester first. Everything is **optional** and **anonymous** (no email, no password), and it is a **preference, not a gate**: every open task stays available and rewards never depend on matching.

| Piece | How it works |
|---|---|
| Categories | Five fixed categories: Tech-Savvy Users, Founders & Product Builders, Business & Office Users, Students & Learners, Everyday & Non-Technical Users. The allowed ids live in one SQL function (`normalize_tester_categories`) and one TS list (`src/lib/matching.ts`); a test keeps them in sync. |
| Tester profile (`/profile`) | Optional: nickname (2–30), short bio (≤ 280) and any number of categories. Create, correct and remove at any time. **Private**: table `tester_profiles` has RLS on, **no policy and no grant** — it is only reachable through RPCs that touch the caller's own row, so no identity can read another's nickname or bio, and founders never see testers' profiles. |
| Bio suggestions | A button runs a **transparent keyword matcher** over the text the user typed and shows the exact words that triggered each suggestion. It is not AI and never selects anything by itself. Keyword lists contain no protected-attribute terms (age, religion, race, gender, health, disability, politics, family status, nationality …); a unit test enforces that and checks that bios mentioning such things produce no suggestion. Negations such as "not a developer" are handled. |
| Target audience (`/create`) | "Preferred testers (optional)": any of the five categories, stored on the campaign (`campaigns.target_categories`, default empty = anyone). Without a selection the original RPC and payload are used unchanged. With one, `create_targeted_campaign` validates the categories **before any credit moves**, then runs the unchanged `create_project_with_campaign` and stamps the audience — one transaction. |
| Matching (`list_matched_campaigns`) | Plain set intersection, deterministic and explainable. Order: my own live reservation first (as before), then tasks whose audience **overlaps my categories** (more overlapping categories first), then everything else; oldest first within a group, campaign id as the final tiebreak. The ordering is applied **before** `LIMIT 50`, so a recommended task is never cut off. Each recommended card shows "Recommended for you", who the task is for, and *why* (the overlapping categories — computed for the caller only). No profile, no categories, or a task without an audience → exactly the old order and nothing is recommended. |
| Unchanged | Credits, reservations, the 60 s minimum, the 5-per-24 h reward cap, own-campaign blocking, refunds, referral rules, RLS. `start_test` / `submit_test` are not touched, so a tester outside a task's audience can still test it and earns the normal credit. |
| Compatibility | Migration 6 is additive: no existing table is rewritten, no function replaced, no grant or policy changed. The currently deployed UI keeps working after the migration; the new UI degrades to the plain feed (and hides all matching UI) if deployed before the migration. |

**Honest limits.** Categories are **self-declared and unverified** — someone can tick all five. That only changes list order for them, never access or rewards. Tasks show their target categories to every tester (that is the point); nothing about any tester's profile is shown to anyone. Founders do not (yet) see whether a response came from a matching tester — deferred to avoid weakening tester anonymity on small pools.


## Matching v2: Open vs Targeted testing and screening

> **Status: implemented and tested locally on branch `feat/matching-v2`. Migration 7 is NOT applied to production, the UI is NOT deployed, nothing is merged.** Prerequisites, ordered rollout and rollback: [docs/MATCHING_V2_ROLLOUT.md](docs/MATCHING_V2_ROLLOUT.md).

Founders now choose how a request is shared. Matching v1 (above) is unchanged for **open** testing.

| | Open testing (default) | Targeted testing |
|---|---|---|
| Who can take it | Any eligible tester | Only testers who match **at least one** required category (and, for professional categories, have a current screening) |
| Categories | Optional, only a **recommendation** (v1 behaviour) | **Required**, at least one |
| Enforcement | none needed | **PostgreSQL**: a trigger on `test_reservations` refuses the reservation (`not_eligible`, with a reason); the UI only explains |
| Existing campaigns | Every campaign that exists before the migration — including those created with v1 "preferred categories" — **stays open** | Only created through `create_campaign_v2` |

* **Professional categories** (Tech-Savvy Users, Founders & Product Builders, Business & Office Users) need a short **self-reported** experience screening (4 questions each: practical activities, tools, real work). **General categories** (Students & Learners, Everyday & Non-Technical Users) need none.
* **Not eligible ≠ hidden.** A tester can open a targeted task, sees who it is for and exactly why they cannot start it (no profile / profile does not match / screening needed) with a link to fix it. Discover distinguishes **Recommended for you**, **Eligible** and **Not eligible**, ordered in that sequence (all decided by the database).
* **Honest wording.** A completed screening is shown as "Screened — self-reported experience". It is not a verified credential, and answers are not stored (only whether it was completed, for which category and version).
* **Abuse controls.** 3 screening attempts per category per rolling 24 h; malformed submissions never consume an attempt; a new screening version invalidates old passes; editing the profile cannot bypass eligibility (category **and** screening are both required); a profile edit never interrupts a test already in progress (live reservations are not re-checked, and `submit_test` still needs one).
* **Unchanged:** credits, 15-minute reservations, the 60-second minimum, the 5-per-24 h reward cap, referrals, expiry, refunds, anonymous onboarding and CAPTCHA. No AI is involved.


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
| `node tests/browser/brand-check.mjs` | Brand consistency in real Chrome (desktop + 360 px): the old name appears nowhere in visible text, accessible labels, title, share links or the copied results message; Open Graph/Twitter tags, the 1200×630 image and the favicon are consistent. |
| `npm run test:unit` | The keyword suggester and category list (`src/lib/matching.ts`, imported directly by Node): suggestions show their matched words, whole-word matching, negations ("not a developer"), determinism, and that no keyword is a protected/sensitive-attribute term. |
| `supabase/tests/matching.mjs` | Targeted Tester Matching in real Postgres (migration 6): the new objects are not a back door (anon denied, no direct table access, RPC-only writes), profile validation and persistence, target persistence and atomic spending, deterministic ordering and explanations, own-campaign/expired/reserved rules, parity with `list_open_campaigns`, limit-after-ordering, credit conservation; `upgrade.mjs` also rehearses migration 6 on a populated database with default grants disabled. Mutation-tested (22/25 killed, the other 3 are equivalent mutants). |
| `tests/browser/matching-ui.mjs` | The matching UI in real Chrome: profile create / suggest / edit / remove, audience on "Request a test", Discover order + badge + explanation, legacy campaigns, a backend without the migration, anonymity, 360 px layout. |
| `supabase/tests/matching_v2.mjs` | Matching v2 in real Postgres (migration 7): privileges (catalog-checked), all five categories × four tester kinds, "at least one of several categories", screening content / validation / thresholds / attempt limits / versions, profile-change bypass attempts, in-progress protection, the trigger as last line of defence, Discover fit + order + parity with the v0/v1 feeds, credit and reward regression. `upgrade.mjs` also applies migration 7 to a populated database with default grants disabled and proves **no existing function body changed** (md5) and every existing campaign is open. Mutation-tested (33/34 killed; the survivor is equivalent). |
| `tests/browser/matching-v2-ui.mjs` | The Open/Targeted UI in real Chrome: both Create modes and their payloads, Discover Recommended / Eligible / Not eligible, the explanation on the task page, the screening flow, a backend without migration 7, Dashboard, 360 px layout. |

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
- **Targeted Tester Matching is self-declared.** Categories and bios are not verified, and the keyword suggester is a convenience, not a classifier. Matching only re-orders the list; it never restricts who can test or earn.
- **Screening is self-reported, not verification.** Matching v2 asks for hands-on experience, but nobody checks it; the UI never calls it verified. Targeted tasks can only be taken by matching testers, so on a small marketplace they may wait out the 7 days and be refunded.
- **Slow failure when a returning user is offline:** supabase-js retries the token refresh for ~50 s before the retryable error appears. The identity is preserved (verified), only the wait is poor.
- **Credits are tied to one browser.** Clearing site data = new identity = lost credits. An optional (never mandatory) "save my identity" via Supabase identity linking is a possible later feature.
- **One-response campaigns:** the task is now exclusive to one reserved tester at a time, so two testers no longer race. If a reservation lapses, the typed answers stay on the device (sessionStorage) and the tester can re-reserve (if nobody else took it) and submit immediately.
- Feedback quality is only length-validated (≥10 characters per text answer).
- The React UI tests (`npm run test:browser`) run against a stubbed API, so they verify the client, not the database; the database is verified by `npm run test:db` and `tests/live/live-e2e.mjs`.

## Naming: UXBarter vs PeerProbe

The product was renamed from PeerProbe to **UXBarter** just before the HackOnVibe submission. Only user-facing text, metadata, the favicon/logo mark and documentation changed. These identifiers deliberately keep the old name because renaming them would break infrastructure, history or stored data:

| Kept as `peerprobe` | Why |
|---|---|
| Vercel project `peerprobe` and the secondary URL `https://peerprobe.vercel.app` | One project serves both hostnames. The old host stays attached (and in the Turnstile widget) so existing links keep working; `og:url`, `canonical` and the image URLs in `index.html` use the primary `https://uxbarter.vercel.app` |
| GitHub branch `feat/peerprobe-mvp` and the Vercel team slug | Existing remote history and settings |
| Supabase project, tables, RPC names, migration files (including their first-line comments) | Migrations 1–5 are applied to production and must not be edited |
| `PEERPROBE_LIVE_TESTS`, `PEERPROBE_URL`, `PEERPROBE_KEY` environment variables | Internal test switches |
| npm package names (`peerprobe`, `peerprobe-*-tests`), temp-directory prefixes, the `peerprobe-forbid-secret-keys` Vite plugin | Internal ids |
| Browser storage keys `pp:ref`, `pp:draft:*` | Renaming would silently drop visitors' stored invitations and unsent drafts |

Old commits, the project memory history and the deployment notes also keep the old name.

**Domains.** Primary: <https://uxbarter.vercel.app>. Secondary: <https://peerprobe.vercel.app>, the same project and deployment (not a redirect). Both hostnames must be listed in the Cloudflare Turnstile widget, otherwise the widget fails with `110200`. Anonymous sessions and stored invite codes live in browser storage **per hostname**: a visitor who used one host starts a fresh anonymous identity (and a new starting credit) on the other, so do not turn the old host into a redirect after launch without deciding that consciously. The Supabase Auth *Site URL* is not used by anonymous sign-in and is still `https://peerprobe.vercel.app` until it is changed in a separate step. Invite and share links are built from `window.location.origin`, so they carry whichever host the visitor is on.

## Repository layout

```
src/                    React app (pages/, components/, lib/, context/)
supabase/migrations/    Schema, RLS, RPC functions (apply in filename order)
supabase/tests/         PGlite-based SQL test-suites (isolated package; not part of the app build)
tests/browser/          Real-Chrome tests of the built app against a stubbed API (isolated package)
tests/unit/             Node unit tests of the pure matching helpers (src/lib/matching.ts)
docs/                   Rollout / rollback plans (TARGETED_MATCHING_ROLLOUT.md)
docs/verify-migration7.sql  Read-only production verification query for migration 7 (docs/MATCHING_V2_ROLLOUT.md)
tests/live/             Real-project end-to-end scripts (guarded by PEERPROBE_LIVE_TESTS=1; they write test data)
public/_headers         Cloudflare-style headers (inert on Vercel; kept for the HackOnVibe path)
vercel.json             Vercel build, SPA rewrite, security headers, CSP (Report-Only)
.vercelignore           Files the Vercel CLI never uploads
scripts/                make-og-image.mjs regenerates public/og-image.png (the social-share card)
.env.example            Public Supabase settings template
.github/workflows/      Managed centrally by HackOnVibe — do not edit
```
