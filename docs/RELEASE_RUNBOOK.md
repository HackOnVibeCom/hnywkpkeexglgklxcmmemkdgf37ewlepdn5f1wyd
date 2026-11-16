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
| 0 | Pre-flight (read-only) | SQL below (pre-check); `npx supabase db push --dry-run --remote` must list **exactly** the three migrations 000300, 000500, 000600 | list is exact; sha256 of migration 8 matches |
| 1 | Merge | PR #3 -> `main` (merge commit); `gh pr edit 4 --base main`; mark #4 ready; merge (merge commit) | `git log origin/main` shows both |
| 2 | **Deploy UI first, AI flag OFF** | from a clean checkout of `main`: `npm ci && npm run build`; make sure the Vercel Production env has **no** `VITE_AI_MATCHING`; `npx vercel deploy --prod --scope peer-probe` (prefix `MSYS_NO_PATHCONV=1` in Git Bash) | site loads; Discover works as today; Profile page works as today (no questions yet) |
| 3 | **Apply migrations 8 -> 9 -> 10** (one push, seconds) | `npx supabase db push --remote` | run `docs/verify-migration8.sql` (all `true`), then `docs/verify-migrations-9-10.sql` (all `true`); anon probe of the new RPCs answers 42501 |
| 4 | Real-browser check, fresh anonymous session | Profile -> tick Students -> answers -> **Active** -> Discover offers an open task and Start works; tick Tech-Savvy -> answers -> **Pending**; targeted pro task "qualification required"; open tasks still start; consent toggle | all as stated |
| 5 | **Edge Function, AI disabled** | `npx supabase functions deploy ai-match --remote` (no secrets set, flags unset) | section 5 health checks: expected answers `401` / `unavailable` |
| 6 | Production OpenAI key (separate project, hard monthly budget) | `powershell -ExecutionPolicy Bypass -File scripts\set-prod-openai-secret.ps1 -ProjectRef <PROJECT_REF>` (hidden prompt; sets only the key) | `npx supabase secrets list` shows `OPENAI_API_KEY` (digest only) |
| 7 | pg_cron erasure sweep | SQL in section 6 | `select * from cron.job` |
| 8 | **Enable assessment** | `npx supabase secrets set AI_ASSESSMENT_ENABLED=true --remote` (wait ~1 min / next cold start) | hosted smoke (section 5) |
| 9 | **Enable recommendations** | `npx supabase secrets set AI_MATCHING_ENABLED=true --remote` | hosted smoke |
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
**Known hosted risk:** if check 3 returns 401 from the platform gateway for a valid user token (projects on asymmetric "JWT signing keys" are not accepted by the legacy `verify_jwt` gate), set `verify_jwt = false` for `ai-match` in `supabase/config.toml` and redeploy (`npx supabase functions deploy ai-match --no-verify-jwt --remote`). Security is unchanged: the function itself verifies every token with `auth.getUser` and rejects anything else (tested: garbage / unknown-user tokens -> 401).
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
1. `npx supabase secrets set AI_MATCHING_ENABLED=false AI_ASSESSMENT_ENABLED=false --remote` (UI shows "not available"; every list and the whole app keep working; recorded decisions stay).
2. Unset `VITE_AI_MATCHING` in Vercel Production and redeploy (zero AI requests from the browser).
3. `npx supabase functions delete ai-match --remote`.
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


