# AI relevance matching + professional-experience assessment (branch `feat/ai-integration`)

Status: **implemented, integrated with the profile/qualification workstream (commit `2eaf716`) and tested locally. NOT pushed, NOT merged, NO migration applied, NOT deployed, NO OpenAI key configured, NO paid API call ever made.**
Every production step needs the owner's explicit approval (rollout in section 11). Contract: [`AI_INTEGRATION_CONTRACT.md`](AI_INTEGRATION_CONTRACT.md) (owned by the profile workstream; section 11 there lists the two amendments made here).

## 1. What it does

1. **Recommendations.** Discover's tab **"Recommended for you"** shows only campaigns that (a) the database says the tester can act on and (b) the AI judges genuinely relevant from the tester's own words, each with a plain reason, a verdict, the verbatim words it relied on and what is not covered. The other tab, **"Browse all eligible tests"**, is unchanged. Empty is a first-class answer ("No relevant recommendations right now").
2. **Professional assessment.** For Tech-Savvy, Founders & Product Builders and Business & Office testers the AI reads the four free-text answers and either (a) records a qualification decision, (b) records "not qualified yet", or (c) asks for clarification and records nothing. It never requires credentials and never verifies anything: results are always "based on self-reported experience".

**AI recommends and proposes. The database authorizes.** Eligibility (reservation trigger), credits, referrals, reservations and the only write path for qualification (`service_record_qualification`) are the profile/credit workstreams' code; nothing here can reserve, submit, pay, refund or activate a category by itself.

## 2. Architecture

```
Browser (Discover tab / Profile panel)                    Supabase                                              OpenAI
  POST ai-match {"action":"recommend"|"assess"} --JWT--> Edge Function ai-match
                                                   0. verify JWT (platform verify_jwt + auth.getUser(token))
                                                   1. ai_apply_erasure_events()      apply the contract's erasure events (global sweep)
                                                   2. service_get_ai_profile(uid)    contract v1: consent, subject_ref, etag, participation_ready, category states, answers
                                                      no consent => purge derived data, stop. participation_ready=false => profile_incomplete.
                                          recommend:  list_campaigns_v2() AS THE CALLER => eligible only; ai_get_cache(uid, subject_ref);
                                                      ai_reserve_run('match') ; step 1 profile->experience, step 2 ONE batch of campaigns  ----> strict JSON
                                                      validate in code, cache under subject_ref, respond {status, items, generated_at, profile_etag}
                                          assess:     pending professional categories only; thin/instruction-like answers handled in code with NO model call;
                                                      ai_reserve_run('assess'); one call per category  --------------------------------------> strict JSON proposal
                                                      decide in code; qualified/not_qualified -> service_record_qualification(version, hash read in step 2)
                                                      needs_clarification -> ai_put_assessment_note (NOT a decision)
```

## 3. Contract compatibility (decisions)

