# Targeted Tester Matching v1 — rollout and rollback plan

Status: **prepared, nothing applied.** Branch `feat/targeted-matching` (from `main` at the UXBarter release). Every step below that touches production (database, Vercel, GitHub `main`) needs the owner's explicit approval.

## What ships

| Layer | Change |
|---|---|
| Database | Migration `supabase/migrations/20261115000100_tester_matching.sql` — **additive only**: new table `tester_profiles` (RLS on, no policy, no grant), new column `campaigns.target_categories text[] not null default '{}'` (+ canonical-form CHECK), five new RPCs (`get_my_tester_profile`, `save_tester_profile`, `delete_my_tester_profile`, `create_targeted_campaign`, `list_matched_campaigns`) and one internal validator. No existing table is rewritten, no function replaced, no grant/policy changed. |
| Frontend | `/profile` page, audience picker on "Request a test", Discover badge / order / explanation, Dashboard shows the audience, landing blurb. Degrades to the old behaviour if the migration is missing. |
| Not touched | Supabase settings, CAPTCHA, Cloudflare, Vercel protection/domains, the HackOnVibe workflow, applied migrations 1–5, credits/reservation/referral rules. |

## Why the order is safe

* The **old UI keeps working after the migration** (it only calls `list_open_campaigns` and `create_project_with_campaign`, both unchanged). So the database can go first with zero user impact.
* The **new UI keeps working before the migration** (it falls back to the plain Discover feed, hides all matching UI, and Dashboard retries without the new column). So a mistaken order cannot break the site.
* Matching never gates anything: `start_test` / `submit_test` are unchanged.

## Ordered plan (each numbered step = one approval)

**0. Pre-flight (no production access)**
1. `git switch feat/targeted-matching`, clean tree; `npm run typecheck && npm run build && npm run test:unit && npm run test:db && npm run test:browser && node tests/browser/csp-check.mjs && node tests/browser/brand-check.mjs` — all green; secret scan of the diff.
2. Record the reviewed migration hash: `sha256sum supabase/migrations/20261115000100_tester_matching.sql`.

**1. Open the PR** `feat/targeted-matching` → `main` (do **not** merge yet). Review the diff; GitHub must report CLEAN / MERGEABLE.

**2. Apply migration 6 to production** (needs approval)
1. `supabase db push --dry-run --remote` must list **exactly** `20261115000100_tester_matching.sql` (nothing else) and the file hash must match step 0.2.
2. Note baseline counts for later comparison (SQL editor, read-only): `select (select count(*) from public.campaigns) campaigns, (select count(*) from public.profiles) profiles, (select coalesce(sum(delta),0) from public.credit_ledger) ledger_sum;`
3. `supabase db push --remote --yes`.
4. Verify in the SQL editor (read-only):
   * `select relrowsecurity from pg_class where oid = 'public.tester_profiles'::regclass;` → `true`
   * `select count(*) from information_schema.role_table_grants where table_name = 'tester_profiles' and grantee in ('anon','authenticated');` → `0`
   * `select count(*) from public.campaigns where target_categories <> '{}';` → `0` (every existing campaign reads as "anyone")
   * `select has_function_privilege('anon','public.list_matched_campaigns()','execute'), has_function_privilege('authenticated','public.list_matched_campaigns()','execute');` → `false, true` (repeat for the four other RPCs; `normalize_tester_categories(text[])` must be `false, false`)
   * the baseline counts from 2.2 are unchanged.
5. With the public anon key only (no token): `POST /rest/v1/rpc/list_matched_campaigns` → rejected (401 / permission denied). If an authenticated call answers `PGRST202` ("could not find the function"), run `notify pgrst, 'reload schema';` once.
6. The currently deployed site still works (open Discover, Dashboard): it does not use any new object.

**3. Deploy the UI to Production** (needs approval)
1. Merge the PR into `main` as a **merge commit** (or deploy from the branch first and merge afterwards — the Vercel site is deployed by CLI, not by Git).
2. `npx vercel deploy --prod --scope peer-probe` from the clean, reviewed commit. Vercel protection, domains, env vars unchanged.
3. Verify: `/`, `/discover`, `/profile`, `/create`, `/dashboard` → 200 on `uxbarter.vercel.app` and `peerprobe.vercel.app`; bundle contains "Targeted Tester Matching"; no secrets; generated URLs still protected; build reproduces from the commit (clean-room build).
4. **Manual smoke test in a real browser** (needs the real Turnstile): new identity → `/profile` → save nickname + a category → Discover shows the note → "Request a test" with one category (costs 1 credit) → from a **second** identity with that category, the task shows "Recommended for you" first; from an identity without it, the task is still listed and testable. Check the Dashboard shows "Preferred testers".

**4. Merge** if not done in 3.1; verify the `main` workflow run is green-but-skipped (no Cloudflare token) and `main` equals the deployed commit.

## Rollback

| Situation | Action | Data impact |
|---|---|---|
| UI misbehaves | Promote the previous Production deployment `dpl_BxQEeXDzAowepxf7YtN1nduVcYS9` (`peerprobe-papzco5s9`, the UXBarter release) in the Vercel dashboard or with `vercel promote` / `vercel rollback`. Instant; the old UI ignores every new database object. | None |
| Bad merge | `git revert -m 1 <merge commit>` on `main` (never force-push). | None |
| Database problem (unlikely) | **Prefer to leave migration 6 in place** — it is inert for the old UI. Only with explicit approval, run the down script below. | Drops profiles and campaign audiences created since the rollout |

Down script (not a migration file; run in the SQL editor only if it must go):

```sql
drop function if exists public.list_matched_campaigns();
drop function if exists public.create_targeted_campaign(text, text, text, text, text[]);
drop function if exists public.delete_my_tester_profile();
drop function if exists public.save_tester_profile(text, text, text[]);
drop function if exists public.get_my_tester_profile();
alter table public.campaigns
  drop constraint campaigns_target_categories_canonical,
  drop column target_categories;
drop table public.tester_profiles;
drop function if exists public.normalize_tester_categories(text[]);
```

## Security notes for the reviewer

* Profile data (nickname, bio, categories) is readable only by its owner through `get_my_tester_profile`; the table has no grants and no policy. Other identities and founders cannot read it.
* The matched feed returns each campaign's **target categories** (public by design) and the **caller's own** overlap; nothing about any other identity.
* All writes are `SECURITY DEFINER` RPCs with `search_path = ''`, EXECUTE only for `authenticated`; direct UPDATE of `campaigns.target_categories` is not granted.
* `create_targeted_campaign` validates categories before spending and delegates to the unchanged `create_project_with_campaign`, so credit locking and idempotency stay in one place.
* Identity deletion cascades to `tester_profiles` (same documented `ON DELETE CASCADE` behaviour as the rest).
* Writes to the profile are not rate-limited beyond Supabase's own API limits (one row per identity, 280-character bio): acceptable for v1, listed as a limitation.

## Deferred (not in v1)

* Showing founders whether a response came from a matching tester (needs a decision about tester anonymity on small pools).
* Per-category supply hints ("no testers yet for X").
* Hard filters / matching-only visibility, weights, or any learned model.
* A real-project end-to-end script for matching (needs a CAPTCHA token path, like the other live scripts).
