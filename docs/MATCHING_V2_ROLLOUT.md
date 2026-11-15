# Matching v2 (Open vs Targeted testing + screening) — prerequisites, rollout and rollback

Status (2026-11-15): migration 7 **is applied** to production (verified 40/40) and the Matching v2 UI **is deployed** (`dpl_AzY1pReTyQf2xw1Hn8RdXvEHVx6A`, commit `3afe364`); PR #3 is open and **not merged**. The follow-up in the last section, **migration 8 (experience profile: four open-ended answers, qualification, AI consent) and the UI that uses it, is built and tested locally only: NOT applied, NOT deployed, not committed.** Every production step needs the owner's explicit approval.

## What ships

| Layer | Change |
|---|---|
| Database | Migration `supabase/migrations/20261115000200_matching_v2.sql` (sha256 `43ba4299347b8a6c35689a90c0eb507f43a607d7db1c55812550b9c0f1795a03`). **No existing function body is changed** (the upgrade rehearsal compares 23 public functions by md5 before/after). Adds: `campaigns.testing_mode` (`open` default / `targeted`), three RLS-locked tables (`screening_versions`, `screening_questions`, `screening_attempts`), a trigger on `test_reservations` that enforces eligibility, six client RPCs and five internal helpers. |
| Frontend | "Who can take this test?" (Open / Targeted) on *Request a test*; Discover cards say Open or Targeted and are Recommended / Eligible / Not eligible; the task page explains *why* a tester cannot start; the Profile page shows screening status and hosts the self-reported screening. Degrades to Matching v1 behaviour if the migration is missing. |
| Not touched | Supabase Auth / CAPTCHA settings, Cloudflare, Vercel protection/domains/env, the HackOnVibe workflow, migrations 1–6, `start_test` / `submit_test`, credits, reservations (15 min), the 60 s minimum, the 5-per-24 h reward cap, referrals, expiry, refunds. |

## Product rules (all enforced in PostgreSQL)

* **Open testing** — any eligible tester can take it. Optional categories are only a *recommendation* (Matching v1). Every existing campaign — including those created with v1 "preferred categories" — is `open` after the migration; nothing is silently restricted.
* **Targeted testing** — the founder picks ≥ 1 *required* category (the `target_categories` column, now meaning "required" for `targeted`). A tester is eligible when their profile contains **at least one** required category **and**, for that category:
  * *Students & Learners*, *Everyday & Non-Technical Users* (general): nothing more;
  * *Tech-Savvy Users*, *Founders & Product Builders*, *Business & Office Users* (professional): a completed screening at the **current screening version**.
* A non-eligible tester can **view** a targeted task (it is listed, flagged "Not eligible: …", with a "See requirements" page) but a **reservation cannot be created**: a trigger on `test_reservations` raises `not_eligible` (detail = `no_profile` | `category_mismatch` | `screening_required`). It fires when a reservation window is created (first reserve, or re-reserving a lapsed reservation) and **never** on a live reservation or on submit, so editing the profile mid-test cannot break a valid in-progress test, and `submit_test` still needs a live reservation, so there is no way around `start_test`.
* **Screening** — 4 short experience-based questions per professional category (practical activities, real tools, real work; no trivia, no demographics). Passing = hands-on experience reported in **at least 2 of the 4 areas**. It is **self-reported and not a verified credential**: the UI says "Screened — self-reported experience". Only the outcome is stored (category, version, passed, number of areas, time); **answers are evaluated and discarded**. Abuse controls: 3 attempts per category per rolling 24 h (serialised with an advisory lock), malformed submissions never consume an attempt, a screened tester cannot re-submit at the same version, a new screening version invalidates old passes. Changing the profile cannot bypass it: a professional category needs the screening *and* the category in the profile; removing the category removes eligibility; the screening persists if it is re-added.

## Deployment prerequisites (checklist)

1. Owner approval for each step below; PR `feat/matching-v2` → `main` open and CLEAN (merge commit, not squash).
2. Local gate green: `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:db`, `npm run test:browser`, `node tests/browser/csp-check.mjs`, `node tests/browser/brand-check.mjs`; secret scan clean.
3. `supabase db push --dry-run --remote` lists **exactly** `20261115000200_matching_v2.sql`; file sha256 = the value above (re-check, it must match the tested file).
4. Baseline: note row counts and `select coalesce(sum(delta),0)` vs `sum(credit_balance)`.
5. Previous production deployment recorded for rollback (currently `dpl_AzqhfYDFpBA3DuxMoguyES33dQav`, Matching v1).
6. Apply order: **migration first, UI second.** The old UI keeps working after the migration (it only calls RPCs that are unchanged). The new UI also works before it (falls back to v1), so a wrong order cannot break the site.

## Ordered plan (each numbered step = one approval)

