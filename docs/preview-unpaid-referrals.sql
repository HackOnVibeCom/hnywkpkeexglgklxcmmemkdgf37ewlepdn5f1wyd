-- READ-ONLY preview of every referral row and what the CURRENT settlement rules say about it. Works on the live schema (migrations 1-10)
-- AND after migration 11. One SELECT, no writes. Run it with the owner login (the read-only role cannot see the internal ledger columns).
--   verdict: already_paid | parked | no_test_yet | blocked_only_referrers_own_campaign | blocked_referrer_cap_reached | eligible_unpaid
-- "eligible_unpaid" = the invitee finished a rewarded test after the claim on a campaign that is NOT the referrer's own and the referrer is
-- below the cap of 3: exactly the rows settle_referral_rewards() would pay on its next call.
with x as (
  select f.referee_id, f.referrer_id, f.created_at, f.rewarded_at, f.settle_failures,
         (select count(*) from public.credit_ledger g where g.user_id = f.referrer_id and g.reason = 'referral_reward') as referrer_rewards,
         exists (select 1 from public.credit_ledger l
                  where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at) as any_test,
         exists (select 1 from public.credit_ledger l
                  where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at
                    and not exists (select 1 from public.campaigns c where c.id = l.campaign_id and c.owner_id = f.referrer_id)) as qualifying_test
    from public.referrals f
)
select x.referee_id, x.referrer_id, x.created_at,
       case when x.rewarded_at is not null then 'already_paid'
            when x.settle_failures >= 3 then 'parked'
            when not x.any_test then 'no_test_yet'
            when not x.qualifying_test then 'blocked_only_referrers_own_campaign'
            when x.referrer_rewards >= 3 then 'blocked_referrer_cap_reached'
            else 'eligible_unpaid' end as verdict,
       x.referrer_rewards
  from x
 order by x.created_at;
