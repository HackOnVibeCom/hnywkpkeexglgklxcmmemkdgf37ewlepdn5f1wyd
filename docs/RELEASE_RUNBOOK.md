# UXBarter final release runbook (Matching v2 -> Experience Profile + AI)

Prepared 2026-11-15 from the exact release code (see "Release identifiers"). **Nothing here has been executed.** Every production step needs the owner's explicit approval. `<PROJECT_REF>` = the 20-character Supabase project reference; `peer-probe` = the Vercel team.

## 1. The one rollout hazard, and how the order removes it

Migration 8 makes "four completed answers in at least one selected category" a requirement for **reserving any task**, and its screening RPCs now refuse (`screening_replaced`). Consequences:
* The **previous (Matching v2) UI cannot complete the new profile** and cannot screen, so it must never run against a database with migration 8.
* A **frontend rollback alone is not enough** after migration 8 (the old UI would meet the new gate): rollback = the SQL in section 8 **and** the UI promote.
* The **new UI degrades cleanly against a database without migration 8** (it detects the missing `get_my_experience` and behaves like today; covered by the browser suites that run with the stub in "v2" mode). Hence: **deploy the UI first, then the migrations.** There is no moment at which an old UI meets the new gate.
* Existing testers keep profiles/credits; those who never wrote answers cannot start a **new** task until they do (one banner, ~2 minutes). General categories are active at once; professional ones are pending, but pending professionals **can still take open tasks** (a pending category counts for profile completion), so nobody is blocked by the AI service being off or down. Targeted professional tasks stay unavailable until a valid assessment (no temporary approval, by design).
* In-progress reservations survive (the trigger only fires when a reservation window is created/re-created). Tested on a populated database, see section 4.

