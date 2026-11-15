# AI matching + professional assessment — project memory (branch `feat/ai-integration`)

_Updated 2026-11-15 after integrating with the profile workstream (`feat/matching-v2` @ 2eaf716). Separate file on purpose: fold into `decisions.md` / `project-state.md` after both branches merge. Full detail: `docs/AI_MATCHING.md`._

## State
Implemented + integrated + tested locally (consent recheck, withdrawal-removes-decisions, auto assessment added 2026-11-15). **NOT pushed, NOT merged, migrations 8 and 9 NOT applied, function NOT deployed, no OpenAI key, no paid API call ever made, `VITE_AI_MATCHING` unset everywhere.** `feat/ai-matching` (d076c99) is the superseded pre-integration branch.

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

## ADR-024 — Consent withdrawal REMOVES AI-derived decisions (owner decision 2026-11-15; supersedes the earlier "decisions persist")
Withdrawal erases everything the AI derived, stops processing and deletes every qualified/not_qualified decision: professional categories return to Pending; account, profile, answers, credits and Open Testing stay. Done without editing migration 8: migration 10 (`20261115000600`) = AFTER UPDATE trigger on ai_consents + AFTER INSERT/UPDATE trigger on category_qualifications (FOR SHARE consent lock). Agent #1 must accept it or fold it into set_ai_consent. Consent is also re-read before EVERY OpenAI request (`ai_consent_active`, fail-closed).

## ADR-025 — Automatic assessment (owner decision 2026-11-15)
After a valid save of a professional category's answers with consent on, or when consent is switched on, the Profile page starts ONE assessment (one-shot token; reload never does). Server dedupes by answers_hash+question_version+rubric/policy/model/bio. States: Pending/Processing/Qualified/Needs clarification/Not qualified yet.

## ADR-026 — Smoke test is gated and self-tested
`scripts/ai-smoke-test.mjs`: separate-project key only (sk-proj-/sk-svcacct-), read from env or ~/.uxbarter/openai-smoke.env, never printed, loopback-only base URL, $0.05 hard ceiling checked before every request, stops at first unexpected failure (exit 3) / failed expectation (exit 1), no retries. Guards proven by `tests/unit/smoke-script.test.mjs` against a mock. Windows: exit via setTimeout (immediate process.exit after fetch crashes libuv).

## First real run (2026-11-15)
`scripts/ai-smoke-test.mjs` against gpt-6-luna (effort low): 11/11 requests OK, all expectations passed, 10.8k in + 2.8k out tokens, ~$0.0025. Strict schema + effort accepted. Key set up with `scripts/setup-openai-smoke-key.ps1` (hidden prompt, owner-only ACL, ~/.uxbarter/openai-smoke.env). Observed: one-word quote accepted as evidence; reasons may paraphrase campaign text. Still unverified: Supabase hosted runtime, real PostgREST, real concurrency, quality at scale.

## Gotchas
- Erasure: `ai_apply_erasure_events()` (reads the contract's events, deletes by subject_ref, THEN advances the cursor, one transaction) runs at the start of every request; optionally schedule it with pg_cron.
- `AI_MIN_RUN_INTERVAL_SECONDS=0` must be honoured (the Deno e2e found `int()` rejecting 0).
- `index.ts` type-checks and runs under Deno 2.9.6 (`npm run check:deno`, `npm run test:deno` with `DENO_BIN`); the hosted Supabase Edge Runtime / CLI was NOT available.
- Tool quirks on this machine: `\n` and `\\` escapes in heredocs/tool inputs get mangled -> write scripts with the file tool; Windows `.bin/deno` is a shim, use the real exe (`node_modules/@deno/win32-x64/deno.exe`). `tests/unit/matching.test.mjs` intermittently crashes Node teardown AFTER passing (also on 2eaf716): use `tests/unit/run-all.mjs`.
- Security review fixes applied: no derived writes after withdrawal (consent-for-subject_ref check), skip-proof erasure (reconciliation <= 60 s; schedule pg_cron), qualified = 3 criteria or 2 + high confidence with distinct quotes, note keys (rubric/policy/model/bio), guard narrowed + NFKC/format-char stripping, bounded chunked bodies, provider/retention disclosure in the consent card. Open: attempt counting across answer edits, global-budget DoS via anonymous identities.
- Tests: unit 79+160+82+30; DB 119/118/91/121/103/217/331/165; Deno e2e 91; browser 58/77/62/81/86/82/84; CSP 5; brand 31. `npm install --no-save deno@2.9.6` is needed again if node_modules was pruned (tests/deno, check:deno).

## Next logical work
Approved smoke test + prompt tuning on real outputs; optional automatic assessment after save; pg_cron schedule for the erasure sweep; negative-caching of failed steps; founder-side hints.
