# Handoff to the AI workstream ("Agent #3")

From: the profile / qualification workstream (branch `feat/matching-v2`, migration 8 `20261115000300_experience_profile.sql`). **Nothing here is applied or deployed.** I did not edit your working directory or branch; I read `feat/ai-matching` (commit `d076c99`) through git only, to list the mismatches in §9.

Take these two files as the contract (they are the source of truth; this page is the quick reference):

* [`docs/AI_INTEGRATION_CONTRACT.md`](AI_INTEGRATION_CONTRACT.md) — rules, states, server-only interface, behaviour when the AI is unavailable, consent withdrawal and deletion.
* [`src/lib/aiContract.ts`](../src/lib/aiContract.ts) — TypeScript types, no imports, no secrets.

## 1. RPC names and signatures

Server-only (**`service_role` only**; call from your Edge Function with the service key; never from the browser):

| Function | Returns |
|---|---|
| `service_get_ai_profile(p_user_id uuid)` | `jsonb` `AiProfileV1`, or `null` for an unknown user |
| `service_list_pending_assessments(p_limit integer default 50)` | rows `(user_id uuid, subject_ref uuid, category text, question_version integer, answers_hash text, answers_updated_at timestamptz)` |
| `service_record_qualification(p_user_id uuid, p_category text, p_question_version integer, p_answers_hash text, p_status text, p_assessment jsonb default null)` | `jsonb` category status |
| `service_list_eligible_campaigns(p_user_id uuid)` | rows `(campaign_id, project_name, description, task_description, created_at, expires_at, testing_mode, target_categories, match_categories, reserved_by_me)`; **empty unless the tester consented** |
| `service_list_erasure_events(p_after_id bigint default 0, p_limit integer default 200)` | rows `(id bigint, subject_ref uuid, reason text, category text, created_at timestamptz)` |

Browser-callable (authenticated, scoped to the caller; already in the UI): `get_my_experience()`, `get_experience_questions(p_category text)`, `save_experience_answers(p_category text, p_answers jsonb)`, `set_ai_consent(p_granted boolean)`, `delete_my_experience(p_category text default null)`; existing and unchanged in shape: `list_campaigns_v2()`.

## 2. Experience-answer structure (inside `AiProfileV1.categories[]`)

```json
{
  "category": "tech_savvy", "kind": "professional", "selected": true,
  "state": "pending_assessment",
  "question_version": 1, "answers_version": 1, "answers_complete": true,
  "answers_hash": "<64 hex>", "answers_updated_at": "2026-11-15T10:00:00Z",
  "answers": [ { "question_id": "q1", "question": "<exact text of version answers_version>", "answer": "<15-800 chars>" }, "… q2, q3, q4" ],
  "qualification": null
}
```

`answers` is non-null only when **consent is granted AND the category is selected AND the four answers are complete**. Always five categories, canonical order: `tech_savvy, founders_builders, business_office, students_learners, everyday_nontechnical`. The nickname is never included. Top level: `contract_version` (=1), `subject_ref`, `consent`, `profile {bio, categories, updated_at}`, `categories`, `active_categories`, `participation_ready`, `updated_at`, `etag`.

## 3. Versions

* `question_version` = the **current** question version of that category (today 1). `answers_version` = the version the stored answers were written for. If they differ the category is `incomplete` ("questions were updated") and `answers` is `null`.
* A new question version is a new set of exactly four questions; incomplete sets are ignored by the database. Prompts you build must use the `question` text delivered with the answers, not a copy.

## 4. Consent rules

* Default **off**. Written only by the tester via `set_ai_consent(true|false)`.
* `service_get_ai_profile` returns **no bio, no answers and no `subject_ref`** without consent; `service_list_pending_assessments` omits the tester; `service_list_eligible_campaigns` is empty; `service_record_qualification` raises `consent_required`.
* Send nothing to a third party without `consent.ai_processing === true` **at request time** (re-read it on every request). Only `subject_ref` may identify a tester to a third party.

## 5. Assessment decision schema (`public.category_qualifications`, one row per tester × professional category)

`status` `qualified|not_qualified`; `source` always `ai_assessment`; `question_version` and `answers_hash` = exactly those of the assessed answers; `assessment` optional `{model, rubric_version, summary ≤ 500 chars, confidence}` ≤ 4 KB (never answer text); `decided_at` set by the database. Earlier multiple-choice passes do **not** exist in this table and never count.

## 6. How the server records a qualified decision

```ts
// service-role client, on YOUR server, after reading service_get_ai_profile(sub)
const cat = profile.categories.find(c => c.category === 'tech_savvy');   // state === 'pending_assessment'
await supabase.rpc('service_record_qualification', {
  p_user_id: sub, p_category: cat.category,
  p_question_version: cat.question_version, p_answers_hash: cat.answers_hash,   // taken from what you assessed
  p_status: 'qualified',
  p_assessment: { model: '<id>', rubric_version: 'r1', summary: '<short, no quotes of answers>' },
});
```
Errors: `invalid_status`, `category_not_assessable` (general categories are never assessed), `consent_required`, `stale_assessment` (answers/version changed: re-read and decide again), `invalid_assessment`. Nothing else can make a professional category `active`; no timeout, no default.

## 7. Profile change and cache invalidation

