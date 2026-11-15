# AI matching + professional assessment — project memory (branch `feat/ai-integration`)

_Updated 2026-11-15 after integrating with the profile workstream (`feat/matching-v2` @ 2eaf716). Separate file on purpose: fold into `decisions.md` / `project-state.md` after both branches merge. Full detail: `docs/AI_MATCHING.md`._

## State
Implemented + integrated + tested locally. **NOT pushed, NOT merged, migrations 8 and 9 NOT applied, function NOT deployed, no OpenAI key, no paid API call ever made, `VITE_AI_MATCHING` unset everywhere.** `feat/ai-matching` (d076c99) is the superseded pre-integration branch.

## ADR-018 — AI recommends / proposes, the database authorizes
Recommendations only rank campaigns that `list_campaigns_v2()` (under the CALLER's JWT) marks eligible; a recorded professional decision only goes through the contract's `service_record_qualification`. A unit test asserts the AI code never names reservation/credit/referral/profile-write/consent-write functions, and a Deno e2e asserts the exact RPC set the function touches.

## ADR-019 — Model/API: OpenAI Responses API, strict JSON schema, default `gpt-6-luna`
Verified on OpenAI's official docs 2026-11-15 (`gpt-5-mini/nano` deprecated, shutdown 2026-12-11). Env-configurable (`OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`). `store:false`; `max_output_tokens` includes reasoning tokens. **Unverified until the approved smoke test** (`scripts/ai-smoke-test.mjs`, synthetic, dry-run by default): schema + effort acceptance, real quality.

## ADR-020 — Trust nothing the model returns (code is the defence)
Quotes must be verbatim, at word boundaries, contain a content word, and come from the validated analysis evidence (no arbitrary minimum length; the old whole-batch "uniformity" rule was REMOVED). Steering text is stopped by `guard.ts` (campaign text never sent to the model; tester answers never qualify). Model text is stripped of links/e-mails/phones and rendered as plain text.

## ADR-021 — UI ships dark behind `VITE_AI_MATCHING=1`
Without it: zero AI requests, no assessment panel, no extra RPC (existing browser suites assert zero console errors). Lets the UI deploy independently of migrations/function/key.

## ADR-022 — Consumer of the profile workstream's contract, no duplicate storage
Consent (`ai_consents`, `set_ai_consent(p_granted)`), answers, qualification decisions and the erasure-event log belong to migration 8. My migration 9 stores only AI-derived data keyed by `subject_ref`. ONE adapter (`_shared/aiMatching/contract.ts`) knows their shape; unknown contract version fails closed. One consent UI (their Profile card).

## ADR-023 — Professional assessment (rubric r1)
Model proposes, code decides: qualified needs grounded evidence in >= 2 DIFFERENT answers + non-low confidence + no flags; honest beginners -> not_qualified (kind); unsure/vague/injection/thin -> needs_clarification, NOT recorded (category stays pending). Stored decision = model id + rubric version + FIXED sentence + numeric confidence, never answer text. Triggered by the tester ("Check my answers now"), not automatically. No credentials ever required; "self-reported, not verified" everywhere.

## ADR-024 — Consent withdrawal vs. recorded decisions (documented, tested)
Withdrawal erases everything the AI derived and stops processing; an ALREADY recorded decision stays in force (status, not processing); nothing new is recorded while off; editing answers while off makes the category pending until re-consent; deleting answers deletes the decision. Alternative (invalidate decisions on withdrawal) needs a migration-8 change: owner decision pending.

## Gotchas
- Erasure: `ai_apply_erasure_events()` (reads the contract's events, deletes by subject_ref, THEN advances the cursor, one transaction) runs at the start of every request; optionally schedule it with pg_cron.
- `AI_MIN_RUN_INTERVAL_SECONDS=0` must be honoured (the Deno e2e found `int()` rejecting 0).
- `index.ts` type-checks and runs under Deno 2.9.6 (`npm run check:deno`, `npm run test:deno` with `DENO_BIN`); the hosted Supabase Edge Runtime / CLI was NOT available.
- Tool quirks on this machine: `\n` and `\\` escapes in heredocs/tool inputs get mangled -> write scripts with the file tool; Windows `.bin/deno` is a shim, use the real exe (`node_modules/@deno/win32-x64/deno.exe`). `tests/unit/matching.test.mjs` intermittently crashes Node teardown AFTER passing (also on 2eaf716): use `tests/unit/run-all.mjs`.
- Tests: unit 79+140+62; DB 119/118/91/121/103/217/331/137; Deno e2e 81; browser 58/77/62/81/86/82/65; CSP 5.

## Next logical work
Approved smoke test + prompt tuning on real outputs; optional automatic assessment after save; pg_cron schedule for the erasure sweep; negative-caching of failed steps; founder-side hints.