1. Open the PR (do not merge).
2. **Apply migration 7:** `supabase db push --remote --yes` (additive; DDL only; one brief lock on `campaigns` for the `ALTER TABLE`, 20 rows).
3. **Verify in the SQL editor:** paste [`docs/verify-migration7.sql`](verify-migration7.sql) (read-only). All checks must be `true` (46 rows: 40 checks that must read `true`, and 6 `info` rows whose `ok` is NULL by design and only show counts; any `false` = stop). The query is a single SELECT, verified read-only (it also runs inside a READ ONLY transaction without error); run it right after applying the migration or later (check 33 only looks at campaigns that existed before the migration). Probe as anon: the new RPCs answer `42501 permission denied` (not `PGRST202`); existing RPCs unchanged; CAPTCHA still enforced; the public site unchanged.
4. **Deploy the UI:** `npx vercel deploy --prod --scope peer-probe` from the clean reviewed commit; verify routes, bundle (contains "Targeted testing", "Experience screening", `list_campaigns_v2`), headers, protection, clean-room build match.
5. **Manual smoke test in real browsers** (needs the real Turnstile): identity A requests a *targeted* test for Tech-Savvy Users (1 credit); identity B (profile Tech-Savvy, **not screened**) sees it as *Not eligible: screening needed*, the task page shows the panel and no Reserve button; B completes the screening → the task becomes Recommended and B can reserve and finish (+1 credit); identity C with only *Students & Learners* sees "Not eligible: your profile does not match"; an *open* task stays available to everyone; edit B's profile mid-test and confirm the test can still be submitted.
6. Merge the PR (merge commit).

## Rollback

| Situation | Action | Data impact |
|---|---|---|
| UI misbehaves | Promote the previous deployment (`vercel promote` / dashboard). Instant. The old UI ignores every v2 object. | None |
| Bad merge | `git revert -m 1 <merge commit>` (never force-push). | None |
| Database problem (unlikely) | Prefer to **leave migration 7 in place**. Only with explicit approval, run the down script below. | Drops screening results and the targeted/open flag |

Known transient limitation after a **UI-only** rollback: a *targeted* campaign (created by the new UI) is shown by the old UI as an ordinary task; an ineligible tester who presses Start gets the raw `not_eligible` message instead of the explanation. Nobody can reserve it, so nothing is bypassed.

Down script (SQL editor, only if it must go; run as one script):

```sql
drop trigger if exists test_reservations_eligibility on public.test_reservations;
drop function if exists public.create_campaign_v2(text, text, text, text, text, text[]);
drop function if exists public.list_campaigns_v2();
drop function if exists public.get_campaign_eligibility(uuid);
drop function if exists public.get_screening(text);
drop function if exists public.submit_screening(text, jsonb);
drop function if exists public.get_my_screening_status();
drop function if exists public.enforce_campaign_eligibility();
drop function if exists public.tester_eligibility(uuid, text, text[]);
drop function if exists public.is_screened(uuid, text);
drop function if exists public.screening_current_version(text);
alter table public.campaigns
  drop constraint campaigns_targeted_requires_categories,
  drop constraint campaigns_testing_mode_check,
  drop column testing_mode;            -- targeted campaigns become open (their required categories remain as preferences)
drop table public.screening_attempts;
drop table public.screening_questions;
drop table public.screening_versions;
drop function if exists public.category_requires_screening(text);
```

## Security review notes

* New RPCs: `SECURITY DEFINER`, `search_path = ''`, `EXECUTE` for `authenticated` only, every access scoped by `auth.uid()`; helpers revoked from everyone (catalog-checked in the tests and in the verification SQL).
* The three screening tables have RLS on, no policy and no grant. Screening answers are never stored. `get_my_screening_status` only returns the caller's own rows.
* A pass cannot be forged: clients cannot insert into `screening_attempts`, cannot change `campaigns.testing_mode`, and eligibility is evaluated by the database trigger, not by the UI.
* `create_campaign_v2` validates mode and categories **before** any credit moves, then reuses the unchanged `create_project_with_campaign`.
* Existing data: constant defaults only (no table rewrite); the migration compares equal to the previous state for all 23 pre-existing functions.

## Limitations (honest list)

* Screening is **self-reported**; a determined person can claim experience. It is a speed bump and an expectation-setter, not verification, and the UI never calls it verified. General categories (Students, Everyday) are self-declared by design.
* A targeted task can only be taken by matching testers; with a small marketplace it may wait the full 7 days and then be refunded. The Create page says so.
* Profile and screening writes rely on Supabase's API-level rate limits plus the 3-attempt screening limit.
* Questions are English-only and fixed at version 1; a content change is a new screening version (a new migration) and re-screens everyone.
* Founders are not told which category a responding tester used (tester anonymity on small pools) — deferred.
* No AI is involved anywhere in matching or screening; no AI API is called.