## 2. Release identifiers
* `main` = `7ec44bb` (an ancestor of both branches: no divergence, the merged tree equals the AI branch tree).
* PR #3 `feat/matching-v2` @ `2eaf7163eb610676742056735b8fd78e8668f585` (migration 8 blob sha256 `31cda72b563f62b88aa297a9e6db5e7e1ee65e1d65062c6110075330baed53f4`).
* PR #4 `feat/ai-integration` (see the report for the final commit after the release-prep push).
* Merge with **merge commits, not squash** (so #4's history stays clean after #3 lands).
* No GitHub checks exist (`statusCheckRollup` is empty): the **release gate is the independent test run** in section 4, re-run on the final commit.

## 3. Order (smallest window; every step reversible as shown in section 8)

| # | Step | Command / action | Verify |
|---|---|---|---|
| 0 | Pre-flight (read-only) | SQL below (pre-check); `npx supabase db push --dry-run --project-ref <PROJECT_REF>` must list **exactly** the three migrations 000300, 000500, 000600 | list is exact; sha256 of migration 8 matches |
| 1 | Merge | PR #3 -> `main` (merge commit); `gh pr edit 4 --base main`; mark #4 ready; merge (merge commit) | `git log origin/main` shows both |
| 2 | **Deploy UI first, AI flag OFF** | from a clean checkout of `main`: `npm ci && npm run build`; make sure the Vercel Production env has **no** `VITE_AI_MATCHING`; `npx vercel deploy --prod --scope peer-probe` (prefix `MSYS_NO_PATHCONV=1` in Git Bash) | site loads; Discover works as today; Profile page works as today (no questions yet) |
| 3 | **Apply migrations 8 -> 9 -> 10** (one push, seconds) | `npx supabase db push --project-ref <PROJECT_REF>` | run `docs/verify-migration8.sql` (all `true`), then `docs/verify-migrations-9-10.sql` (all `true`); anon probe of the new RPCs answers 42501 |
| 4 | Real-browser check, fresh anonymous session | Profile -> tick Students -> answers -> **Active** -> Discover offers an open task and Start works; tick Tech-Savvy -> answers -> **Pending**; targeted pro task "qualification required"; open tasks still start; consent toggle | all as stated |
| 5 | **Edge Function, AI disabled** | `npx supabase functions deploy ai-match --project-ref <PROJECT_REF>` (no secrets set, flags unset) | section 5 health checks: expected answers `401` / `unavailable` |
| 6 | Production OpenAI key (separate project, hard monthly budget) | `powershell -ExecutionPolicy Bypass -File scripts\set-prod-openai-secret.ps1 -ProjectRef <PROJECT_REF>` (hidden prompt; sets only the key) | `npx supabase secrets list` shows `OPENAI_API_KEY` (digest only) |
| 7 | pg_cron erasure sweep | SQL in section 6 | `select * from cron.job` |
| 8 | **Enable assessment** | `npx supabase secrets set AI_ASSESSMENT_ENABLED=true --project-ref <PROJECT_REF>` (wait ~1 min / next cold start) | hosted smoke (section 5) |
| 9 | **Enable recommendations** | `npx supabase secrets set AI_MATCHING_ENABLED=true --project-ref <PROJECT_REF>` | hosted smoke |
| 10 | **Show the AI interface** | set `VITE_AI_MATCHING=1` for **Production only** in Vercel (`npx vercel env add VITE_AI_MATCHING production --scope peer-probe`, value `1`), redeploy `npx vercel deploy --prod --scope peer-probe` | fresh anonymous browser: save professional answers + consent -> automatic assessment -> Qualified/Needs clarification; Discover "Recommended for you" |
| 11 | Watch | `ai_usage_global` (calls/tokens), OpenAI usage page, function logs (coarse codes only) | spend within the cap |

Optional shortcut (saves one deploy, slightly less conservative): set `VITE_AI_MATCHING=1` already in step 2. The UI then shows honest "not available" messages until steps 8-9 (tested: function 404 / `unavailable`). I recommend the two-deploy order above.

Pre-check SQL (read-only, before step 3):
```sql
select (select count(*) from public.tester_profiles)                                              as profiles_that_will_need_answers,
       (select count(*) from public.test_reservations where consumed_at is null and expires_at > now()) as live_reservations,
       (select count(*) from public.campaigns where status = 'open')                               as open_campaigns,
       (select coalesce(sum(credit_balance),0) from public.profiles)                               as total_credits;
```
Re-run after step 3: `live_reservations` and `total_credits` must be unchanged (apart from activity), `open_campaigns` unchanged.

## 4. Evidence (run on the release code)
`supabase/tests/release_rehearsal.mjs` (49 assertions): production-like settings (no default grants, automatic RLS), database at migrations 1-7 filled with legacy data (owners, open/targeted campaigns, testers with no profile / incomplete profile / an old multiple-choice pass / an in-progress reservation / finished tests), then **8, 9, 10 applied one at a time**: every existing table byte-identical, exactly five existing function bodies changed by migration 8 and none by 9-10, in-progress reservation still submits and is rewarded, credits and ledger conserved, the five journeys (incomplete, general complete, pending professional, qualified professional, consent withdrawn) behave as documented, every RPC called by the frontend and by the Edge Function exists with the right privileges, `verify-migrations-9-10.sql` is all true, and `docs/rollback-gate-to-migration7.sql` restores the five function definitions byte-for-byte. Plus the full suites listed in the report.
Assumption review after migration 8: the credit/lifecycle/referral suites use a test fixture that gives every new identity a completed profile (otherwise nobody could reserve); the participation rule itself is tested without the fixture in `experience.mjs`, `upgrade.mjs` and the rehearsal.

## 5. Hosted Edge function (not testable locally: first real validation is step 5)
Function `ai-match`, `verify_jwt = true` (`supabase/config.toml`) **and** `auth.getUser(token)` inside. Secrets: `OPENAI_API_KEY`, `AI_ASSESSMENT_ENABLED`, `AI_MATCHING_ENABLED` (anything but the literal `true` = off); optional `OPENAI_MODEL` (default `gpt-6-luna`), `OPENAI_REASONING_EFFORT` (`low`), `AI_USER_DAILY_CALLS` (12), `AI_GLOBAL_DAILY_CALLS` (1500), `AI_GLOBAL_DAILY_TOKENS` (5000000), `AI_MIN_RUN_INTERVAL_SECONDS` (15), `AI_ALLOWED_ORIGINS` (default both production hosts). `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform. Never set `OPENAI_BASE_URL` in production (it is ignored unless loopback anyway). Logs contain coarse codes only (no prompts, answers or ids).

Health checks after step 5 (AI still off; no OpenAI cost):
```bash
URL=https://<PROJECT_REF>.supabase.co/functions/v1/ai-match
# 1. CORS preflight from the production origin -> 204 with allow-origin
curl -si -X OPTIONS "$URL" -H "Origin: https://uxbarter.vercel.app" -H "Access-Control-Request-Method: POST" | head -8
# 2. no token -> 401
curl -si -X POST "$URL" -H "Content-Type: application/json" -d '{"action":"recommend"}' | head -1
# 3. a REAL anonymous user's access token (from a browser session: localStorage sb-*-auth-token -> access_token) -> 200 {"status":"unavailable"} while flags are off
curl -s -X POST "$URL" -H "Authorization: Bearer <USER_ACCESS_TOKEN>" -H "apikey: <ANON_KEY>" -H "Content-Type: application/json" -d '{"action":"recommend"}'
```
**Known hosted risk:** if check 3 returns 401 from the platform gateway for a valid user token (projects on asymmetric "JWT signing keys" are not accepted by the legacy `verify_jwt` gate), set `verify_jwt = false` for `ai-match` in `supabase/config.toml` and redeploy (`npx supabase functions deploy ai-match --no-verify-jwt --project-ref <PROJECT_REF>`). Security is unchanged: the function itself verifies every token with `auth.getUser` and rejects anything else (tested: garbage / unknown-user tokens -> 401).
If the preflight in check 1 is rejected by the gateway, the same switch applies.

Hosted smoke after steps 8-9 (a real anonymous browser identity; needs the Turnstile check): consent on -> save four professional answers -> the panel shows Processing then Qualified / Needs clarification (about 3-10 s) -> Discover "Recommended for you". One identity costs about $0.001. Compare `select * from public.ai_usage_global order by day desc limit 1;` with the OpenAI usage page.

## 6. Scheduled erasure (pg_cron)
`ai_apply_erasure_events()` is safe to run from pg_cron: it is `SECURITY DEFINER`, takes no required arguments, returns immediately if another sweep holds the cursor row (`for update skip locked`), only deletes AI-derived rows whose consent is gone, and does nothing when there is nothing to do. The Edge Function also runs it at the start of every request, so cron only guarantees erasure with no traffic or with the kill switches off. **Not testable locally** (PGlite has no pg_cron): run once manually first.
```sql
-- Supabase: enable pg_cron under Database -> Extensions (or: create extension if not exists pg_cron;)
select public.ai_apply_erasure_events();                       -- manual run, must return an integer
select cron.schedule('ai-erasure-sweep', '* * * * *', $$select public.ai_apply_erasure_events()$$);
select jobid, jobname, schedule, active from cron.job where jobname = 'ai-erasure-sweep';
-- later: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname='ai-erasure-sweep') order by start_time desc limit 5;
-- remove: select cron.unschedule('ai-erasure-sweep');
```

## 7. Cost controls and kill switches
Per-user 12 requests/day (shared by both actions), 15 s throttle, global 1500 requests and 5M tokens per day, all reserved atomically BEFORE spend; typical run ~1.5k tokens in / 0.5k out (about $0.0003); worst case at the global cap well under a few dollars/day; plus the OpenAI project's own hard monthly budget (set it to a few dollars). Kill switches, fastest first:
1. `npx supabase secrets set AI_MATCHING_ENABLED=false AI_ASSESSMENT_ENABLED=false --project-ref <PROJECT_REF>` (UI shows "not available"; every list and the whole app keep working; recorded decisions stay).
2. Unset `VITE_AI_MATCHING` in Vercel Production and redeploy (zero AI requests from the browser).
3. `npx supabase functions delete ai-match --project-ref <PROJECT_REF>`.
4. Revoke the OpenAI key / delete the OpenAI project.

## 8. Rollback (tested)
| Problem | Action | Data |
|---|---|---|
| AI misbehaves / cost | kill switches 1-4 above | none |
| Bad UI (new UI, DB already migrated) | `npx vercel rollback` to the **previous new-UI deployment**, or redeploy the last good commit | none |
| Gate blocks too many testers / must return to the old UI | **run `docs/rollback-gate-to-migration7.sql`** in the SQL editor (one transaction: restores the five migration-7 function bodies byte-for-byte; tested), **then** promote the previous Matching v2 deployment (`dpl_...` recorded in `docs/MATCHING_V2_ROLLOUT.md`) | nothing deleted: answers, consents, decisions, caches, credits stay |
| Re-apply later | re-run only the five `create or replace function` statements of migration 8 | |
**Never** promote the old UI without running the SQL rollback first when migration 8 is applied. Dropping the new tables is not needed and destroys tester answers (needs explicit approval).

## 9. Go / no-go criteria
GO for steps 2-4 (UI + migrations) when: the dry-run lists exactly three migrations, sha256 matches, section-4 tests pass on the final commit. GO for steps 5-10 (AI) only after the hosted health checks pass. If the hosted function cannot be validated tonight, **ship steps 1-4 only** (Experience Profile live, AI off, `VITE_AI_MATCHING` unset): professional categories then stay pending and targeted professional tasks unavailable, everything else works; or, if even that is too risky, keep Matching v2 as is (nothing is applied until step 3).
