# Hotfix: referral reward settled by the completion itself, own-campaign tests qualify (migration 11)

## Referral policy (as of this hotfix; owner decision 2026-11-15)
When a legitimately referred user completes their **first qualifying test**, the referrer earns **+1 Test Credit, automatically**, **even if that test is on the referrer's own campaign** (the normal case of a founder inviting a friend to test their product).
* **Qualifying test** = a `test_reward` ledger row created after the referral claim. That row only exists for a successful, reserved, minimum-time, non-expired submission: an unsuccessful, incomplete, too-fast or expired test never produces one.
* **Exactly one reward per referred identity** (unique partial index `credit_ledger_one_referral_reward`), **at most 3 rewarded referrals per referrer** (counted from the durable ledger under the referrer's profile lock), **never for signup alone**, **never a self-referral** (`referrals_not_self`, `claim_referral`; `submit_test` also refuses a tester on their own campaign), no mutual referrals (unchanged).
* The referrer id always comes from the `referrals` row written by `claim_referral` from a server-side `ref_code` lookup. No client can supply one, and clients cannot call the settlement functions.

## What was wrong (production evidence)
1. ReleaseCheckA was not paid because the previous rule excluded a test on the referrer's **own** campaign and ReleaseCheckB's only test was on A's campaign (Production: `on_referrer_own_campaign = true`). That rule contradicted the referral promise shown in the UI ("when a friend ... finishes their first test, you earn +1"). **Changed by the owner's decision above.**
2. Settlement was **only lazy** (`settle_referral_rewards()` called by page loads), never triggered by the completion. **Fixed here.**

## The change (`supabase/migrations/20261115000700_referral_settlement_on_completion.sql`, forward-only, backend-only, not yet applied)
* `AFTER INSERT` trigger on `credit_ledger` for the invitee's `test_reward` runs the shared idempotent `referral_try_settle` **inside `submit_test`'s transaction**: atomic (ledger row + balance + referral row, or none), never breaks the completion, referral row `FOR UPDATE SKIP LOCKED`, referrer profile row with a **bounded 250 ms wait** (restored afterwards; `SKIP LOCKED` in the lazy path), cap under that lock, unique index as backstop.
* `settle_referral_rewards()` (same signature/privileges) is kept as a safety net and uses the same function; `get_my_referrals()` "converted" now follows the same policy.
* `referrals.settle_reason` (`paid`, `no_qualifying_test_yet`, `referrer_cap_reached`, `referrer_busy`, `error`) and `evaluated_at` record the last decision.
* **Policy effective date, so history is never paid silently:** `referral_policy.own_campaign_counts_from` is set to the moment the migration is applied. Own-campaign tests completed **after** it qualify (trigger and safety net). Own-campaign tests completed **before** it (e.g. ReleaseCheck) are NOT paid by the trigger or by any page load; only the explicit, owner-approved reconciliation pays them. Tests on third parties' campaigns keep qualifying as before (the existing lazy settler may pay such a row on the next page load, as it always did).
* Trade-off: if the referrer's profile row is locked by another transaction for more than 250 ms, the reward is left to the safety net (the next page load of any signed-in user pays every due referral). Real parallel races cannot be run on PGlite (single connection): the lock design is reasoned (see the migration) and the cap/idempotency backstops are constraints; "concurrent" completions are exercised inside one transaction.

## Remaining abuse risks (accepted by the owner's decision; none newly unbounded)
* **Alt-identity farming.** A referrer can create an anonymous alt, refer it, and have the alt complete the referrer's own campaign: net effect per alt = the alt earns +1 (test reward) and the referrer earns +1 (referral reward) for one campaign credit spent. This is bounded to **3 rewarded referrals per referrer** and was already possible before (the alt could test any third party's campaign), because anonymous identities are free; the Turnstile check on anonymous sign-in, the daily reward cap and the 60 s minimum remain the throttle.
* **Timing/de-anonymisation.** The referrer can correlate "my campaign got feedback" with "my referral was rewarded" and infer that their invitee wrote it. This is inherent to the intended scenario (they invited that friend to test that product); feedback stays private to the founder, and the invitee id is never exposed (the ledger column is not granted to clients).
* `referrer_busy` rewards can wait for the next page load of someone (bounded, retried, never lost).

## Production hotfix procedure (each step needs the owner's approval; nothing has been applied)
1. Merge PR #5 (merge commit). No frontend change, no deploy.
2. `npx supabase db push --dry-run --remote` must list **exactly** `20261115000700_referral_settlement_on_completion.sql`.
3. Fresh recovery export (see `docs/RELEASE_RUNBOOK.md` section 10), then `npx supabase db push --remote --yes`.
4. `npx supabase db query --remote --yes --file docs/verify-migration11.sql` -> every check true (13 rows); the money snapshot (ledger rows, total credits, referral flags) is identical before/after: the migration does no backfill.
5. Fresh-identity check: A joins (1 credit), spends it on a campaign, B joins via A's link, completes the profile, reserves and completes **A's own campaign** -> B +1, A back to 1 immediately, A's campaign Tested 1/1, `referrals.rewarded_at` set. No dashboard load needed.
6. Historical rows: `docs/preview-unpaid-referrals.sql` (read-only). Only with approval: `docs/reconcile-referrals.sql` (idempotent; pays exactly the rows whose verdict starts with `eligible_unpaid`, at most 3 per referrer).
7. Rollback (tested): `docs/rollback-migration11.sql` (drops the trigger, the new function and the policy table; restores `settle_referral_rewards` and `get_my_referrals` byte for byte; no data changes; paid rewards stay paid).

## Effect of the updated policy on existing Production referrals (read-only preview, 2026-11-15)
5 referral rows: 3 already paid; 1 blocked (its referrer already has 3 rewards = cap); **1 `eligible_unpaid_needs_reconciliation`: ReleaseCheckA <- ReleaseCheckB** (A: 0 rewards, balance 0 -> 1 if reconciled). No other historical row qualifies. Nothing was changed in Production.