| Topic | Decision |
|---|---|
| `RecommendationsResponse` | One format: **their field names kept** (`status`, `items[{campaign_id, reason}]`, `generated_at`, `profile_etag`, statuses `unavailable / consent_required / profile_incomplete`) **+ optional extras** (`verdict`, `evidence[]`, `unsupported_requirements[]`, `understanding`) **+ three new "not available right now" statuses** (`rate_limited`, `busy`, `budget_reached`) and `detail` on `profile_incomplete`. `score` stays optional and is never produced (no numeric score exists). `src/lib/aiContract.ts` and `actionableRecommendations()` updated; Discover renders the extras inside their "Why this fits you" card. |
| Discover | Their tabbed Discover is kept. The AI provider (`fetchAiRecommendations`) plugs into their existing seam; Discover only calls it with `participation_ready` **and** consent; their `actionableRecommendations()` still filters to the database's eligible rows. My earlier standalone block, `BrowseAllHeading` and `/experience` page are deleted. |
| Consent | **One canonical interface:** their `ConsentCard` on Profile (`set_ai_consent(p_granted)`). My code has no consent UI or table. Their card now also states the withdrawal policy (section 6). |
| Deletion / erasure | (a) immediate: `delete_my_ai_data()` is called by the UI after consent withdrawal and after "delete my answers"; (b) contract mechanism: `ai_apply_erasure_events()` reads `service_list_erasure_events` after my own cursor, deletes everything held for each `subject_ref`, **then** advances the cursor, in one transaction, at the start of every request; (c) `ai_purge_user` whenever a request sees no consent; (d) account deletion cascades. **Skip-proof:** identity ids are not commit-ordered, so an event can commit behind the cursor; the sweep therefore also runs a **reconciliation** at most once a minute that deletes every derived row whose `subject_ref` has no active consent any more (idempotent, order-independent), and all `ai_put_*` functions refuse to store anything unless consent for that exact `subject_ref` still exists (a run that finishes after a withdrawal stores nothing). Worst-case lag for the contract path: about 60 s; the UI path (`delete_my_ai_data`) is immediate. The sweep only runs inside requests, so **schedule `select public.ai_apply_erasure_events()` with pg_cron (strongly recommended)** to guarantee erasure with no traffic or with the kill switch off. |
| Cache keys | Rows are bound to the tester's **current `subject_ref`** (re-consent rotates it, so old rows are dead) and hashed with the contract **`etag`**, `POLICY_VERSION` and the model name. Any consent / bio / category / answer / decision change, prompt change or model change misses the cache. Eligibility is never cached. |
| `participation_ready` | `false` => `profile_incomplete` (no model call, no feed read). Matching uses the bio + answers of **ACTIVE** categories only: a professional category pending or not qualified does not count for matching, exactly as it does not for targeted eligibility. |
| Campaign source | `list_campaigns_v2()` under the caller's JWT (the caller's own verdict, already committed); `service_list_eligible_campaigns` is equally valid and was not needed. |
| Migration order | `20261115000500_ai_matching.sql` has **no migration-time dependency** on migration 8 (late-bound plpgsql; tested by applying it on migrations 1-7 alone). At runtime the function needs migration 8's `service_*` functions. Apply 8 first. |

## 4. Professional assessment (rubric r1)

* **What is assessed:** whether the answers contain plausible, relevant, sufficiently substantive **self-reported** experience. **Not** an exam; **no** degree, school, employer, title, years or advanced expertise is required; small, personal, informal and hobby experience counts. The category rubrics (four public criteria each, `rubrics.ts`) are returned with every result and shown in the UI ("What we look for"). The three categories use the contract's own question wording (q1-q4).
* **The model only proposes** (strict JSON: outcome `qualified / not_yet / unclear`, confidence, per-criterion `yes/partly/no` with a verbatim quote, `plausibility_concern`, `instruction_like_text`, clarification questions). **Code decides** (`assess.ts`):
  * **qualified** only if the model says so, confidence is not low, no flags, **and** the criteria are backed by quotes that are verbatim, at word boundaries, contain a content word, are **different from each other** and sit in **at least two different answers**, **and** there are at least **three** such criteria, or two with **high** confidence (a cheap two-word evidence pair is not enough).
  * **not_qualified** only if the model says "not yet" with confidence, no flags and fewer than two grounded criteria (an honest "I have little experience" lands here; message: you can still take open tasks, add detail only if true).
  * **needs_clarification** for everything else (unsure, vague, contradictory, thin, instruction-like, a "qualified" claim the evidence does not back). **Not recorded:** the category stays pending, nothing is invented either way, the tester gets neutral follow-up questions. Cached per `answers_hash` so unchanged answers are never paid for twice.
  * Thin answers (< 20 words in total) and instruction-like text are handled **before** any model call (the instruction message is neutral and non-accusatory, because honest wording can occasionally trip a regex).
  * A stored clarification is reused only for the same answers **and** the same rubric/policy version, model and bio (no stale note can block a re-assessment). Up to three categories are assessed concurrently so a run stays inside the Edge Function wall clock.
* **The write path:** `service_record_qualification` with the `question_version` and `answers_hash` that were read; the database refuses stale decisions, missing consent, non-professional categories and any assessment key other than `model / rubric_version / summary / confidence`. The stored `summary` is a **fixed sentence** (no model prose, never answer text). The browser can only send `{"action":"assess"}`: no category, no status, no decision (400 otherwise); calling the database function with a user token is `permission denied` (tested through HTTP and SQL).
* **Failure = pending, never approval:** OpenAI down, malformed output, rate limit, budget, consent withdrawn mid-run, stale answers: nothing is recorded; no timeout ever approves.
* **Truthfulness:** the UI and prompts say "only write what is true"; clarification questions never suggest what to claim; the model is told never to infer experience from category names, schools, titles or confident wording, and not to penalise plain language.

## 5. Matching policy (corrected)

