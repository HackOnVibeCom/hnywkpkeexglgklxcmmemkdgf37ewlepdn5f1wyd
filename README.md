# UXBarter — Give feedback. Get feedback.

**UXBarter is a credit-based, peer-to-peer usability-testing exchange.** Founders and developers earn a Test Credit by doing a short, structured test of someone else's product, and spend a credit to get their own product tested by real people.

**Live: <https://uxbarter.vercel.app>** (the original hostname <https://peerprobe.vercel.app> serves the same deployment — see [Naming](#naming)).
Built for **HackOnVibe**. No registration, email, password or OAuth — ever.

## The problem

Early-stage founders ship without ever watching a stranger use their product. Paid user-testing panels cost more than a pre-revenue team can spend, and asking friends gives polite, biased answers. What founders *do* have is the same need as every other founder: a few minutes of honest attention from someone who is not them.

## The idea: a barter, not a marketplace

| | |
|---|---|
| **Request a test** | Paste a public website URL and one specific task ("find the pricing and tell me what you'd pay"). Costs **1 Test Credit**. |
| **Take a test** | Reserve someone else's task, do it in 2–3 minutes, submit structured feedback: *did you complete the task, where was the friction, what would you change, 1–5 UX rating*. Earns **1 Test Credit**. |
| **Read the results** | The founder's dashboard shows the real feedback. Testers stay anonymous. |
| **Start** | Every new anonymous visitor gets exactly **one starter credit**, enough to request a first test immediately. |

Because a credit is only earned by testing, supply and demand grow together: every request needs a second founder, and every founder who tested has a credit to spend.

## Zero-CAC growth mechanism

UXBarter has no ad spend and no paid acquisition channel. Growth is built into the product loop:

1. **A request needs a tester.** A founder who just posted a task has an immediate, concrete reason to bring in another founder.
2. **Referral links with a plain, capped reward.** Every identity has an invite link (`?ref=<code>`). When an invited friend **completes their first qualifying test**, the referrer earns **+1 Test Credit** (= one free test of their own product), settled automatically in the same database transaction as the completion. Capped at **3 rewarded referrals per referrer**; one reward per invitee; never for sign-up alone; never self-referral. The invitee still gets the normal starter credit, and the reward is stated in plain words on the invite card — never hidden.
3. **Share at the moment of value:** prompts after requesting a test and after earning a credit, plus a **results card** built in the browser from the founder's own results (counts, completion rate, average rating; a quote only if the tester allowed it).

These are *mechanisms, not results*: this repository and the site contain no traction, revenue, conversion or testimonial claims, and none should be added until they are real and measured.

## The two-sided journey

```
Founder (needs feedback)                        Tester (earns credits)
────────────────────────                        ──────────────────────
Land → silent anonymous sign-in (1 credit)      Land → silent anonymous sign-in (1 credit)
Request a test (−1)  [Open or Targeted]         Profile: pick categories, answer 4 short questions
        │                                       Discover → "Recommended for you" / "Browse all eligible tests"
        │                                       Reserve a task (15 min hold, URL revealed only to you)
        │                                       Test it ≥ 60 s, submit structured feedback  → +1 credit
Dashboard: read feedback, share results card ◄──┘
Invite a friend → +1 credit when they finish their first test
```

## Matching: who should test what

* **Open testing (default)** — anyone eligible can take the task; categories are only a *recommendation*.
* **Targeted testing** — the founder requires at least one of five tester categories: *Tech-Savvy Users, Founders & Product Builders, Business & Office Users, Students & Learners, Everyday & Non-Technical Users*. Eligibility is enforced **in PostgreSQL** (a trigger on reservations); the UI only explains why a task is or isn't available. A task that isn't available to you is never hidden — you see who it is for and what to do.
* **Experience profile.** A tester answers **four short, open-ended questions** for each category they choose (stored owner-only, 15–800 characters each, deletable at any time). **General** categories (Students & Learners, Everyday & Non-Technical) become *active* on valid answers. **Professional** categories (Tech-Savvy, Founders & Product Builders, Business & Office) stay *pending* until a server-side assessment decision exists — no timeout, default or manual shortcut approves them. Completing one category is required before reserving any task; browsing and requesting tests never need a profile.
* **Honest wording.** Everything is self-reported. The product never says "verified" and never asks for credentials.

## AI assessment and matching

Two features, both **opt-in**, both server-side:

1. **Recommendations** — Discover's *Recommended for you* tab shows only tasks the database already says the tester can take **and** the model judges relevant to the tester's own words, each with a plain reason and the evidence it relied on. An honest empty state is a valid answer. *Browse all eligible tests* is always available and independent of AI.
2. **Professional assessment** — for the three professional categories the model reads the four answers and *proposes* an outcome; **code decides** (verbatim-evidence checks across different answers, thin/instruction-like text rejected before any model call). Outcomes: qualified, not qualified yet, or *needs clarification* (nothing recorded). Failure always means "pending", never approval.

**AI recommends and proposes. The database authorizes.** The model can never reserve a task, move credits, or activate a category: the only write path is a `service_role`-only RPC bound to the exact answers assessed (stale decisions are refused).

Safety and privacy controls: explicit consent card (off by default; withdrawal stops processing immediately); an OpenAI key held only as a Supabase Edge Function secret (never in the browser or repo); an opaque `subject_ref` instead of any account id; an erasure-event log plus a scheduled sweep that deletes derived data after consent withdrawal or answer deletion; per-user and global daily call/token caps reserved *before* spend; kill switches (`AI_MATCHING_ENABLED`, `AI_ASSESSMENT_ENABLED`, the `VITE_AI_MATCHING` UI flag). Details: [docs/AI_MATCHING.md](docs/AI_MATCHING.md), [docs/AI_INTEGRATION_CONTRACT.md](docs/AI_INTEGRATION_CONTRACT.md). The production activation record and evidence are in [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md) §12–13.

## Credit and anti-abuse rules

| Rule | Value |
|---|---|
| Starter credit | 1 per anonymous identity (unique partial index) |
| Campaign lifetime | 7 days, then expired and the credit refunded (only if it received no feedback) |
| Reservation | 15 minutes, hides the task from others, reveals the URL only to the holder |
| Minimum testing time | ≥ 60 s before feedback is accepted |
| Reward cap | 5 rewarded tests per identity per rolling 24 h |
| Cancel | Founder can cancel an unanswered task → refund exactly once; feedback is never deleted |
| Human check | Cloudflare Turnstile on first sign-in, enforced server-side by Supabase CAPTCHA |

Every credit movement is a row in an append-only ledger with unique indexes, so double-spend and double-reward are impossible even if application code regresses.

## Future Monetization & Business Model

**Today:** UXBarter runs a pure peer-to-peer credit economy. Users earn credits by testing other people's products and through qualifying referrals, and spend them to get their own product tested. There is **no payment flow in the product**: nothing can be bought, and no one is charged.

**Planned (not implemented):** two *optional* paid channels for people who want feedback without testing other products first:

1. **Pay-as-you-go credit purchases** — buy testing credits directly, for founders who need usability feedback but don't have time to test other products.
2. **Subscription plans** — recurring plans with a fixed monthly allocation of testing credits, for founders and teams who need regular usability testing.

**How this fits the model**

* **The peer-to-peer exchange stays the foundation.** Testing and qualifying referrals are what drive UXBarter's [Zero-CAC](#zero-cac-growth-mechanism) organic acquisition. Paid options are an added convenience, never a requirement: the free, earn-by-testing path remains fully usable.
* **Zero-CAC is a growth strategy, not a claim of zero cost.** It means UXBarter does not pay for customer acquisition (no ads or paid channels). Operating the service (hosting, database, AI usage) has real costs, and subscriptions and credit purchases are the planned way to fund them.
* **No details are committed yet.** This repository does not state pricing, credit quantities, launch dates, revenue, conversion rates or traction, and none should be added until they are real and measured.

## Technology

| Layer | Choice |
|---|---|
| Frontend | Vite + React 19 + TypeScript + Tailwind CSS 4 + React Router (static SPA, no SSR) |
| Hosting | Vercel (`vercel.json`: build, SPA rewrite, security headers, CSP) |
| Backend | Supabase: Postgres, Anonymous Auth, Row Level Security, `SECURITY DEFINER` RPCs with an empty `search_path` |
| AI | Supabase Edge Function `ai-match` (Deno) calling OpenAI with a server-side key |
| Human check | Cloudflare Turnstile + Supabase CAPTCHA |
| Tests | Real-Postgres suites (PGlite running the real migrations), Playwright + real Chrome, Node unit tests |

