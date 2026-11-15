# AI-powered relevance matching (branch `feat/ai-matching`)

Status: **implemented and tested locally. NOT merged, NOT deployed, migration NOT applied, no OpenAI key configured, no paid API call ever made.**
Everything here needs the owner's explicit approval before it goes anywhere near production (see "Rollout").

## 1. What it does

Discover gets an optional block, **"Recommended for your experience"**, above the unchanged full list (**"Browse all eligible tests"**).
A tester who opted in gets campaigns picked from what they actually wrote (bio + the free-text experience answers), each with a plain-language
reason, the verbatim quotes from their own profile it relied on, and what the campaign needs that the profile does not clearly show.
Two testers in the same category with different experience get different lists. A student who writes about real programming is matched to
developer tools; a prestigious school name alone matches nothing. When nothing is relevant the tester sees "No highly relevant tests found yet."
(never filler), and the full list stays available.

**AI recommends. The existing backend authorizes.** Nothing in this feature can reserve, submit, pay, refund, qualify or change eligibility.

## 2. Architecture

```
Browser (Discover)                                       Supabase                                       OpenAI
  POST ai-match {"action":"recommend"}  --JWT-->  Edge Function ai-match
                                                     1. verify JWT (platform verify_jwt + auth.getUser(token))
                                                     2. RPC service_get_ai_profile(uid)   [profile workstream's contract v1, service_role]
                                                        no consent => purge derived data + stop (model never called)
                                                     3. RPC list_campaigns_v2()            [AS THE CALLER, user JWT]
                                                        => the server's eligibility verdict; keep eligible && !in-progress, <= 30
                                                     4. RPC ai_get_cache(uid): analysis + verdicts keyed by content hashes
                                                     5. only if something is new/changed:
                                                        RPC ai_reserve_run(...)  atomic per-user + global caps, min interval
                                                        call 1 (profile changed)  -------------------------------->  structured experience (strict JSON)
                                                        call 2 (new campaigns, ONE batch) ------------------------>  verdict per campaign (strict JSON)
                                                     6. validate in code (grounding, whitelist, policy), cache, record tokens
  <-- {status, recommendations[], understanding} --
```

* **Two model steps, both cached.** Step 1 turns the free text into a structured "experience representation" (areas / tools / domains, each with
  verbatim evidence, plus what is missing). It runs only when the profile hash changes. Step 2 judges a *batch* of campaigns (never one call per pair)
  and runs only for campaigns that are new or edited for this profile. A page refresh costs **zero** model calls.
* **Cache keys are content hashes that also contain `POLICY_VERSION` and the model name**, not triggers: profile/answers change -> everything re-evaluated;
  a campaign edit -> only that campaign; a prompt/validation fix (bump `POLICY_VERSION`) or a model change -> every old verdict expires.
  Caches are per user (the RPCs only accept the id the function verified from the JWT).
* **Eligibility is re-read on every request** from `list_campaigns_v2()` under the caller's own JWT, so a cached "good" verdict can never outlive a change
  in eligibility, and an ineligible Targeted campaign is never sent to the model, returned, or shown (the UI filters again). The reservation trigger
  `test_reservations_eligibility` remains the final gate when someone presses Start.
* **Degradation.** Missing consent, thin profile, rate limit, a request already running, budget, OpenAI down/timeout/refusal/malformed output, function not
  deployed, feature flag off: each yields a clear status and the plain Discover list works exactly as before. Anonymous onboarding is untouched; AI is never required.

### Files
| Area | Files |
|---|---|
| Migration (additive, derived data only) | `supabase/migrations/20261115000500_ai_matching.sql` |
| Edge Function | `supabase/functions/ai-match/index.ts` (Deno wiring), `supabase/functions/_shared/aiMatching/{engine,handler,openai,prompts,validate,profile,contract,categories,types,util}.ts` (pure, run in Node for tests), `supabase/config.toml` (`[functions.ai-match] verify_jwt = true`) |
| Frontend (new, self-contained) | `src/lib/ai/{aiApi,types,flag}.ts`, `src/components/ai/AiRecommendations.tsx` |
| Frontend edits to existing files | `src/pages/Discover.tsx` only (one import, one mount point, one heading) |
| Tests | `supabase/tests/ai_matching.mjs`, `tests/unit/ai-engine.test.mjs`, `tests/browser/ai-ui.mjs`, runner wiring in `tests/browser/run.mjs`, `supabase/tests/package.json`, `package.json` |

