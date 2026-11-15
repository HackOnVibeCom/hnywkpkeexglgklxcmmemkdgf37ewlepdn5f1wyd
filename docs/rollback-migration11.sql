-- UXBarter - ROLLBACK of migration 11 (referral settlement on completion) to the behaviour of migrations 1-10.
-- WHEN: only if the completion-time settlement misbehaves. Effects: the completion trigger and the shared settlement function are removed and
-- settle_referral_rewards() is restored byte for byte (lazy settlement by the referrer's own page loads, as before the hotfix).
-- KEEPS: every row and every credit (nothing is deleted or changed), and the two informational columns referrals.settle_reason / evaluated_at
-- (harmless; dropping them is not needed). Already-paid referral rewards stay paid. One transaction. Tested in supabase/tests/referral_settlement.mjs.
begin;

drop trigger if exists credit_ledger_referral_settle on public.credit_ledger;
drop function if exists public.referral_settle_on_reward();

create or replace function public.settle_referral_rewards()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_cap constant integer := 3;
  r         record;
  v_rewarded integer;
  n         integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  for r in
    select f.referee_id, f.referrer_id
      from public.referrals f
     where f.rewarded_at is null
       and f.settle_failures < 3
       -- a referrer already at the cap can never be paid again: keep those rows out of the 25-row window
       -- (counted from the durable ledger, not from referrals rows: deleting paid invitees must not re-open the cap)
       and (select count(*) from public.credit_ledger g where g.user_id = f.referrer_id and g.reason = 'referral_reward') < c_cap
       -- the invitee finished a test (after the claim) on a campaign that is NOT the referrer's own
       and exists (select 1 from public.credit_ledger l
                    where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at
                      and not exists (select 1 from public.campaigns c where c.id = l.campaign_id and c.owner_id = f.referrer_id))
     order by f.created_at
     limit 25
     for update of f skip locked
  loop
    -- Never wait for a profile lock while holding other row locks (deadlock avoidance, see settle_expired_campaigns).
    perform 1 from public.profiles p where p.id = r.referrer_id for update skip locked;
    if not found then
      continue;
    end if;

    begin
      -- Cap again, now under the referrer's profile lock, so concurrent settlers cannot overshoot it.
      select count(*) into v_rewarded from public.credit_ledger g where g.user_id = r.referrer_id and g.reason = 'referral_reward';
      if v_rewarded >= c_cap then
        continue;
      end if;

      insert into public.credit_ledger (user_id, delta, reason, referee_id)
      values (r.referrer_id, 1, 'referral_reward', r.referee_id);      -- unique index = at most once per invitee

      update public.profiles set credit_balance = credit_balance + 1 where id = r.referrer_id;
      update public.referrals set rewarded_at = now() where referee_id = r.referee_id;
      n := n + 1;
    exception when others then
      raise warning 'settle_referral_rewards: skipped referee % (%)', r.referee_id, sqlerrm;
      -- Park a row that keeps failing, so it cannot occupy the 25-row window forever.
      update public.referrals set settle_failures = settle_failures + 1 where referee_id = r.referee_id;
    end;
  end loop;

  return n;
end;
$$;

drop function if exists public.referral_try_settle(uuid, integer);

commit;