## Deferred

AI-assisted features (a separate planned phase), founder-side "matched tester" indicator, per-category supply hints, a real-project end-to-end script (needs a CAPTCHA token path), localisation of the screening.


---

# Migration 8: experience profile (four open-ended answers), qualification, AI consent

Status: **built and tested locally; NOT applied, NOT deployed, nothing committed or pushed.** It supersedes the earlier, never-applied "active vs pending" draft (that draft file was removed; migration 7 is live and untouched). Written contract for the AI workstream: [AI_INTEGRATION_CONTRACT.md](AI_INTEGRATION_CONTRACT.md).

## Product rules (all enforced in PostgreSQL)

* **Four open-ended questions for all five categories**, versioned, category specific, no multiple choice, no trivia, no skill assumption. Answers: 15–800 characters, whitespace-normalised, no control characters, ≥ 3 different words, the four answers must differ. Basic input validation only: it never judges the content.
* **Instant anonymous access is untouched.** Nobody is blocked from entering UXBarter, browsing, or **requesting** tests (creating campaigns) because of an incomplete profile.
* **Participation rule:** to **reserve any task** (open or targeted) and therefore earn credits, a tester needs the four answers for at least one *selected* category (current question version). Enforced by the existing reservation trigger (new body): a privileged INSERT that bypasses `start_test` is refused too. A pending professional category counts for this (it completes the profile); it does **not** count for matching.
* **General categories** (Students & Learners, Everyday & Non-Technical Users): **active** as soon as the answers are valid. No assessment, no credential check.
* **Professional categories** (Tech-Savvy, Founders & Product Builders, Business & Office): **pending** after the answers; **active only with a valid `qualified` decision**, which can only be written by the server-only assessment interface (`service_record_qualification`, `service_role` only) for the *exact* answers (sha256 + question version). Answers alone never qualify; editing the answers invalidates the decision; no timeout approves anybody. Until the AI assessment service exists, professional categories stay pending (explicit dependency, see "Blockers").
* **Categories are independent**; an incomplete one is never silently activated, and finishing one never changes another.
* **In-progress reservations are protected**: the trigger fires only when a reservation window is created/re-created. Deleting answers, changing categories or publishing a new question version mid-test cannot break a live reservation or its reward.
* **Consent:** AI processing is **off by default**; `set_ai_consent(true/false)`. The server-only interface hands out the bio and the answers only with consent. Nothing is sent to any AI service by this repository.
* **Privacy:** answers live in an owner-only table (RLS on, no policy, no client grant); the browser can only read its **own** answers via `get_experience_questions`; `get_my_experience` never contains answer text; no public listing contains answers. `delete_my_experience([category])` deletes answers and the assessment decisions about them; account deletion cascades.

## Migration `20261115000300_experience_profile.sql`

sha256 `31cda72b563f62b88aa297a9e6db5e7e1ee65e1d65062c6110075330baed53f4` (re-check before applying; `docs/verify-migration8.sql` sha256 `7949fbc3d80c0db5a966658eef5fc07f1edafb8854dd08ee765326437fbbcd11`).

| Object | Kind |
|---|---|
| `experience_questions`, `experience_answers`, `ai_consents`, `category_qualifications`, `experience_save_limits` (save-rate state, kept apart so deleting answers cannot reset it), `ai_erasure_events` (opaque erasure signals for the AI service) | **new tables**, RLS on, no policy, no client grant (FK to `profiles` with `on delete cascade`) |
| 20 question rows (5 categories × 4, version 1) | seed data |
| `experience_current_version`, `experience_complete`, `is_qualified`, `category_state`, `active_tester_categories`, `tester_participation_ready`, `normalize_experience_answers`, `experience_hash`, `experience_category_json` | **new internal** functions (EXECUTE revoked from clients) |
| `get_experience_questions`, `save_experience_answers`, `get_my_experience`, `set_ai_consent`, `delete_my_experience` | **new client RPCs** (authenticated only, `auth.uid()`-scoped, SECURITY DEFINER, `search_path = ''`) |
| `service_get_ai_profile`, `service_list_pending_assessments`, `service_record_qualification`, `service_list_eligible_campaigns`, `service_list_erasure_events` | **new server-only** functions (`service_role` only) |
| `log_erasure_on_profile_removed`, `log_erasure_on_consent_row_deleted` + two triggers (`tester_profiles` delete, `ai_consents` delete) | **new**: log erasure events when a profile is removed or an account is deleted |
| `tester_eligibility`, `enforce_campaign_eligibility`, `list_matched_campaigns` | **bodies replaced**, same signatures (eligibility over ACTIVE categories + participation rule; the trigger now applies to open campaigns too; the v1 feed recommends on active categories) |
| `get_screening`, `submit_screening` | **bodies replaced**: now raise `screening_replaced` (the multiple-choice rule can never create a pass again) |
| data | **none**: no backfill. Earlier multiple-choice passes stay in `screening_attempts` as history only and are not read by anything |

