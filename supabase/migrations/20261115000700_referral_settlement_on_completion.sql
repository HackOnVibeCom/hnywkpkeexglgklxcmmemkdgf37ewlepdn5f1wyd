-- UXBarter - referral reward settled by the trusted completion path (hotfix, migration 11)
--
-- PROBLEM. Since migration 20261114000200 the referrer's +1 credit was paid only by settle_referral_rewards(), a lazy call that the
-- REFERRER's own browser makes when it loads Dashboard / Discover. The invitee's completion never triggered it, so a referrer who is
-- not looking at the app is paid late, and nothing recorded WHY a referral was not (yet) paid.
--
-- FIX. The completion itself is now the authoritative trigger. An AFTER INSERT trigger on credit_ledger fires for the invitee's
-- 'test_reward' row, i.e. inside the very transaction of submit_test, and runs the same idempotent settlement function that the lazy
-- path uses (referral_try_settle). One code path, two callers:
--   1. the completion trigger (primary: atomic with the invitee's reward; the referrer needs to do nothing);
--   2. settle_referral_rewards() (kept, same signature and privileges: a safety net for rows that could not be settled inline, e.g.
--      the referrer's profile row was busy, and for any other signed-in client's page load: it settles every referrer's due rows).
-- submit_test, claim_referral, the ledger, the caps and the anonymous-identity model are NOT edited.
--
-- RULES (unchanged, all enforced here and by the existing constraints): +1 per referred identity, at most 3 rewarded referrals per
-- referrer (counted from the durable ledger under the referrer's profile lock), never a self-referral (table CHECK), never for signup
-- alone, only after the invitee's first QUALIFYING completed test = a rewarded test AFTER the claim on a campaign that is NOT the
-- referrer's own (anti-abuse rule of migration 20261114000200: it prevents de-anonymising the invitee by timing and an alt identity
-- harvesting credits on the referrer's own campaign), one ledger row per invitee (unique index credit_ledger_one_referral_reward).
--
-- SAFETY.
--   * Atomic: ledger row + balance + referral row are written in one sub-transaction, or none of them.
--   * A failure NEVER aborts the invitee's submit_test (everything is inside exception blocks); it parks/leaves the referral for the
--     safety-net path and increments settle_failures (3 strikes, as before).
--   * Locking: the referral row is taken FOR UPDATE SKIP LOCKED (a concurrent settler wins, nobody waits); the referrer's profile row is
--     taken with a BOUNDED wait inside the completion path (lock_timeout 250 ms, restored afterwards; a timeout is not an error: the row
--     stays unpaid for the safety net) and with SKIP LOCKED in the lazy path. Deadlock detection (1 s) can therefore never fire here.
--   * Explicit reasons: referrals.settle_reason records the last decision (paid, no_qualifying_test_yet,
--     only_tests_on_referrers_own_campaign, referrer_cap_reached, referrer_busy, error) and evaluated_at when.
--   * No backfill and no credit is granted by this migration: existing rows are only touched when a (new or lazy) settlement runs.
-- Rollback: docs/rollback-migration11.sql (tested). Verification: docs/verify-migration11.sql (read-only, tested).

alter table public.referrals add column settle_reason text;
alter table public.referrals add column evaluated_at timestamptz;
alter table public.referrals
  add constraint referrals_settle_reason_check
  check (settle_reason is null or settle_reason in ('paid', 'no_qualifying_test_yet', 'only_tests_on_referrers_own_campaign', 'referrer_cap_reached', 'referrer_busy', 'error'));

-- ---------------------------------------------------------------------------
-- The ONE settlement function. p_wait_ms = 0: never wait for a lock (lazy path); > 0: wait at most that long for the referrer's
-- profile row (completion path). Returns the outcome as text. Internal: no client can call it.
-- ---------------------------------------------------------------------------
create or replace function public.referral_try_settle(p_referee uuid, p_wait_ms integer default 0)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_cap     constant integer := 3;
  f         public.referrals;
  v_any     boolean;
  v_ok      boolean;
  v_locked  boolean;
  v_n       integer;
  v_old     text;
begin
  select * into f from public.referrals where referee_id = p_referee for update skip locked;
  if not found then
    return 'none_or_busy';
  end if;
  if f.rewarded_at is not null then
    return 'already_rewarded';
  end if;
  if f.settle_failures >= 3 then
    return 'parked';
  end if;

  -- The invitee's rewarded tests since the claim; a qualifying one is on a campaign that is NOT the referrer's own.
  select exists (select 1 from public.credit_ledger l
                  where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at),
         exists (select 1 from public.credit_ledger l
                  where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at
                    and not exists (select 1 from public.campaigns c where c.id = l.campaign_id and c.owner_id = f.referrer_id))
    into v_any, v_ok;
  if not v_ok then
    update public.referrals
       set settle_reason = case when v_any then 'only_tests_on_referrers_own_campaign' else 'no_qualifying_test_yet' end,
           evaluated_at = clock_timestamp()
     where referee_id = f.referee_id;
    return case when v_any then 'only_tests_on_referrers_own_campaign' else 'no_qualifying_test_yet' end;
  end if;

  begin
    -- The referrer's profile row serialises every settlement of this referrer (cap + balance). Bounded wait or skip, never a deadlock.
    if p_wait_ms > 0 then
      v_old := current_setting('lock_timeout');
      perform set_config('lock_timeout', greatest(p_wait_ms, 1)::text || 'ms', true);
      perform 1 from public.profiles p where p.id = f.referrer_id for update;
      v_locked := found;
      perform set_config('lock_timeout', v_old, true);
    else
      perform 1 from public.profiles p where p.id = f.referrer_id for update skip locked;
      v_locked := found;
    end if;
    if not v_locked then
      update public.referrals set settle_reason = 'referrer_busy', evaluated_at = clock_timestamp() where referee_id = f.referee_id;
      return 'referrer_busy';
    end if;

    -- Cap, from the durable ledger, now under the referrer's lock (concurrent settlers cannot overshoot it).
    select count(*) into v_n from public.credit_ledger g where g.user_id = f.referrer_id and g.reason = 'referral_reward';
    if v_n >= c_cap then
      update public.referrals set settle_reason = 'referrer_cap_reached', evaluated_at = clock_timestamp() where referee_id = f.referee_id;
      return 'referrer_cap_reached';
    end if;

    insert into public.credit_ledger (user_id, delta, reason, referee_id) values (f.referrer_id, 1, 'referral_reward', f.referee_id); -- unique index: at most once per invitee
    update public.profiles set credit_balance = credit_balance + 1 where id = f.referrer_id;
    update public.referrals set rewarded_at = now(), settle_reason = 'paid', evaluated_at = clock_timestamp() where referee_id = f.referee_id;
    return 'paid';
  exception
    when lock_not_available then
      update public.referrals set settle_reason = 'referrer_busy', evaluated_at = clock_timestamp() where referee_id = f.referee_id;
      return 'referrer_busy';
    when others then
      raise warning 'referral_try_settle: referee % (%)', f.referee_id, sqlerrm;
      update public.referrals set settle_failures = settle_failures + 1, settle_reason = 'error', evaluated_at = clock_timestamp() where referee_id = f.referee_id;
      return 'error';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- The completion trigger: fires for the invitee's 'test_reward' ledger row, inside submit_test's transaction. It can never make
-- submit_test fail.
-- ---------------------------------------------------------------------------
create or replace function public.referral_settle_on_reward()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform public.referral_try_settle(new.user_id, 250);
  exception when others then
    raise warning 'referral_settle_on_reward: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists credit_ledger_referral_settle on public.credit_ledger;
create trigger credit_ledger_referral_settle
  after insert on public.credit_ledger
  for each row
  when (new.reason = 'test_reward')
  execute function public.referral_settle_on_reward();

-- ---------------------------------------------------------------------------
-- The lazy safety net now uses the same function (same signature, same privileges: signed-in clients only).
-- ---------------------------------------------------------------------------
create or replace function public.settle_referral_rewards()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_cap constant integer := 3;
  r     record;
  n     integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  for r in
    select f.referee_id
      from public.referrals f
     where f.rewarded_at is null
       and f.settle_failures < 3
       -- a referrer already at the cap can never be paid again: keep those rows out of the 25-row window (durable ledger count)
       and (select count(*) from public.credit_ledger g where g.user_id = f.referrer_id and g.reason = 'referral_reward') < c_cap
       and exists (select 1 from public.credit_ledger l
                    where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at
                      and not exists (select 1 from public.campaigns c where c.id = l.campaign_id and c.owner_id = f.referrer_id))
     order by f.created_at
     limit 25
  loop
    if public.referral_try_settle(r.referee_id, 0) = 'paid' then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: internal functions are not callable by any client. (settle_referral_rewards keeps its existing grants.)
-- ---------------------------------------------------------------------------
revoke all on function public.referral_try_settle(uuid, integer) from public, anon, authenticated;
revoke all on function public.referral_settle_on_reward()        from public, anon, authenticated;