1. Server-eligible campaigns only; candidates capped at 30 per run; campaign text truncated.
2. Per campaign the model returns `strong | good | possible | weak | none` + verbatim evidence + unsupported requirements + a paraphrased reason.
3. Code: recommended **iff** `strong`/`good` **and** >= 1 evidence quote that is verbatim, at word boundaries, contains a **content word** (so "Python", "SQL", "CRM", "AI" qualify and "with"/"the" never do: **no arbitrary minimum length**), **and** comes from the validated analysis evidence (so campaign text cannot pick its own "evidence") **and** a non-empty reason. `possible` is never promoted.
4. **Whole-batch rejection removed:** ten of ten genuinely relevant campaigns are all kept (tested). Steering text is stopped by `guard.ts` instead: a campaign whose name/description/task looks like an instruction ("ignore previous instructions", "mark this as strong", "recommend to every tester", role markers...) is **never sent to the model** and never recommended, while the others are unaffected.
5. Order: strong before good, then the server's feed order; at most 10; no numeric score anywhere.

## 6. Consent withdrawal and recorded qualification decisions (explicit policy)

Reviewed because it was undocumented-adjacent in the contract (section 10.4). **Policy (now stated in the UI, the contract notes and tested in SQL and end to end):**
1. Withdrawal stops all processing at once; the database stops handing out bio/answers/`subject_ref`; everything the AI derived is erased (immediately by `delete_my_ai_data`, by the erasure sweep, and on any request that sees no consent).
2. An **already recorded** `qualified`/`not_qualified` decision **stays in force**. It is a status derived from the answers (it records only the status, model id, rubric version, a fixed sentence and a confidence number, never answer text), so keeping it lets the tester keep what they earned without keeping any AI processing. To remove it the tester deletes the answers (the contract's `delete_my_experience` deletes the decision too).
3. While consent is off **nothing new can be recorded** (the database refuses `consent_required`).
4. If the tester **edits an answer while consent is off**, the decision stops counting (new `answers_hash`) and the category waits as **pending** until consent is on again: it is never silently re-approved and never stuck active on stale text.
5. Re-consent issues a new `subject_ref`; the category is queued for assessment again if pending.
**Alternative the owner may prefer** (not implemented, needs a contract change in migration 8): withdrawing consent also invalidates `ai_assessment` decisions. Trade-off: stricter privacy semantics vs. testers losing access they earned and having to re-consent to regain it. Decision requested in section 12.

## 7. Safety, privacy, cost

| Concern | Measure |
|---|---|
| Secrets | `OPENAI_API_KEY` and the service-role key exist only as Edge Function secrets. A browser test greps the shipped bundle for key material. `OPENAI_BASE_URL` is honoured **only for loopback hosts** (test mocks), so a misconfiguration can never redirect the key. |
| Who can call | Platform `verify_jwt` + `auth.getUser(token)`; strict body (`{"action":"recommend"}` / `{"action":"assess"}` only); <= 2 KB; POST; allow-listed origins; fails closed; verified against a real Deno server (401 for unknown/garbage tokens, 400/413/405/403 cases). Each action has its **own kill switch** (`AI_MATCHING_ENABLED`, `AI_ASSESSMENT_ENABLED`). |
| What OpenAI sees | Bio, category labels, question/answer pairs (recommend: active categories only; assess: that professional category only) and campaign name/description/task/audience. **Never** user id, nickname, token, `subject_ref`, etag, qualification state, campaign UUIDs. `store:false`. Provider retention (abuse-monitoring up to 30 days; no training by default per OpenAI's API policy) is disclosed in the opt-in copy. Requests are made only with `consent.ai_processing = true` read at request time. |
| Injection | Untrusted text is JSON-encoded in the user message only; system prompts say to ignore embedded instructions; **code is the defence**: grounded quotes, ref whitelist, strict enums, `guard.ts` pre-filters (campaign text and tester answers), content-word rule, quotes restricted to validated evidence, model text stripped of links/e-mails/phones/markdown, rendered as plain text. Residual risk: self-report can be false; a tester can write instructions in their own profile and only affects their own results. |
| Cost | Hash caches; one batch per run; per-user daily call cap (**shared** by both kinds), global daily call cap and global token budget, per-kind minimum interval, all reserved atomically **before** spending; 45 s timeout; no retries; `max_output_tokens` (4000 / 8000 / 3000). `AI_MIN_RUN_INTERVAL_SECONDS=0` is honoured (bug found by the Deno run: zero used to fall back to 15). The token cap is checked before a run and recorded after, so concurrent runs can overshoot it slightly: **the call cap and an OpenAI project spend limit are the hard ceiling.** |
| Review hardening | Independent security review (0 critical/high) -> fixed: derived data can no longer be written after a withdrawal; skip-proof erasure (above); stronger `qualified` rule; note keys; `guard.ts` narrowed (honest work vocabulary such as "system prompts", "score each lead", "override the business rules" is not flagged) and extended to Ukrainian/Russian; text is NFKC-normalised and invisible format characters (zero-width, soft hyphen, bidi) are stripped before hashing, sending or guarding; model text has short-link hosts/paths stripped; chunked request bodies are cut at 2 KB; the consent card now names the provider and the retention ("deleting data here removes UXBarter's copies, not necessarily OpenAI's") and asks people not to enter contact or sensitive data. |
| Logs | Coarse codes only (`model_timeout`, `assessment_malformed`, `rpc <name> failed`, ...). Verified by the Deno run: no keys, tester text or ids in the function log. |

## 8. Model, API, cost (verified on OpenAI's official docs, 2026-11-15)

Responses API, strict Structured Outputs, `store:false`, default **`gpt-6-luna`** ($0.10 / $0.50 per 1M tokens; `gpt-5-mini/nano` are deprecated, shutting down Dec 11 2026), `reasoning.effort` default `low`; model and effort are env-configurable (changing the model invalidates caches). **Unverified until the approved smoke test:** that luna accepts this exact schema + effort. **Estimated cost:** ~$0.005 per full recommendation run, ~$0.002 per assessed category; `scripts/ai-smoke-test.mjs` (synthetic data; dry run by default; needs `--execute --i-approve-paid-api-calls` and a key) is estimated at **~9 requests, about $0.006, hard upper bound ~$0.04** (9 x the 8000-token output cap). Prices change: re-check before enabling.

## 9. Files and migrations

* Migration: `supabase/migrations/20261115000500_ai_matching.sql` (additive; derived data + erasure + usage; no consent/answers/qualification tables).
* Function: `supabase/functions/ai-match/index.ts`; engine `supabase/functions/_shared/aiMatching/{engine,assess,handler,contract,validate,guard,rubrics,prompts,openai,profile,categories,types,util}.ts`; `supabase/config.toml` (`[functions.ai-match] verify_jwt = true`).
* UI: `src/lib/ai/{aiApi,flag}.ts`, `src/components/ai/{RecommendationDetails,AssessmentPanel}.tsx`; edits: `src/pages/Discover.tsx`, `src/pages/Profile.tsx`, `src/lib/api.ts` (consent withdrawal / answer deletion also erase AI data, no-op unless the flag is on), `src/components/Experience.tsx` (withdrawal policy text), `src/lib/aiContract.ts`, `src/lib/recommendations.ts`.
* Tests/tools: `tests/unit/{ai-engine,ai-assess,run-all}.mjs`, `supabase/tests/ai_matching.mjs`, `tests/deno/{e2e.mjs,run-function.ts}`, `tests/browser/ai-ui.mjs`, `scripts/ai-smoke-test.mjs`, `package.json` scripts `test:deno`, `check:deno`.

## 10. Tests and runtime verification (all local, mocked OpenAI)

Unit 79 + 145 + 73; real-Postgres (PGlite, migrations 1-9) 119 / 118 / 91 / 121 / 103 / 217 / 331 (profile) / 146 (AI integration); **Deno end to end 81** (the real unmodified `index.ts` under Deno 2.9.6 + real `npm:@supabase/supabase-js`, a PostgREST/Auth bridge backed by PGlite running all migrations, a mock OpenAI; real HTTP); browser 58 / 77 / 62 / 81 / 86 / 82 / 65; CSP 5; typecheck + build clean; `deno check` clean.
**Not verified:** the real model's judgement; the hosted Supabase Edge Runtime / `supabase functions serve` (no CLI or Docker here: Deno itself is verified, the platform wrapper is not); real PostgREST (the bridge mimics its RPC conventions); real concurrency (PGlite is single-connection; locks/`skip locked` are reasoned, not raced).
Known environment quirk: `tests/unit/matching.test.mjs` intermittently crashes Node's teardown on Windows AFTER passing (also on the profile workstream's own commit); `tests/unit/run-all.mjs` judges suites by their summary line.

## 11. Configuration

Supabase function secrets (`supabase secrets set`, never Git/Vercel): `OPENAI_API_KEY`, `AI_MATCHING_ENABLED=true`, `AI_ASSESSMENT_ENABLED=true`; optional `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `AI_USER_DAILY_CALLS` (12), `AI_GLOBAL_DAILY_CALLS` (1500), `AI_GLOBAL_DAILY_TOKENS` (5000000), `AI_MIN_RUN_INTERVAL_SECONDS` (15; 0 allowed), `AI_ALLOWED_ORIGINS`. Vercel build env (Production only, a plain boolean): `VITE_AI_MATCHING=1`. Create the OpenAI project key **with a monthly spend limit**.

## 12. Rollout (each step needs the owner's explicit approval; none was done)

1. Merge the profile workstream (PR #3 / `feat/matching-v2` incl. migration 8) and then this branch (`feat/ai-integration`).
2. Apply migration 8 (`20261115000300`) **first**, run `docs/verify-migration8.sql`; then apply `20261115000500` (`supabase db push --dry-run --remote` first). Both are additive for the UI: nothing calls them yet.
3. Deploy the UI with the flag **off** (`VITE_AI_MATCHING` unset): zero AI requests; the profile workstream's UI is live.
4. Set the OpenAI key (+ spend limit) and the two enable secrets **disabled**; `supabase functions serve ai-match` once locally, then `supabase functions deploy ai-match`.
5. Real smoke test: `scripts/ai-smoke-test.mjs --execute --i-approve-paid-api-calls` (synthetic data, ~$0.01), **read the output**; then one throwaway identity end to end on the real project (consent, answers, assessment, recommendations, withdrawal) and compare the OpenAI dashboard with `ai_usage`.
6. Enable `AI_ASSESSMENT_ENABLED=true`, then `AI_MATCHING_ENABLED=true`, then set `VITE_AI_MATCHING=1` and redeploy the UI. Optionally schedule `ai_apply_erasure_events()` with pg_cron.
Kill switches, fastest first: set either `AI_*_ENABLED=false` (UI shows "not available", every list and the app are unaffected; recorded decisions stay) -> unset `VITE_AI_MATCHING` + redeploy -> remove the function. Do not change Supabase Auth/CAPTCHA, Cloudflare, WAF or Vercel protection.

## 13. Remaining risks and open decisions

* **Decision needed:** consent-withdrawal vs. recorded decisions (section 6; default implemented = decisions persist).
* **Decision needed:** whether the AI assessment should run **automatically** after answers are saved (today: the tester presses "Check my answers now"; automatic would need a trigger/worker and raises cost/consent-surprise questions).
* **Accepted / open from the security review (all documented, none blocks local completion):** (a) a tester can re-roll the assessment by editing answers (5 saves per category per 24 h by the contract, 15 s throttle and the shared daily cap bound it; counting attempts per category across edits would need another table and was not built); (b) ~125 anonymous identities could exhaust the 1500/day global call cap and push everyone to the plain lists (the OpenAI spend limit bounds money; consider reserving part of the budget for identities with a completed test, and alert on `budget_reached`); (c) consent is read when a run starts, not again right before each model call (the data was legitimately read; the `ai_put_*` consent check prevents storing anything after a withdrawal); (d) `guard.ts` is a hint covering English/Ukrainian/Russian only, the model flag and grounding still apply; (e) `OPENAI_BASE_URL` is a test-only code path honoured for loopback hosts only; the smoke script honours it unrestricted (dev tool, never prints the key).
* Real model quality and `gpt-6-luna` schema acceptance are unmeasured (smoke test). The content-word rule and `guard.ts` patterns may need tuning on real outputs; `guard.ts` is intentionally narrow, so novel steering phrasing can slip past it (the grounded-evidence checks still apply).
* Anonymous identities are cheap: per-user caps multiply; the global caps and the OpenAI spend limit are the ceiling; exhausting the global cap only degrades everyone to the plain lists.
* A failed model step is not negative-cached: a persistently bad profile can use up to its daily cap.
* Self-reported answers can be dishonest; the assessment is a plausibility filter, not a verification, and the UI says so.
* Provider-side retention (up to 30 days of abuse-monitoring logs) is outside our control; deletion at the provider is not signalled by the database.