## 10. Lessons from the PHASE 1 execution (2026-11-15) - read before PHASE 2
* **Supabase CLI 3.x** targets the LOCAL stack by default: always add `--remote` (`db push --dry-run --remote`, `db push --remote --yes`, `db query --remote ...`, `backups list`). Run `npx supabase link --project-ref zrzkacgarquzbemsnosw` once per checkout (writes only the git-ignored `supabase/.temp`). Production project = **peerprobe** (`zrzkacgarquzbemsnosw`); the other project in the account (Growthkit) is inactive and unrelated.
* `supabase db query --remote --read-only` runs as `supabase_read_only_user`, which (correctly) cannot execute the internal helpers that migration 8 revoked from clients, so `docs/verify-migration8.sql` and `docs/verify-migrations-9-10.sql` must be run with the owner login: `npx supabase db query --remote --yes --file docs/verify-migration8.sql` (both files are single SELECTs; grep them for write keywords first). In agent mode the CLI refuses any non-`--read-only` statement without `--yes`.
* **The project has NO managed backups** (`supabase backups list` -> empty, PITR off) and no Docker on this machine, so `db dump` does not work. Recovery point used: a JSON export of every public table via `db query --remote --read-only` (see the report), kept outside the repository in `~/.uxbarter/backups/` (owner-only). Because migrations 8-10 are additive and the rollback SQL is tested, this is a data-level safety net, not a point-in-time restore. Consider upgrading the plan if real users arrive.
* Vercel CLI 65: `vercel deploy --target production --scope peer-probe --yes` (the `--prod` flag is deprecated); no link is needed if `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are set (read them from `.vercel/project.json`; never run `vercel link` in a checkout that has a `.env.local`). Rollback target recorded before the deploy: `dpl_AzY1pReTyQf2xw1Hn8RdXvEHVx6A` (Matching v2). **Do not promote it after migration 8 without running `docs/rollback-gate-to-migration7.sql` first.**
* Real-browser checks on Production need a human for Turnstile: `node tests/browser/prod-smoke.mjs <url>` (read-only, no session) and `node tests/browser/prod-e2e.mjs <url>` (headed Chrome, two throw-away identities, one labelled test campaign; needs `PROD_SUPABASE_URL` and the PUBLIC `PROD_ANON_KEY`).

## 11. Lessons from PHASE 2 preparation (2026-11-15)
* **Edge Function deploy without Docker:** `npx supabase functions deploy ai-match --use-api --yes` (server-side bundling). Done once; function `ai-match` is ACTIVE, `verify_jwt` on, version 1, **no AI secrets, both flags off**.
* CLI 3.x has no `--project-ref` on `secrets` / `functions`: use `--remote` (linked project). `scripts/set-prod-openai-secret.ps1` was corrected accordingly (`--remote=<ref>`).
* The project uses the new API keys / JWT signing keys (the secrets list shows `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS`). Verified on the hosted gateway: a REAL anonymous user token passes `verify_jwt = true` and the function; garbage / tampered tokens get 401 from the gateway; the anon key (not a user) gets 401 from the function. No `--no-verify-jwt` fallback is needed.
* pg_cron is available (1.6.4) but not installed: `docs/enable-erasure-cron.sql` (one human action: enable the extension in Dashboard -> Database -> Extensions, or run its first statement as owner).
* A live Production referral check needs a normal Chrome started by the human with `--remote-debugging-port` (Playwright's own Chrome is refused by Turnstile): `tests/browser/prod-referral-live.mjs`. Proof of the trigger: the referrer's `referral_reward` ledger row has the SAME `created_at` as the invitee's `test_reward` row (same transaction).

## 12. AI activation: production evidence and the FINAL frontend switch (2026-11-15)
**Done in Production (backend only; the browser UI still makes no AI call because `VITE_AI_MATCHING` is unset):** `OPENAI_API_KEY` (separate `uxbarter-prod` project), `AI_ASSESSMENT_ENABLED=true`, `AI_MATCHING_ENABLED=true`, pg_cron job `ai-erasure-sweep` (every minute).
* Assessment (`tests/browser/prod-ai-assess-live.mjs`): 1 call, 1,187 in / 212 out tokens, tech_savvy -> `qualified`; consent withdrawal -> `pending_assessment`, decision removed.
* Recommendation (`tests/browser/prod-ai-recommend-live.mjs`): ONE hosted request = 2 model calls (analysis + ranking), 1,984 in / 602 out tokens (about $0.0005), HTTP 200; the relevant open campaign was recommended (`good`), the unrelated one was not; non-consenting identities get `consent_required` without any model call; after withdrawal the cron sweep erased the analysis + both cached results (about a minute).
* Matching uses the answers of ACTIVE categories only: an unassessed professional category contributes nothing (the bio alone was used in the test). Assessment -> qualified -> richer recommendations is the intended flow; the two halves were each tested live, the combination only offline.
* Cost control: per-user 12 calls/day, 15 s throttle, global 1,500 calls and 5M tokens/day (about $0.0005 per recommendation run), plus the hard budget of the OpenAI project.

**FINAL ACTIVATION (needs the owner's explicit approval; a frontend rebuild is required because Vite inlines `VITE_*` at build time):**
```
cd "<the linked project folder containing .vercel/project.json>"
printf '1' | MSYS_NO_PATHCONV=1 npx vercel env add VITE_AI_MATCHING production --scope peer-probe      # plain (non-secret) value 1, Production only
# deploy the SAME frontend code that is live (main has no frontend change since the deployed PR #4 merge):
export VERCEL_ORG_ID=<orgId from .vercel/project.json> VERCEL_PROJECT_ID=<projectId from .vercel/project.json>
cd /c/Users/deine/dev/uxbarter-release && MSYS_NO_PATHCONV=1 npx vercel deploy --target production --scope peer-probe --yes
```
Verify afterwards: `curl -s https://uxbarter.vercel.app/ | grep -o 'assets/index-[^"]*\.js'` then grep that bundle for `ai-match`; open /profile (the consent card + "Check my professional answers" appear only for consenting users) and /discover with a consenting test identity.
**Rollback, fastest first:** (1) instant: `npx vercel promote <URL of the previous production deployment> --scope peer-probe` (the build WITHOUT the flag; no rebuild); (2) `AI_ASSESSMENT_ENABLED=false` and `AI_MATCHING_ENABLED=false` via `npx supabase secrets set ... --remote --yes`; (3) `npx vercel env rm VITE_AI_MATCHING production --yes --scope peer-probe` and redeploy; (4) revoke the OpenAI key. Consent withdrawal by users keeps working in every state.
**Abandoned test identities:** `docs/cleanup-abandoned-test-identity.sql` (tested in `supabase/tests/cleanup_identity.mjs`, NOT run; withdraws consent and, optionally, deletes the answers of one orphan identity; never touches credits or the ledger).

