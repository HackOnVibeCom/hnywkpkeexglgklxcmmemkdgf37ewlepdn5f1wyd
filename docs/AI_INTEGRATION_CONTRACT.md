# AI integration contract (version 1)

**Audience:** the AI relevance-matching / professional-assessment workstream ("Agent #3"). **Owner of the data and of this contract:** the profile / qualification workstream (migration 8). **Status:** implemented and tested locally; migration 8 is **not applied** to production. Nothing here calls an AI service; no OpenAI key, service-role key or other secret exists in this repository.

Machine-readable types: [`src/lib/aiContract.ts`](../src/lib/aiContract.ts) (types only, no imports). Browser seam: [`src/lib/recommendations.ts`](../src/lib/recommendations.ts). Database: `supabase/migrations/20261115000300_experience_profile.sql`.

## 1. What the AI service owns, and what it does not

| Owned by the AI service | Owned by this workstream (do not re-implement) |
|---|---|
| Ranking / relevance of campaigns for one tester | Who may reserve a task (server-enforced eligibility, a trigger on `test_reservations`) |
| The *decision* "qualified / not_qualified" for a professional category, **recorded through the one allowed function** | Profile, the four questions, answer validation and storage, consent, deletion, credits |
| Its own prompts, models, caching | The state machine below and the participation rule |

A recommendation is **never** an eligibility decision. A tester can only act on a campaign the database lets them reserve; the recommendation list is additionally filtered by the browser with `actionableRecommendations()` (see §6).

## 2. Trust boundaries (non-negotiable)

1. **Everything below runs on a server you control.** The Supabase **service-role key** and the **OpenAI key** live only in that server's environment (e.g. Vercel server env / Supabase Edge Function secrets). They are never put in a `VITE_*` variable, never in the browser bundle, never committed.
2. **Identify the tester from a verified JWT, never from the request body.** The browser calls your endpoint with `Authorization: Bearer <supabase access token>`; your server verifies it (e.g. `supabase.auth.getUser(jwt)` or JWKS) and uses the resulting `sub` as `p_user_id`. An endpoint that takes a `user_id` from the client is an account-takeover bug.
3. **Consent gate.** Send the bio or any answer to OpenAI (or any third party) **only** when `consent.ai_processing === true`. The database enforces this for you: `service_get_ai_profile` returns `bio = null`, `answers = null` and `subject_ref = null` without consent, and `service_record_qualification` refuses (`consent_required`). Do not work around it (no direct table reads with the service key to get answers).
4. **Never log answers or the bio.** They are sensitive personal text. Log `subject_ref`, `etag`, categories, states and timings only.
5. **Only `subject_ref` may leave the server.** It is an opaque random uuid (not derived from the account id, rotates when consent is granted again after a withdrawal). Do not send the account id, nickname, or the JWT to OpenAI.
6. **Do not store derived personal text.** If you cache results, key them by `etag` and keep them server-side; delete cached results when `consent.ai_processing` becomes false or the `etag` changes. `p_assessment` (stored in the database) may contain only `model`, `rubric_version`, a short `summary` (≤ 500 chars) and `confidence`, and **never** quotes of the tester's answers.
7. **Do not claim verification.** UXBarter only ever calls the result "assessed from self-reported experience". Do not describe it as verified employment, identity or credentials in any tester-facing text.

## 3. Category states (computed by the database)

| state | meaning |
|---|---|
| `inactive` | not in the tester's profile |
| `incomplete` | in the profile, the four answers for the **current** question version are missing or outdated |
| `active` | general category: answers complete. **professional** category: answers complete **and** a valid `qualified` decision |
| `pending_assessment` | professional, answers complete, no valid decision yet → **this is your work queue** (consented testers only) |
| `not_qualified` | professional, a `not_qualified` decision for exactly these answers; editing the answers re-opens it |

`participation_ready` = at least one **selected** category has complete answers. It is required to reserve **any** task (open or targeted). A pending professional category counts for participation (completing the profile) but **not** for matching or targeted eligibility.

