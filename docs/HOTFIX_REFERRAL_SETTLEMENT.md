# Hotfix: referral reward settled by the completion itself (migration 11)

## Root cause (production evidence, read-only queries, 2026-11-15)
Two separate facts, both visible in the code and in Production:

1. **Why ReleaseCheckA was not paid: the existing anti-abuse rule, not a malfunction.** `settle_referral_rewards` (migration `20261114000200`) pays a referrer only when the invitee has a `test_reward` ledger row, created after the claim, on a campaign that is **not the referrer's own** (so a referrer cannot time the invitee's test against the feedback they receive, and an alt identity cannot harvest credits on the referrer's own campaign). ReleaseCheckB's **only** rewarded test was on ReleaseCheckA's own campaign: Production shows `on_referrer_own_campaign = true`, `would_settle_under_current_rule = false`. The lazy settler did run (the Dashboard calls it on load; `auth_can_settle = true`) and correctly paid nothing. The same rule is already asserted by `supabase/tests/referrals.mjs` ("a test on the REFERRER'S OWN campaign never counts"). Not a bug in the rule's implementation; the verification scenario simply could not qualify. B must test a **third party's** campaign.
2. **A real design gap, fixed here: settlement was only lazy.** Nothing in `submit_test` (the function does not mention referrals) triggered it. The only callers are `settleAll()` in the browsers of whoever loads Dashboard or Discover (`src/lib/api.ts`, `Dashboard.tsx`, `Discover.tsx`). A referrer who is not looking at the app was paid late, and nothing recorded why a referral was unpaid.

## The fix (migration `20261115000700_referral_settlement_on_completion.sql`, forward-only, backend-only)
* An `AFTER INSERT` trigger on `credit_ledger` fires for the invitee's `test_reward` row, inside `submit_test`'s transaction, and calls the one settlement function `referral_try_settle`. `submit_test`, `claim_referral`, the ledger, caps and the anonymous-identity model are not edited.
* `settle_referral_rewards()` (same signature and privileges) now calls the same function: a safety net for rows that could not be settled inline and for historical rows.
* Atomic (ledger row + balance + referral row in one sub-transaction), never aborts the invitee's completion, referral row `FOR UPDATE SKIP LOCKED`, referrer's profile row with a **bounded** wait (250 ms, restored afterwards) in the completion path and `SKIP LOCKED` in the lazy path, cap counted from the durable ledger under that lock, unique index `credit_ledger_one_referral_reward` as the final backstop.
* Explicit reasons: `referrals.settle_reason` (`paid`, `no_qualifying_test_yet`, `only_tests_on_referrers_own_campaign`, `referrer_cap_reached`, `referrer_busy`, `error`) and `evaluated_at`.
* Trade-off (stated honestly): if the referrer's profile row is locked by another transaction for more than 250 ms, the reward is not paid inline and is left to the safety net (the next page load of ANY signed-in user pays every due referral). True parallel races cannot be run on PGlite (single connection); the locking is reasoned and the cap/idempotency backstops are database constraints.
* **Rule unchanged and still enforced: a test on the referrer's own campaign does not qualify.** Product decision for the owner, NOT changed here: the most natural referral (the friend tests the inviter's product) never pays under this rule.

## Production hotfix procedure (each step needs the owner's approval)
1. Merge the PR (merge commit). No frontend change, no deploy needed (the old and new frontends are both compatible: they only call the unchanged `settle_referral_rewards`).
2. `npx supabase db push --dry-run --remote` must list **exactly** `20261115000700_referral_settlement_on_completion.sql`.
3. Fresh recovery export (see `docs/RELEASE_RUNBOOK.md` section 10), then `npx supabase db push --remote --yes`.
4. `npx supabase db query --remote --yes --file docs/verify-migration11.sql` -> every check true; compare the money snapshot (ledger rows, total credits, referral flags) before/after: identical (migration 11 does no backfill).
5. Real check with fresh identities: A shares link; B joins; B completes the profile; **B tests a THIRD identity's campaign (not A's)**; A's balance is +1 immediately, without any page load; `referrals.settle_reason = 'paid'`.
6. Historical rows: `docs/preview-unpaid-referrals.sql` (read-only). Reconcile only with approval: `docs/reconcile-referrals.sql` (idempotent, pays only `eligible_unpaid` rows).
7. Rollback (tested): `docs/rollback-migration11.sql` (drops the trigger and the new function, restores `settle_referral_rewards` byte for byte; no data changes).
