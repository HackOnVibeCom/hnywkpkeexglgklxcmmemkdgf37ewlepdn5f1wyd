-- HISTORICAL RECONCILIATION of referral rewards (NOT run by any migration; run ONLY with the owner's explicit approval, AFTER migration 11).
-- Idempotent: it calls the same settlement function the completion trigger uses, once per unpaid referral. A row that is eligible is paid
-- exactly once (+1 ledger row +1 balance, atomically); every other row only gets its explicit reason recorded (settle_reason) and no
-- credit. Running it twice pays nothing the second time. Preview first with docs/preview-unpaid-referrals.sql: the rows whose verdict is
-- 'eligible_unpaid' are exactly the ones that will be paid, nothing else can change a balance.
-- Run as the project owner (SQL editor / supabase db query --remote --yes --file docs/reconcile-referrals.sql).
select f.referee_id, f.referrer_id, public.referral_try_settle(f.referee_id, 0) as outcome
  from public.referrals f
 where f.rewarded_at is null and f.settle_failures < 3
 order by f.created_at;