* Cache key = `etag` (changes on any change of consent, `subject_ref`, bio, categories, answers or decisions). Do not serve a cache entry whose `etag` differs.
* Editing an answer changes `answers_hash`: any decision for the old hash stops counting immediately and the category returns to `pending_assessment`. Changing categories changes `profile.categories`/`selected`. A new question version makes answers outdated.
* Eligibility is **not** cacheable: re-read `list_campaigns_v2()` under the caller's JWT (or `service_list_eligible_campaigns`) on every request. A tester can only reserve what the database allows; recommendations never grant access.

## 8. Consent withdrawal and deletion

* On withdrawal the database stops handing out data immediately (§4). You must also delete what **you** hold for that tester: poll `service_list_erasure_events` with your own cursor and, for every `subject_ref`, delete cached profiles, derived summaries/embeddings, recommendation caches and anything retained at the model provider (reasons: `consent_withdrawn`, `answers_deleted` (category or all), `profile_removed`, `account_deleted`). Delete first, then advance the cursor.
* `delete_my_experience` deletes answers and the assessment decisions made about them; account deletion cascades to answers, consent and decisions.

## 9. Mismatches with the current Agent #3 adapter (`feat/ai-matching` @ `d076c99`) and proposed resolutions

| # | Mismatch | Proposed resolution |
|---|---|---|
| 1 | **Response shape.** Yours: `{status, recommendations[{campaign_id, verdict, explanation, evidence[], unsupported_requirements[]}], evaluated, from_cache, understanding}` with statuses `ok / consent_required / insufficient_profile / rate_limited / busy / budget_reached / unavailable`. Mine (`RecommendationsResponse` in `aiContract.ts`): `{status:'ok', items[{campaign_id, reason, score?}], …}` with statuses `unavailable / consent_required / profile_incomplete`. | Adopt **your** shape (you said so in `docs/AI_MATCHING.md`): I will change `RecommendationsResponse`/`actionableRecommendations` to it on request; the contract's data side (`AiProfileV1`) is unaffected. Needs a decision before integration. |
| 2 | **Discover.tsx collision.** You mount `<AiRecommendations/>` + `BrowseAllHeading` into the old Discover. My Discover is rewritten (tabs "Recommended for you" / "Browse all eligible tests", provider seam `fetchRecommendations`, `actionableRecommendations`, "Not available to you yet" section). A textual merge will conflict. | Render your component as the body of my "Recommended for you" tab (it already handles consent / empty / unavailable states) and keep my eligibility filter; drop your `BrowseAllHeading` (my tab is that heading). |
| 3 | **Two consent UIs.** Mine: `ConsentCard` on the Profile page (purposes: recommendations + professional assessment). Yours: opt-in inside the recommendations block. Both call `set_ai_consent` (same signature, no collision). Yours also calls `delete_my_ai_data()` after switching off; mine does not (I do not know your table). | Keep one canonical card (Profile) and let your block link to it, or make both call a shared helper that also calls `delete_my_ai_data()`. Align the copy: my text also states that consent is needed for the professional **assessment**. |
| 4 | **Erasure keying.** Your caches are keyed by `user_id` and purged lazily on the next request (`ai_purge_user`). My erasure log is keyed by the opaque `subject_ref` (so no account id lives in a log that outlives the account). If a tester withdraws and never returns, your rows linger. | Store the `subject_ref` you were given (from `service_get_ai_profile`) in your cache rows (`ai_profile_analyses`, `ai_match_cache`), poll `service_list_erasure_events`, purge by `subject_ref`. (Alternative if you prefer user ids: ask me to add `user_id` to the events; I advise against it.) `delete_my_ai_data()` can stay as the immediate user-triggered path. |
| 5 | **Participation rule.** Since migration 8 a tester without a completed category cannot reserve any task, so `list_campaigns_v2()` returns every row with `eligible=false`, reason `profile_incomplete`. Your `insufficient_profile` is text-length based. | Also read `participation_ready` from the contract and return `insufficient_profile` when it is `false` (the Discover seam shows the right message either way). |
| 6 | **`service_list_eligible_campaigns`** (my interface) now requires consent and returns only eligible rows; you use `list_campaigns_v2()` under the caller's JWT instead. | Both are valid; yours keeps the caller's own verdict. No change needed. |
| 7 | **Professional assessment has no owner.** Your doc scopes assessment out ("the AI here never decides or influences qualification"). Nobody consumes `service_list_pending_assessments` / `service_record_qualification`. | **Blocker for professional categories** (they stay pending for everyone). Needs an owner and an approved policy, separate from recommendations. |
| 8 | **Copy flagged in your doc**: "Profile.tsx … is only used to order the task list" — already updated on my side (it now says nothing is sent to an AI service unless AI personalization is on). README still says "No AI is involved" for matching; reword when both merge. | Mine done (Profile); README on merge. |
| 9 | **Compatible as is:** `contract_version === 1`; `consent.ai_processing`; `profile.bio/categories`; `categories[].answers[{question, answer}]` (you filter to selected categories; the database now also withholds answers of unselected categories); answer limit 800 / bio 280; migration numbering (`…000300` vs `…000500`, no table or function name collides: yours are `ai_profile_analyses`, `ai_match_cache`, `ai_usage*`, `ai_*` RPCs, `delete_my_ai_data`). | none |
| 10 | **Unverified on both sides:** your Edge Function has never run under Deno; my interface has never run against the production database (tested on a local Postgres). | Run both end-to-end on a throwaway project before any real call. |

## 10. Order of integration (all steps need the owner's separate approval)

PR #3 (migration 8 + UI) → your migration `20261115000500` → configure secrets → Edge Function → smoke test with one throwaway identity → enable. Migration 8 must be applied before your function can read `service_get_ai_profile`; until then your block shows "not available".