Professional categories: `tech_savvy`, `founders_builders`, `business_office`. General: `students_learners`, `everyday_nontechnical`. General categories need no assessment; do **not** try to "qualify" them (`category_not_assessable`).

A decision is valid **only** for the exact `(question_version, answers_hash)` it was made for. If the tester edits an answer, the hash changes and the category returns to `pending_assessment` automatically; a late decision for the old hash is refused (`stale_assessment`).

## 4. The server-only interface (PostgreSQL functions, `EXECUTE` for `service_role` only)

Call with the Supabase service-role client: `supabase.rpc('<name>', args)`. All are `SECURITY DEFINER`, `search_path = ''`, unreachable by `anon`/`authenticated`/`PUBLIC` (catalog-checked by `docs/verify-migration8.sql`).

### 4.1 `service_get_ai_profile(p_user_id uuid) → AiProfileV1 | null`

Returns `null` for an unknown id. Shape (see `AiProfileV1` in `aiContract.ts` for the exact TypeScript):

```json
{
  "contract_version": 1,
  "subject_ref": "0b3c…-uuid",                         // null unless consent granted
  "consent": { "ai_processing": true, "policy_version": 1, "updated_at": "2026-11-15T…Z" },
  "profile": { "bio": "…" /* null without consent */, "categories": ["tech_savvy","students_learners"], "updated_at": "…" },
  "categories": [                                         // always 5, canonical order
    {
      "category": "tech_savvy", "kind": "professional", "selected": true,
      "state": "pending_assessment",
      "question_version": 1, "answers_version": 1, "answers_complete": true,
      "answers_hash": "9f2c…64 hex", "answers_updated_at": "…",
      "answers": [                                        // null without consent, when incomplete, or when the category is NOT selected
        { "question_id": "q1", "question": "What technologies, tools or software do you have experience using?", "answer": "…" },
        { "question_id": "q2", "question": "…", "answer": "…" },
        { "question_id": "q3", "question": "…", "answer": "…" },
        { "question_id": "q4", "question": "…", "answer": "…" }
      ],
      "qualification": null                               // or { "status": "qualified" | "not_qualified", "source": "ai_assessment", "decided_at": "…" } (valid decision for THESE answers only)
    }
    /* … students_learners, everyday_nontechnical, founders_builders, business_office … */
  ],
  "active_categories": ["students_learners"],
  "participation_ready": true,
  "updated_at": "…",
  "etag": "64 hex"                                        // cache key
}
```

* `question` is the exact text of the version that was answered (`answers_version`), so prompts to the model stay faithful when questions change.
* Answers of categories that are not (or no longer) in the tester's profile are **never** returned (they stay stored for the owner, who can delete them at any time); after the tester removes their profile, no bio and no answers are returned.
* The **nickname is never part of the contract.**
* `etag` = sha256 over (consent flag, `subject_ref` if consented, bio if consented, categories, and per category `state`, `answers_hash`, valid decision). It changes iff something an AI result can depend on changes. Use it as the cache key and invalidation signal; no timestamp comparison is needed.

### 4.2 `service_list_pending_assessments(p_limit integer default 50) → rows`

`(user_id, subject_ref, category, question_version, answers_hash, answers_updated_at)` for professional categories that are `pending_assessment` **and** whose owner consented. No answers inside (fetch one tester with 4.1). `p_limit` is clamped to 1…200. Oldest first. Poll it, or trigger on your own schedule.

### 4.3 `service_record_qualification(p_user_id, p_category, p_question_version, p_answers_hash, p_status, p_assessment) → category status json`

The **only** way a professional category can become `active`. Arguments: take `question_version` and `answers_hash` **from the profile you assessed** (4.1). Errors (PostgREST returns the code in `message`):

