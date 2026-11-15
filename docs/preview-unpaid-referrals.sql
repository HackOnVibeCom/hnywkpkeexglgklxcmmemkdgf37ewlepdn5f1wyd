-- READ-ONLY preview of every referral row and what the UPDATED referral policy says about it (a test on the referrer's own campaign now
-- qualifies). Works on the live schema (migrations 1-10) AND after migration 11. One SELECT, no writes. Run it with the owner login.
--   verdict:
--     already_paid                          the referrer already has the credit for this invitee
--     parked                                a row that failed 3 times (needs a human look)
--     no_test_yet                           the invitee has not completed a test since the claim (signup alone never pays)
--     blocked_referrer_cap_reached          the referrer already has 3 rewarded referrals
--     eligible_unpaid                       qualified under the OLD rule too (test on a third party's campaign): the lazy safety net pays it
--                                           by itself on the next page load of any signed-in user (this is existing behaviour)
--     eligible_unpaid_needs_reconciliation  qualifies ONLY under the new policy (the invitee's tests were all on the referrer's own campaign
--                                           and predate migration 11): NOT paid automatically, only by docs/reconcile-referrals.sql with the
--                                           owner's separate approval
-- Exact effect on balances = +1 credit for the referrer of every row whose verdict starts with eligible_unpaid, at most 3 per referrer.
with x as (
  select f.referee_id, f.referrer_id, f.created_at, f.rewarded_at, f.settle_failures,
         (select count(*) from public.credit_ledger g where g.user_id = f.referrer_id and g.reason = 'referral_reward') as referrer_rewards,
         (select p.credit_balance from public.profiles p where p.id = f.referrer_id) as referrer_balance,
         exists (select 1 from public.credit_ledger l
                  where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at) as any_test,
         exists (select 1 from public.credit_ledger l
                  where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at
                    and not exists (select 1 from public.campaigns c where c.id = l.campaign_id and c.owner_id = f.referrer_id)) as third_party_test
    from public.referrals f
)
select x.referee_id, x.referrer_id, x.created_at,
       case when x.rewarded_at is not null then 'already_paid'
            when x.settle_failures >= 3 then 'parked'
            when not x.any_test then 'no_test_yet'
            when x.referrer_rewards >= 3 then 'blocked_referrer_cap_reached'
            when x.third_party_test then 'eligible_unpaid'
            else 'eligible_unpaid_needs_reconciliation' end as verdict,
       x.referrer_rewards, x.referrer_balance as referrer_balance_now,
       (select tp.nickname from public.tester_profiles tp where tp.user_id = x.referrer_id) as referrer_nickname,
       (select tp.nickname from public.tester_profiles tp where tp.user_id = x.referee_id) as referee_nickname
  from x
 order by x.created_at;
