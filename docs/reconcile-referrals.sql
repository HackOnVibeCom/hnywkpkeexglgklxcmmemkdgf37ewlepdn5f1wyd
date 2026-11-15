-- HISTORICAL RECONCILIATION of referral rewards under the UPDATED policy (a test on the referrer's own campaign qualifies).
-- NOT run by any migration. Run ONLY with the owner's explicit approval, AFTER migration 11. Preview first:
-- docs/preview-unpaid-referrals.sql (every row whose verdict starts with eligible_unpaid will be paid +1, at most 3 per referrer).
-- Idempotent: it calls the same settlement function the completion trigger uses, once per unpaid referral, WITH history. An eligible row is
-- paid exactly once (+1 ledger row +1 balance, atomically, cap and unique index enforced); every other row only gets its explicit reason
-- recorded and no credit. Running it twice pays nothing the second time.
-- Run as the project owner (SQL editor / supabase db query --remote --yes --file docs/reconcile-referrals.sql).
select f.referee_id, f.referrer_id, public.referral_try_settle(f.referee_id, 0, true) as outcome
  from public.referrals f
 where f.rewarded_at is null and f.settle_failures < 3
 order by f.created_at;