## 3. Model and API choice (verified against OpenAI's official docs on 2026-11-15)

* **API:** Responses API (`POST /v1/responses`) with Structured Outputs: `text.format = {type:"json_schema", name, strict:true, schema}`,
  `store:false`, `max_output_tokens` (which *includes* reasoning tokens), no sampling parameters.
* **Default model: `gpt-6-luna`** (OpenAI's models page positions it for "cost-sensitive, high-volume workloads"; listed at $0.10 input / $0.01 cached /
  $0.50 output per 1M tokens, 1.05M context, 128K max output; `reasoning.effort` supports none/low/medium/high/xhigh/max). Default effort `low`.
  Configurable with `OPENAI_MODEL` / `OPENAI_REASONING_EFFORT` (changing the model invalidates cached verdicts by design).
* **Rejected:** `gpt-5-mini` / `gpt-5-nano` (cheaper on paper but **deprecated, shutdown Dec 11 2026**), `gpt-4.1-mini` / `gpt-4o-mini` (deprecated, Jan 14 2027),
  `gpt-5.4-mini` (works, 7.5x the input price), flagship models (cost without need).
* **Not yet verified (needs the approved smoke test):** that `gpt-6-luna` accepts exactly this strict schema + `reasoning.effort:"low"` combination on this account,
  real latency, and real token counts per run. The docs index I read did not include luna's own page. Pricing/availability can change: re-check before enabling.
* **Cost sketch (estimate, not measured):** a full run is ~3-4k input tokens for step 1 and ~5-12k for step 2 plus a few thousand output/reasoning tokens
  => roughly **$0.005-0.01 per full run**, near zero for cached refreshes. Ceilings regardless: 12 model calls / user / day, 1500 / day globally, 5M tokens / day
  globally (env-configurable). The token cap is checked before a run and recorded after it, so concurrent runs can overshoot it slightly; the **call cap and an
  OpenAI project spend limit are the hard ceiling.**

## 4. Safety, privacy, cost controls

| Concern | Measure |
|---|---|
| Key exposure | `OPENAI_API_KEY` only as an Edge Function secret (`supabase secrets set`). The browser bundle never contains it (a browser test greps the shipped JS). The frontend flag `VITE_AI_MATCHING` is a plain boolean. |
| Who can call | Platform `verify_jwt` + `auth.getUser(token)` in code; only `{"action":"recommend"}` accepted (no user id, prompt or model from the client); body <= 2 KB; POST only; allow-listed origins; fails closed. |
| DB access | New tables: RLS on, no policy, no grant. `ai_*` RPCs are `EXECUTE`-able by `service_role` only (catalog-checked). The one user RPC (`delete_my_ai_data`) only touches the caller's own rows. |
| Prompt injection | Untrusted text is JSON-encoded in the user message, never in the system prompt. **The real defence is code (`validate.ts`):** a match quote must be >= 12 characters, sit at word boundaries, and be text the *validated analysis* already quoted from the tester (so campaign text cannot pick its own "evidence" or reuse a stop word like "with"); refs are whitelisted; enums strict; recommended only for `strong`/`good` with grounded evidence and an explanation; `possible` is never promoted; a batch of >= 5 where >= 80% come back strong/good is distrusted entirely; model text has links, e-mail addresses, phone numbers, bare domains and markdown stripped and is rendered as plain text. **Residual risk (be honest):** grounding proves the cited words are the tester's, not that the campaign is truly relevant; a founder who writes steering text can still try to nudge the verdict for other testers, but not past the checks above, and never past server-side eligibility. This is why strong/good verdicts need the real-model smoke test review. |
| Hallucination | Items without a verbatim quote are dropped; if nothing is grounded, the summary is dropped and the match call is skipped (and the empty result is cached). |
| Privacy | Explicit opt-in listing exactly what is sent (bio, category labels, question/answer pairs; campaign name/description/task/audience), what is not (user id, nickname, tokens, qualification state), a request not to enter sensitive personal data, self-reported-not-verified, server still authorizes, opt-out deletes derived data. `store:false`; OpenAI's documented API policy: no training by default, abuse-monitoring logs up to 30 days. Nothing claims verification. Derived data (analysis incl. short verbatim quotes, verdicts) is erased by `delete_my_ai_data()` when the tester turns AI off, and by the function itself on any request where consent is not granted; deleting a profile cascades. |
| Cost | Hash caches; batched step 2; <= 30 campaigns and bounded text per run; `max_output_tokens` per call; atomic `ai_reserve_run` BEFORE spending; 45 s timeout; no retries; a cached analysis with nothing in it uses no allowance; tokens recorded. |
| Isolation | Cache rows keyed by verified user id; the engine never mixes users; unit tests assert one tester's text never appears in another's request and that another user's cache rows cannot satisfy a different profile hash. |
| Operations | Coarse failure codes (`model_timeout`, `analysis_malformed`, `rpc <name> failed`, ...) go to the function log, never prompts or user text. |