| error | meaning |
|---|---|
| `invalid_status` | `p_status` is not `qualified` / `not_qualified` |
| `category_not_assessable` | not one of the three professional categories |
| `consent_required` | the tester has not consented (or withdrew) |
| `stale_assessment` | no answers, other question version, or the answers changed since you read them → re-read 4.1 and decide again |
| `invalid_assessment` | payload has keys other than `model`, `rubric_version`, `summary`, `confidence`, is > 4 KB, or `summary` > 500 chars |

**Decision schema** (what ends up in `public.category_qualifications`, one row per tester × professional category, written only by this function):

| column | value |
|---|---|
| `status` | `qualified` \| `not_qualified` |
| `source` | always `ai_assessment` (the table cannot represent any other source) |
| `question_version`, `answers_hash` | exactly those of the answers that were assessed (taken from `service_get_ai_profile`) |
| `assessment` | optional `{ model, rubric_version, summary (≤ 500 chars), confidence }`, ≤ 4 KB, never answer text |
| `decided_at` | set by the database |

Example (service side): `await supabase.rpc('service_record_qualification', { p_user_id: sub, p_category: 'tech_savvy', p_question_version: cat.question_version, p_answers_hash: cat.answers_hash, p_status: 'qualified', p_assessment: { model: '<model id>', rubric_version: 'r1', summary: 'Describes hands-on tooling and a debugging story.' } })`. The tester's category becomes `active` the moment the row exists and stays active only while the answers still hash to `answers_hash`.

It is idempotent (re-deciding replaces the single row per tester/category).

### 4.4 `service_list_eligible_campaigns(p_user_id uuid) → rows`

**Only for testers who consented to AI processing** (the listing reveals which categories are active for them; it is empty otherwise). The campaigns this tester can **act on right now**, by the same rule the database enforces (`tester_eligibility`) and with the same visibility filters as the Discover feed (own campaigns, already-tested ones, expired ones and ones someone else is testing are excluded; max 200). Columns: `campaign_id, project_name, description, task_description, created_at, expires_at, testing_mode, target_categories, match_categories, reserved_by_me`. The project URL is never included. **Rank only within this list**: a targeted task the tester cannot reserve will never appear.

### 4.5 `service_list_erasure_events(p_after_id bigint default 0, p_limit integer default 200) → rows`

`(id, subject_ref, reason, category, created_at)`, oldest first, limit clamped to 1…1000. One row whenever data that an AI service may have processed or cached must be deleted on your side. Only the opaque `subject_ref` is returned (never an account id, nickname or text). `reason`:

| reason | when | what you must delete |
|---|---|---|
| `consent_withdrawn` | the tester switched AI processing off | everything you keep for that `subject_ref` |
| `answers_deleted` | the tester deleted answers (`category` = one category, or `null` = all) | cached profiles, embeddings, summaries and recommendations derived from those answers (for `null`: everything) |
| `profile_removed` | the tester removed their tester profile (bio gone) | everything derived from the bio / categories |
| `account_deleted` | the anonymous account was deleted | everything for that `subject_ref` |

Events are only logged for testers who ever consented (otherwise nothing was sent). Keep your own cursor (the last `id` you processed) and poll it; see §10.

## 5. Behaviour when the AI service is unavailable (explicit)

* Nothing is ever approved by default or by timeout. A professional category with complete answers stays `pending_assessment` (the UI says "Pending assessment") indefinitely. Tested: 90 days without a decision changes nothing.
* The tester can still: use the app, request tests, and take every **open** task once any selected category has its four answers (including a pending professional one).
* Targeted tasks for a professional category stay unavailable until a decision exists; targeted tasks for a general category are available as soon as its answers are saved.
* The Discover **Recommended for you** view shows an honest "not available yet" state; **Browse all eligible tests** is unaffected.
* Earlier multiple-choice passes (migration 7) are **not** carried over and never count: they cannot activate a professional category or bypass the assessment. Testers who passed it earlier wait for the assessment like everybody else.

## 6. Browser ↔ your recommendation endpoint

The browser calls one function, `fetchRecommendations()` in `src/lib/recommendations.ts` (today it returns `{ status: 'unavailable' }`). Replace its body with a `fetch` to **your** server endpoint:

```
GET/POST <your endpoint>
Authorization: Bearer <supabase access token of the signed-in anonymous user>
→ RecommendationsResponse
```

```ts
type RecommendationsResponse =
  | { status: 'ok'; generated_at: string; profile_etag: string; items: { campaign_id: string; reason: string; score?: number;
        verdict?: 'strong' | 'good'; evidence?: { quote: string; relevance: string }[]; unsupported_requirements?: string[] }[] }
  | { status: 'profile_incomplete'; detail?: 'not_participation_ready' | 'too_little_text' }
  | { status: 'unavailable' | 'consent_required' | 'rate_limited' | 'busy' | 'budget_reached' };
```
(Amended by the AI workstream, see section 11: the optional `verdict` / `evidence` / `unsupported_requirements` and the three extra statuses.)

* `ok` with an empty `items` is a first-class answer: Discover shows "No relevant recommendations right now". Prefer returning nothing to padding the list with weak matches.
* `reason` is shown to the tester next to the card (≤ 280 chars, plain language, do not quote the tester's answers).
* Discover only calls the provider when `participation_ready` and consent are true, and then renders **only** items that are also in the database's eligible list (`actionableRecommendations`, unit-tested: unknown, ineligible, duplicate and malformed items are dropped).
* Ranking, scoring and how many items to return are yours. Eligibility is not yours to decide.

Suggested server flow per request: verify JWT → `sub` → `service_get_ai_profile(sub)` (stop if no consent / not ready) → `service_list_eligible_campaigns(sub)` → cache check by `etag` → model call using `subject_ref` + the answers + campaign descriptions → validate that every returned `campaign_id` is in the eligible list → respond. For assessments: loop over `service_list_pending_assessments`, call 4.1, assess, then 4.3 with the version/hash you read.

## 7. Questions (version 1), for prompt design

Four open-ended questions per category, ids `q1…q4`; answers are 15–800 characters, trimmed, whitespace-collapsed, not all identical. Tech-Savvy and Students & Learners use the wording agreed with the product owner; the other three are in the migration (`experience_questions`). A student can be an expert: do not infer skill from the category.

## 10. Consent withdrawal and deletion of AI-derived data (required behaviour)

The database stops handing out data the moment consent is withdrawn; **you** must also forget what you derived.

1. **On every request** call `service_get_ai_profile` first. If `consent.ai_processing` is `false`, stop: no OpenAI call, no recommendations, no assessment (the database also returns no bio / answers / `subject_ref`, an empty `service_list_eligible_campaigns`, no queue entry, and refuses `service_record_qualification` with `consent_required`). The browser also stops asking for recommendations when consent is off.
2. **Poll `service_list_erasure_events`** (suggested: every few minutes and before serving a cached result) and, for each `subject_ref`, delete everything you stored: cached `AiProfileV1`, prompts/responses you retain, embeddings, summaries, recommendation caches, assessment drafts. Delete first, then advance your cursor.
3. **Cache keys:** key caches by `etag` (changes on any answer, bio, category, consent or `subject_ref` change). A cache entry whose `etag` no longer matches must not be served.
4. **What the database deletes by itself:** `delete_my_experience` removes the answers and the assessment decisions made about them; **(superseded, see section 11 A4: withdrawal now also removes the AI-derived decisions)** consent withdrawal alone used to leave an existing decision in place; nothing new can be recorded; account deletion cascades to answers, consent and decisions.
5. **Third parties:** only `subject_ref` (random, rotates on re-consent) and the content you are allowed to send leave your server. If you use a provider that retains requests, configure zero/minimal retention; deletion at the provider is your responsibility and is not signalled by this database.

## 8. Change policy

Fields are only added (optional); removing/renaming one or changing a meaning is `contract_version` 2 with new function names, announced here first. If you need a new field or function, request it instead of reading tables directly (the tables have no client grants and the service key must not be used to bypass the consent gate).

## 9. What this workstream does **not** provide (explicit blockers for you)

* The assessment decision itself, the OpenAI client, the recommendation endpoint and its hosting, secrets management, spend limits and prompt-injection hardening of free-text answers (treat answers as untrusted data inside prompts).
* A decision policy for borderline answers. Until you deliver it, professional categories remain pending (§5); nothing here substitutes a temporary approval.

## 11. Amendments made while integrating the AI workstream (`feat/ai-integration`)

All backward compatible (fields only added); `contract_version` stays 1. Implementation notes: `docs/AI_MATCHING.md`.

1. **`RecommendationsResponse`** keeps every field above and adds, all optional: per item `verdict`, `evidence` (verbatim quotes of the tester's OWN text, verified server-side; shown only to that tester), `unsupported_requirements`; top level `understanding`; statuses `rate_limited` (the tester used today's AI allowance), `busy` (a previous request is still running), `budget_reached` (the service-wide daily budget is used up), and `detail` on `profile_incomplete`. `score` is optional and never produced: relevance is evidence-based, there is no numeric score. `reason` is a paraphrase (the verbatim words go in `evidence`).
2. **Assessment endpoint** (same Edge Function, `{"action":"assess"}`, body is exactly that, no other field): assesses the CALLER's own pending professional categories and records decisions only through `service_record_qualification`. Response `{ status, results[{ category, outcome: 'qualified'|'not_qualified'|'needs_clarification'|'pending', message, clarification_questions[], criteria[] }] }`. `needs_clarification` and `pending` are NOT decisions: the category stays `pending_assessment`.
3. **What is stored in `p_assessment`**: `model`, `rubric_version` (`r1`), a FIXED sentence as `summary` (never model prose, never answer text), and a numeric `confidence`.
4. **Consent withdrawal vs. existing decisions (product decision 2026-11-15, SUPERSEDES section 10 item 4 and the earlier wording of this amendment):** withdrawing consent **removes every AI-derived decision** (`qualified` and `not_qualified`); the professional categories return to `pending_assessment`. The anonymous account, tester profile, written answers (`participation_ready`), credits and Open Testing are untouched; general categories stay active. Nothing can be recorded while consent is off. Re-consent rotates `subject_ref` and the categories are assessed again. Deleting the answers deletes the decision, as before. Implemented WITHOUT editing migration 8, by `20261115000600_consent_withdrawal_clears_decisions.sql` (an AFTER UPDATE trigger on `ai_consents` deleting the user's `category_qualifications` rows on a true->false transition, and an AFTER INSERT/UPDATE trigger on `category_qualifications` that locks the consent row `FOR SHARE` and raises `consent_required`, so a decision can never commit behind a concurrent withdrawal). **Request to the profile workstream:** either accept this migration as is, or move the same two statements into `set_ai_consent` and drop it; in both cases update section 10 item 4 and `docs/verify-migration8.sql` (a withdrawal now leaves zero rows in `category_qualifications` for that user). Agent #1's full suite passes unchanged with the migration applied.
5. **Erasure implemented** as `public.ai_apply_erasure_events()` (AI migration): reads `service_list_erasure_events` after its own cursor, deletes everything held for each `subject_ref` (all reasons and categories), then advances the cursor in the same transaction; called at the start of every request and optionally by pg_cron. Cached rows are also bound to the current `subject_ref` and keyed by `etag`.
6. **Consent is re-read before every model request.** The AI service must check consent (and that `subject_ref` is still the current one) immediately before each request to its provider, not only when a run starts; a failed check means no request. Implemented as `public.ai_consent_active(p_user, p_subject_ref)` (service-only, AI migration). A request already sent when consent is withdrawn is not recalled, but its result must be discarded (`ai_put_*` and `service_record_qualification` refuse without consent).
7. **Automatic assessment.** The browser may ask for an assessment right after a valid save of a professional category's four answers when consent is active, and when consent is switched on; the service deduplicates by `(category, answers_hash, question_version, rubric/policy version, model, bio)` and never re-spends for unchanged answers.