## 13. FINAL RELEASE RECORD: AI Matching ACTIVE (2026-11-15)
* Production frontend: `dpl_3EuKZBUqc7ftYVZnaVjgxEnSxDin` (https://peerprobe-hiyy1qoc5-peer-probe.vercel.app, aliases uxbarter.vercel.app / peerprobe.vercel.app), built from `main` 1bcf20f with `VITE_AI_MATCHING=1` (Production only). Verified in the live bundle: `const X="1".trim()==="1"` (flag off = `"".trim()==="1"`). No secret / OpenAI host in any shipped file.
* **Rollback target (flag-free, instant, no rebuild):** `dpl_A9qv3BAop2hfnxey2oM4KNYB2c45` = https://peerprobe-o5ii14dph-peer-probe.vercel.app -> `npx vercel promote https://peerprobe-o5ii14dph-peer-probe.vercel.app --scope peer-probe`. Backend kill switches: `AI_ASSESSMENT_ENABLED=false`, `AI_MATCHING_ENABLED=false`.
* Live end-to-end journey through the real UI (`tests/browser/prod-final-journey.mjs`, 30 of 31 checks; the 1 failed check is the harness reading a collapsed <details> with innerText, verified separately with textContent): non-consenting tester browses with ZERO ai-match requests; consent -> UI-triggered assessment (qualified, Active) -> Recommended for you: relevant demo campaign "Strong match", unrelated and ineligible ones absent; Browse all works independently; withdrawal -> Pending, AI rows erased at once (the app calls delete_my_ai_data; the cron sweep is the safety net).
* Three labelled DEMO campaigns are left OPEN for the video; `docs/cancel-demo-campaigns.sql` (tested in `supabase/tests/cancel_demo.mjs`, NOT run) cancels them with the real cancel_campaign(); otherwise they expire and refund on 2026-11-22.