`start_test`, `submit_test`, credits, referrals, refunds, campaigns, CAPTCHA, anonymous auth: **untouched** (the upgrade rehearsal compares every public function by md5: exactly five existing bodies change, exactly twenty-one functions are added; every existing table row is byte-identical afterwards).

## Existing data and users (transition)

* No profile is rewritten or deleted. Existing testers keep their categories; they read as **incomplete** until they save four answers. Until then they **cannot reserve tasks** (this is the new rule), they can browse, request tests and complete their profile in a few minutes.
* **Earlier multiple-choice passes are not carried over.** They cannot activate a professional category or bypass the assessment (tested on a populated database): those testers complete the four answers and wait for the assessment like everybody else.
* Existing campaigns (open, v1-preferred-category, targeted) are unchanged. In-progress reservations are unchanged (tested: reserved before the migration with no answers, still submits and is rewarded afterwards).
* The old UI after the migration: its screening calls fail with `screening_replaced`; **an old UI cannot complete the new profile**, so it must not stay deployed with migration 8 applied (see order).

## Ordered plan (each step needs approval)

1. Commit/push (nothing deployed). Update PR #3.
2. `npx supabase db push --dry-run --remote` must list **exactly** `20261115000300_experience_profile.sql`; verify the sha256.
3. **Deploy the UI first** (`npx vercel deploy --prod --scope peer-probe`): it detects the missing `get_my_experience` and behaves like the current release (tested), so nothing changes for users yet and there is **no window in which an old UI meets the new gate**.
4. **Apply migration 8** (`npx supabase db push --remote --yes`), then immediately run [`docs/verify-migration8.sql`](verify-migration8.sql) (read-only single SELECT, 59 rows: 52 must be `true`, 7 are `info` counts incl. how many existing testers now have to complete their answers). Probe as anon: new RPCs answer `42501`.
5. Manual smoke test in real browsers: new identity → Profile → tick Students → save → answer four questions → Active → Discover shows eligible tasks and a reservable open task; tick Tech-Savvy → answers → "Pending assessment", targeted tech task "Qualification required", open tasks still work; consent toggle on/off; edit/delete answers; an identity with no answers cannot start a task (message + link to the profile); in-progress test unaffected.
6. Merge PR #3 (merge commit).

## Rollback

| Situation | Action | Data |
|---|---|---|
| UI misbehaves | promote the previous deployment **and** relax the gate in the same step (below); the old UI cannot complete a profile | none |
| Gate too strict for the demo / launch | re-run the `CREATE OR REPLACE` of `enforce_campaign_eligibility` and `tester_eligibility` from `20261115000200_matching_v2.sql` (restores "open tasks need nothing"); keep every table and the new UI | none |
| Full database revert | not needed and not recommended (additive); the new tables can stay empty. Dropping them destroys tester answers and needs explicit approval | answers |

## Risks and limitations (honest list)

* **Biggest behaviour change:** every tester (new or existing) must write four short answers before they can reserve their first task. That is the requested rule, but it reduces supply on a small marketplace and adds friction for judges/first-time visitors. One rollback statement relaxes it (above).
* **Professional categories cannot become active until the AI assessment service exists** (and only for testers who consent). Until then targeted tasks for those categories are unavailable to everyone. Honest UI wording; no temporary approval was invented.
* Answers are self-reported free text; nothing verifies employment, identity or qualifications, and no wording claims it. Answers are stored (consent only governs sending them to an AI service); they are deletable by the owner.
* A prompt-injection risk exists for whoever feeds answers to a model (documented for the AI workstream).
* Per-row cost: `tester_eligibility` now evaluates a handful of indexed lookups per open campaign per Discover call (the active-category set is one set-based query, tested equivalent to the per-category state); bounded by open campaigns, to revisit with hundreds of open tasks.
* Rate limit: 5 saves per category per fixed 24 h window, stored apart from the answers so that **deleting answers does not reset it** (found by the security review; tested). It bounds assessment triggers per identity only: anonymous identities are free, so the assessment service needs its own global budget. Question content is English-only, version 1; a content change is a new question version (everyone's answers become "outdated" and must be reviewed).

## Blockers that need the AI workstream

* The assessment decision itself (and its policy for borderline answers) via `service_record_qualification`.
* The recommendation endpoint behind `fetchRecommendations()` (Discover shows an honest "not available yet" meanwhile).
* Server-side secrets, spend limits and prompt-injection hardening on their side.
