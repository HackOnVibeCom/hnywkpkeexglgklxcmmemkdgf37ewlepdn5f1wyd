-- READ-ONLY verification of migration 20261115000700 (referral settlement on completion). One SELECT, no writes; every ok must be true.
-- Run with the owner login after applying it. Tested against the real migration in supabase/tests/referral_settlement.mjs.
select check_name, ok from (
  select 1 as n, 'migration 11 objects exist (referral_try_settle, referral_settle_on_reward, trigger credit_ledger_referral_settle)' as check_name,
         (to_regprocedure('public.referral_try_settle(uuid, integer, boolean)') is not null and to_regprocedure('public.referral_settle_on_reward()') is not null
          and (select count(*) = 1 from pg_trigger where tgname = 'credit_ledger_referral_settle' and not tgisinternal and tgenabled = 'O')) as ok
  union all
  select 2, 'the completion trigger fires only for test_reward rows, AFTER INSERT, per row',
         (select pg_get_triggerdef(oid) ilike '%after insert%' and pg_get_triggerdef(oid) ilike '%test_reward%' and pg_get_triggerdef(oid) ilike '%for each row%' from pg_trigger where tgname = 'credit_ledger_referral_settle')
  union all
  select 3, 'internal functions are NOT executable by anon / authenticated / public',
         (select bool_and(not has_function_privilege('anon', p, 'execute') and not has_function_privilege('authenticated', p, 'execute'))
            from unnest(array['public.referral_try_settle(uuid, integer, boolean)'::regprocedure, 'public.referral_settle_on_reward()'::regprocedure]) p)
  union all
  select 4, 'settle_referral_rewards() and get_my_referrals(): authenticated yes, anon no (unchanged)',
         (has_function_privilege('authenticated', 'public.settle_referral_rewards()', 'execute') and not has_function_privilege('anon', 'public.settle_referral_rewards()', 'execute')
          and has_function_privilege('authenticated', 'public.get_my_referrals()', 'execute') and not has_function_privilege('anon', 'public.get_my_referrals()', 'execute'))
  union all
  select 41, 'referral_policy: one row, own_campaign_counts_from set, RLS on, no client privileges',
         ((select count(*) = 1 and bool_and(own_campaign_counts_from is not null) from public.referral_policy)
          and (select relrowsecurity from pg_class where oid = 'public.referral_policy'::regclass)
          and not has_table_privilege('anon', 'public.referral_policy', 'select') and not has_table_privilege('authenticated', 'public.referral_policy', 'select'))
  union all
  select 5, 'all three functions are SECURITY DEFINER with an empty search_path',
         (select bool_and(p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%'))
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('referral_try_settle', 'referral_settle_on_reward', 'settle_referral_rewards'))
  union all
  select 6, 'unique index credit_ledger_one_referral_reward and the self-referral CHECK are present (idempotency + no self-reward backstops)',
         ((select count(*) = 1 from pg_indexes where indexname = 'credit_ledger_one_referral_reward')
          and (select count(*) = 1 from pg_constraint where conname = 'referrals_not_self'))
  union all
  select 7, 'referrals still has no client privileges (RLS on, no grants)',
         ((select relrowsecurity from pg_class where oid = 'public.referrals'::regclass)
          and not has_table_privilege('anon', 'public.referrals', 'select') and not has_table_privilege('authenticated', 'public.referrals', 'select'))
  union all
  select 8, 'ledger invariant: every balance equals the sum of its ledger rows',
         (select count(*) = 0 from public.profiles p where p.credit_balance <> coalesce((select sum(delta) from public.credit_ledger l where l.user_id = p.id), 0))
  union all
  select 9, 'at most one referral_reward per invitee and at most 3 per referrer',
         (not exists (select 1 from public.credit_ledger where reason = 'referral_reward' group by referee_id having count(*) > 1)
          and not exists (select 1 from public.credit_ledger where reason = 'referral_reward' group by user_id having count(*) > 3))
  union all
  select 10, 'every referral_reward row belongs to a referral row marked rewarded (or its invitee was deleted)',
         (select count(*) = 0 from public.credit_ledger l where l.reason = 'referral_reward'
             and exists (select 1 from public.referrals f where f.referee_id = l.referee_id and f.rewarded_at is null))
  union all
  select 11, 'info: referrals total / paid / unpaid: ' || (select count(*) from public.referrals) || ' / ' || (select count(*) from public.referrals where rewarded_at is not null) || ' / ' || (select count(*) from public.referrals where rewarded_at is null), true
  union all
  select 12, 'info: unpaid by reason: ' || coalesce((select string_agg(coalesce(settle_reason, 'not evaluated yet') || '=' || n, ', ') from (select settle_reason, count(*) n from public.referrals where rewarded_at is null group by 1) s), 'none'), true
) v order by n;
