# AI-powered relevance matching — project memory (branch `feat/ai-matching`)

_Written 2026-11-15. Separate file on purpose: `decisions.md` / `project-state.md` are being edited on `feat/matching-v2` by another agent; fold this in after both merge._

## State
Implemented + tested locally on `feat/ai-matching` (based on `feat/matching-v2` @ 3afe364). **NOT merged, migration 9 NOT applied, Edge Function NOT deployed, no OpenAI key configured, no real API call ever made, `VITE_AI_MATCHING` not set anywhere.** Full design, data contract, rollout and kill switches: `docs/AI_MATCHING.md`.

## ADR-018 — AI recommends, the existing backend authorizes
Decision: the AI only ranks/explains campaigns that `list_campaigns_v2()` (called under the CALLER's JWT) already marks eligible. It never grants access and never touches credits, reservations, referrals or screening (a unit test asserts the AI code does not even name those RPCs).
Reason: eligibility (migration 7 trigger) is the security boundary; a score/LLM must not be able to override it.
Rejected: letting the function compute eligibility itself (duplicate logic would drift from migration 8); numeric match scores (can override evidence).
Consequence: any future eligibility change is inherited automatically; the AI block can disappear without affecting the product.

## ADR-019 — Model/API: OpenAI Responses API + strict JSON schema, default `gpt-6-luna`
Verified on OpenAI's official docs 2026-11-15. `gpt-5-mini/nano` are deprecated (shutdown 2026-12-11), `gpt-4.1-mini`/`gpt-4o-mini` 2027-01-14. luna = cost-sensitive tier ($0.10/$0.50 per 1M). Model + reasoning effort are env-configurable. **Unverified until the approved smoke test:** that luna accepts this exact schema + `reasoning.effort:"low"`. `store:false`; `max_output_tokens` includes reasoning tokens (size budgets accordingly).

## ADR-020 — Trust nothing the model returns (code-level policy)
Evidence quotes must appear verbatim in the tester's own text; refs whitelisted; strict enums; recommended only for strong|good with grounded evidence + explanation; `possible` never promoted; model text stripped of URLs/markdown and rendered as plain text. Prompt text is only a first line of defence.

## ADR-022 — Consumer of the profile workstream's contract, no duplicate storage
Found during security review: the other workstream (uncommitted) already owns consent (`ai_consents`, `set_ai_consent(boolean)`), free-text answers (`experience_answers`) and `service_get_ai_profile` (contract v1). This branch keeps only AI-derived data (analysis, verdicts, usage) + `delete_my_ai_data()` and reads their data through ONE adapter (`_shared/aiMatching/contract.ts`; unknown contract version fails closed). Same-name collision (`set_ai_consent(boolean)`) avoided by deleting my own consent/answers/question bank/`/experience` page.
Consequence: runtime dependency on `service_get_ai_profile` (until then the AI block says "not available"); no migration-time dependency.

## ADR-021 — Frontend ships dark behind `VITE_AI_MATCHING=1`
Without it the app makes zero AI requests (not even a 404 from a missing RPC) and Discover is byte-for-byte the old page. Lets the UI deploy independently of migration/function/key. Existing browser suites assert zero console errors, which is why the flag exists.

## Gotchas
- Cache invalidation is by content hash incl. POLICY_VERSION + model name (bump POLICY_VERSION when prompts/validation change). Opt-out: UI calls `delete_my_ai_data()`; the function purges again whenever it sees no consent. Answers/consent are owned by the profile workstream.
- Cost ceilings are enforced in Postgres (`ai_reserve_run`) BEFORE spending; anonymous identities are cheap, so the **global** caps + an OpenAI project spend limit are the real ceiling.
- `index.ts` (Deno) has never been executed (no deno/supabase CLI locally). Run `supabase functions serve ai-match` before deploying.
- Edge Function must use the exact RPC arg names in `index.ts` (`p_user`, `p_input_hash`, ...); a unit test pins the set of RPCs it reaches.
- Writing files on this machine: `\n` / `\\` escapes inside tool inputs got mangled twice (raw newlines inside string literals); prefer char codes / re-read after writing, run `node --check`.
- Tests: `tests/unit/ai-engine.test.mjs` (140, mocked model), `supabase/tests/ai_matching.mjs` (76, PGlite), `tests/browser/ai-ui.mjs` (57, stubbed). No test measures the real model's judgement.

## Next logical work
Real-model smoke test (approval + key), tune prompts on real outputs, founder-side "who might fit" hint, shared answers across categories, per-category weighting. Not started: anything touching payments/identity verification (out of scope).