## 5. Integration with the profile / qualification workstream (Agent #1)

**Decision (changed after the security review surfaced their work):** this branch does **not** own consent, free-text answers, the question bank or any
answer-entry UI. The profile workstream already built them (uncommitted on their branch when this was written): tables `ai_consents` and `experience_answers`,
RPCs `set_ai_consent(boolean)`, `get_my_experience`, `save_experience_answers`, `delete_my_experience`, and the server-only
`service_get_ai_profile(user_id)` (contract v1, `src/lib/aiContract.ts` on their branch). Duplicating that would have collided (same function name `set_ai_consent(boolean)`,
two consent tables, two question banks). So this branch is a **consumer** through one adapter file, `supabase/functions/_shared/aiMatching/contract.ts`:

| Needs from them | How it is used |
|---|---|
| `service_get_ai_profile(p_user_id uuid) -> jsonb` with `contract_version = 1` | the Edge Function maps it (`mapContractProfile`): `consent.ai_processing`, `profile.bio`, `profile.categories`, and for each selected category `answers[] = {question, answer}` (already withheld by their function unless consent is granted). Everything else (qualification state, hashes, `subject_ref`, etag) is dropped before the model. An unknown `contract_version` fails closed. |
| `set_ai_consent(p_granted boolean)` | the only consent write; the UI calls it. The function reads consent through the contract on every request. |
| `list_campaigns_v2()` (migration 7, committed) | candidates + eligibility, called under the caller's JWT. Their migration replaces `tester_eligibility`, so changes to eligibility are inherited automatically. (Their `service_list_eligible_campaigns` would also work; `list_campaigns_v2` was kept because it is already committed and needs no extra dependency.) |
| Free-text answers 15-800 chars, four per category | accepted up to 800 characters per answer. |

**What this branch adds that they need to wire (small):**
* `delete_my_ai_data()` (migration 9): their `set_ai_consent(false)` / `delete_my_experience` do not know about the AI caches. This branch's UI calls `delete_my_ai_data()` after turning AI off,
  and the function purges again whenever it sees no consent, so nothing derived lingers. If they want deletion to be atomic, call `public.ai_purge_user(uid)` from their `set_ai_consent(false)` and `delete_my_experience`
  bodies (or add an `AFTER DELETE` trigger), keeping it a one-line coupling.
