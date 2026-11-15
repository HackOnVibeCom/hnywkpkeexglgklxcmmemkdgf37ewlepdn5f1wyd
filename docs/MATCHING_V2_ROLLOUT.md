# Matching v2 (Open vs Targeted testing + screening) — prerequisites, rollout and rollback

Status: **built and tested locally on branch `feat/matching-v2`. Migration 7 is NOT applied to production, the UI is NOT deployed, nothing is pushed or merged.** Every production step below needs the owner's explicit approval.

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
3. **Verify in the SQL editor:** paste [`docs/verify-migration7.sql`](verify-migration7.sql) (read-only). All `ok` values must be `true` (46 rows; 6 are `info`). Probe as anon: the new RPCs answer `42501 permission denied` (not `PGRST202`); existing RPCs unchanged; CAPTCHA still enforced; the public site unchanged.
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