Security model in one line: browsers have **read-only** RLS access to their own rows; **every write goes through an RPC** that uses `auth.uid()`; testers stay anonymous to founders (`tester_id` is not column-granted); private answers and AI data are unreachable by any client role. Details: [supabase/README.md](supabase/README.md), [docs/ENGINEERING_NOTES.md](docs/ENGINEERING_NOTES.md).

## Run it locally

Requires Node 20+.

```bash
cp .env.example .env.local     # fill in the public values below
npm ci
npm run dev                    # http://localhost:5173
```

### Environment variables (names only — never commit values)

| Variable | Where | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | frontend (public) | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | frontend (public) | the anon/publishable key only; the app refuses to start with a secret/`service_role` key |
| `VITE_TURNSTILE_SITE_KEY` | frontend (public, optional) | Cloudflare Turnstile **site** key; Cloudflare publishes an always-pass test key for local use |
| `VITE_AI_MATCHING` | frontend build flag (optional) | `1` shows the AI interface; unset = hidden |
| `OPENAI_API_KEY` | **Supabase Edge Function secret only** | never in the browser, `.env*` or repo |
| `AI_MATCHING_ENABLED`, `AI_ASSESSMENT_ENABLED` | Edge Function secrets | literal `true` enables; anything else is off |
| `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `AI_USER_DAILY_CALLS`, `AI_GLOBAL_DAILY_CALLS`, `AI_GLOBAL_DAILY_TOKENS`, `AI_MIN_RUN_INTERVAL_SECONDS`, `AI_ALLOWED_ORIGINS` | Edge Function secrets (optional) | model and budget tuning |

To run your own backend: create a Supabase project, enable **anonymous sign-ins**, apply `supabase/migrations/*.sql` in filename order (`supabase db push`), and set the variables above. Full setup, Turnstile ordering and troubleshooting: [docs/ENGINEERING_NOTES.md](docs/ENGINEERING_NOTES.md). Deploy and rollback procedures: [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md).

## Tests

```bash
npm run typecheck && npm run build   # TypeScript + production build
npm run test:unit                    # pure helpers (Node)
npm run test:db                      # real Postgres (PGlite) against the real migrations: credits, lifecycle,
                                     #   referrals, matching, experience profile, AI matching, upgrade rehearsal
npm run test:browser                 # real Chrome against a stubbed API: UI wiring, states, 360 px layout
node tests/browser/csp-check.mjs     # enforces the Content-Security-Policy from vercel.json
```

Scripts named `prod-*` and everything in `tests/live/` talk to the **real** project, write test data and need a human for the Turnstile check; they are opt-in and never run in CI.

## Repository layout

```
src/                    React app (pages/, components/, components/ai/, lib/, context/)
supabase/migrations/    11 forward-only migrations (schema, RLS, RPCs, lifecycle, referrals, matching,
                        experience profile, AI matching, consent clean-up, referral settlement)
supabase/functions/     Edge Function ai-match + shared AI-matching modules
supabase/tests/         PGlite SQL suites (isolated package)
tests/                  browser/ (Playwright), unit/, deno/, live/ (opt-in, real project)
docs/                   AI contract, rollout/rollback plans, release runbook, verification and rollback SQL
scripts/                Social-card generator, AI smoke test, production secret helpers
vercel.json             Vercel build, rewrite, headers, CSP
.github/workflows/      Managed by HackOnVibe — not edited
```

## Known limitations (honest list)

* **Anonymous identities cannot prove they are different people.** One person can mint several identities; limits are per identity. The brakes are Turnstile, Supabase's per-IP sign-in limits, the 60 s minimum, the daily reward cap and the 3-referral cap — they raise the cost of farming, they do not make it impossible.
* **Credits are tied to one browser.** Clearing site data creates a new identity.
* **Experience is self-reported.** Assessment judges plausibility of the tester's own words; nothing is verified.
* **Feedback quality is length-validated only** (≥ 10 characters per text answer).
* Targeted tasks for professional categories can only be taken by testers whose assessment is qualified, so on a small marketplace they may wait out the 7 days and refund.
* Full list: [docs/ENGINEERING_NOTES.md](docs/ENGINEERING_NOTES.md#known-limitations-honest-list).

## Naming

The product was renamed from PeerProbe to **UXBarter** just before submission. Infrastructure identifiers deliberately keep the old name so that nothing live breaks: the Vercel project `peerprobe`, the secondary host `peerprobe.vercel.app` (still in the Turnstile widget), the Supabase project, the `PEERPROBE_*` test switches and `pp:*` storage keys. User-facing text always says **UXBarter**.