* **Copy that must change when both merge** (not edited here: their files): `src/pages/Profile.tsx` still says the profile "is only used to order the task list for you"; with AI on, the bio and answers are
  sent to OpenAI and stored as derived data. Make that line conditional on `VITE_AI_MATCHING` / consent. `README.md` ("No AI is involved") likewise. If any question text suggests health or finances
  (the first draft of this branch's own bank did, which the review flagged), reword it: the opt-in now also asks people not to enter sensitive personal data.
* Mapping their statuses to this function's: `insufficient_profile` ~ their `profile_incomplete`; this function additionally returns `busy`, `rate_limited`, `budget_reached`.
  Their `RecommendationsResponse` type in `aiContract.ts` (`items[{reason, score?}]`) differs from this function's response (`recommendations[{verdict, explanation, evidence[], unsupported_requirements[]}]`, no numeric score on purpose);
  the browser code that ships here consumes this function's shape, so their type should be updated to match rather than the other way round.
* Their contract also defines an *assessment* service for professional qualification (`service_list_pending_assessments`, `service_record_qualification`). **That is out of scope for this branch**: the AI here never decides or influences qualification.
* Migration order: `20261115000500_ai_matching.sql` has **no migration-time dependency** on their tables (only on `profiles` and `campaigns`), so it applies in any order. At **runtime** the Edge Function needs their `service_get_ai_profile`;
  until that function exists the AI block shows "not available right now" and nothing else changes.
* Files both branches touch (trivial merge): `tests/browser/run.mjs` (suite list + a 4th build with `VITE_AI_MATCHING=1`), `supabase/tests/package.json`, `package.json`, `src/pages/Discover.tsx` (one import + mount point + heading).

## 6. How relevance is decided (and weak matches filtered)

1. Server-eligible campaigns only (step 3 above).
2. Model verdict per campaign: `strong | good | possible | weak | none`, each with verbatim evidence, unsupported requirements and an explanation.
3. Code policy (`validate.ts`): recommended **iff** verdict is `strong`/`good` **and** >= 1 evidence quote passes the quote rules **and** the explanation is non-empty **and** the batch is not suspiciously uniform.
   A claimed `strong` with an invented quote is dropped entirely. `possible` ("uncertain") is never shown. No numeric score exists anywhere, so no score can override evidence or eligibility.
4. Ordering: `strong` before `good`, otherwise the server's own feed order. At most 10 shown.
5. Empty list -> "No highly relevant tests found yet." and the full list remains.

## 7. Rollout (every step needs the owner's explicit approval; none was done)

Each step is independently reversible and the UI is inert until the last one.
1. Review / merge: PR #3 (`feat/matching-v2`) first, then the profile workstream's contract (needs `service_get_ai_profile`), then this branch.
2. Apply migration `20261115000500_ai_matching.sql` (`supabase db push --dry-run --remote` first). Additive; rollback = leave it, nothing uses it.
3. Create an OpenAI project key with a **monthly spend limit**; `supabase secrets set OPENAI_API_KEY=... ` and `AI_MATCHING_ENABLED=true` (secrets live only in Supabase; never in Git / Vercel).
   Optional: `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `AI_USER_DAILY_CALLS`, `AI_GLOBAL_DAILY_CALLS`, `AI_GLOBAL_DAILY_TOKENS`, `AI_MIN_RUN_INTERVAL_SECONDS`, `AI_ALLOWED_ORIGINS` (add `http://localhost:5173` for local dev).
4. `supabase functions serve ai-match` once locally (the function has never been run under Deno), then `supabase functions deploy ai-match` (verify_jwt is on via `config.toml`).
5. **Smoke test with one throwaway identity** (explicit approval; real paid API calls): confirm the model accepts the schema, latency, token counts, that two different profiles get different lists, and read the actual explanations for steering/odd text. Check the OpenAI usage dashboard against `ai_usage`.
6. Set `VITE_AI_MATCHING=1` as a Vercel Production env var (Config type) and deploy the UI. **Kill switches, fastest first:** `supabase secrets set AI_MATCHING_ENABLED=false` (UI shows "not available", list unaffected) -> unset `VITE_AI_MATCHING` + redeploy -> remove the function.
Do **not** change Supabase Auth/CAPTCHA, Cloudflare, WAF or Vercel protection for this.

## 8. Known limitations / honest notes

* **Not run under Deno.** No `deno`/Supabase CLI on the build machine: `index.ts` (thin wiring) was reviewed (twice) but never executed; all logic it calls is unit-tested in Node. Run `supabase functions serve ai-match` before deploying.
* **Model quality is unmeasured.** Automated tests use a deterministic stand-in model, so they prove the pipeline and the safety policy, not the semantic quality of `gpt-6-luna`'s judgement. The uniformity guard and the 12-character quote rule may need tuning on real outputs.
* Anonymous identities are cheap (documented project risk): per-user caps can be multiplied by creating identities; the global caps and the OpenAI spend limit are the real ceiling, and exhausting the global cap only degrades everyone to the plain list.
* A failed model step is not negative-cached: a persistently unparseable profile can spend up to the per-user cap (12 calls/day, 15 s apart) before it stops. Accepted for the MVP.
* Free-text "experience" is self-reported and unverified; the UI says so.
* The `list_campaigns_v2()` feed is capped at 50 rows and the AI looks at the first 30 eligible ones (the server's ordering puts category-matching tasks first).
* No answer-entry UI ships in this branch: until the profile workstream's answers exist, only the 280-character bio feeds the AI (`insufficient_profile` is returned for very thin profiles).
