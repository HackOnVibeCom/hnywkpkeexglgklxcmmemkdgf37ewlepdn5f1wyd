-- UXBarter - referral reward settled by the trusted completion path (hotfix, migration 11)
--
-- PROBLEM. Since migration 20261114000200 the referrer's +1 credit was paid only by settle_referral_rewards(), a lazy call that the
-- REFERRER's own browser makes when it loads Dashboard / Discover. The invitee's completion never triggered it, and nothing recorded WHY
-- a referral was not (yet) paid. In addition the old rule excluded a test on the referrer's OWN campaign, which is exactly the natural
-- referral (a founder invites a friend to test their product), contradicting the promise shown in the UI.
--
-- PRODUCT DECISION (owner, 2026-11-15). A legitimately referred identity completing its first qualifying test earns the referrer +1 credit,
-- EVEN IF that test is on the referrer's own campaign.
--
-- FIX. The completion itself is the authoritative trigger. An AFTER INSERT trigger on credit_ledger fires for the invitee's 'test_reward'
-- row, i.e. inside the very transaction of submit_test, and runs the same idempotent settlement function that the lazy path uses
-- (referral_try_settle). One code path, two callers:
--   1. the completion trigger (primary: atomic with the invitee's reward; nobody has to do anything);
--   2. settle_referral_rewards() (kept, same signature and privileges: a safety net for rows that could not be settled inline, e.g. the
--      referrer's profile row was busy; any signed-in client's page load settles every referrer's due rows).
-- submit_test, claim_referral, the ledger, the caps and the anonymous-identity model are NOT edited.
--
-- RULES (all enforced here and by existing constraints): +1 per referred identity (unique partial index on credit_ledger.referee_id),
-- at most 3 rewarded referrals per referrer (counted from the durable ledger under the referrer's profile lock), never a self-referral
-- (referrals CHECK + claim_referral; and submit_test refuses a tester on their own campaign), never for signup alone, only after the
-- invitee's first QUALIFYING completed test = a 'test_reward' ledger row after the claim, which exists only for a successful, reserved,
-- time-checked submission (an unsuccessful / incomplete / expired test never produces one). The referrer id always comes from the
-- referrals row written by claim_referral from a server-side ref_code lookup: no client can supply one.
--
-- POLICY EFFECTIVE DATE (no automatic historical payouts). The relaxed rule applies to tests completed AFTER this migration (table
-- referral_policy.own_campaign_counts_from). Historical own-campaign tests are NOT paid by the trigger or by the lazy safety net (otherwise
-- the first page load of any signed-in user after deployment would silently pay them); they can only be paid by the explicit, idempotent,
-- owner-approved reconciliation (docs/reconcile-referrals.sql calls referral_try_settle(..., p_include_history => true)).
--
-- SAFETY.
--   * Atomic: ledger row + balance + referral row are written in one sub-transaction, or none of them.
--   * A failure NEVER aborts the invitee's submit_test (everything is inside exception blocks); the referral stays unpaid for the safety net
--     and settle_failures increments (3 strikes, as before).
--   * Locking: the referral row is taken FOR UPDATE SKIP LOCKED (a concurrent settler wins, nobody waits); the referrer's profile row is
--     taken with a BOUNDED wait inside the completion path (lock_timeout 250 ms, restored afterwards; a timeout is not an error: the row
--     stays unpaid for the safety net) and with SKIP LOCKED in the lazy path. Deadlock detection (1 s) can therefore never fire here.
--     (When the invitee tests the referrer's own campaign, the completion holds that campaign row and the invitee's profile row, and takes
--     the referrer's profile row last. The referrer's own transactions take the profile row before/around their campaign rows, so a cycle is
--     conceivable; the 250 ms bound turns it into "unpaid, retried by the safety net" instead of a deadlock error.)
--   * Explicit reasons: referrals.settle_reason records the last decision (paid, no_qualifying_test_yet, referrer_cap_reached, referrer_busy,
--     error) and evaluated_at when.
--   * No backfill and no credit is granted by this migration.
-- Rollback: docs/rollback-migration11.sql (tested). Verification: docs/verify-migration11.sql (read-only, tested).

alter table public.referrals add column settle_reason text;
alter table public.referrals add column evaluated_at timestamptz;
alter table public.referrals
  add constraint referrals_settle_reason_check
  check (settle_reason is null or settle_reason in ('paid', 'no_qualifying_test_yet', 'referrer_cap_reached', 'referrer_busy', 'error'));

-- The single-row policy table: from when does a test on the referrer's own campaign count? (No client access.)
create table public.referral_policy (
  id                       smallint    primary key check (id = 1),
  own_campaign_counts_from timestamptz not null
);
insert into public.referral_policy (id, own_campaign_counts_from) values (1, clock_timestamp());
alter table public.referral_policy enable row level security;
revoke all on public.referral_policy from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The ONE settlement function. p_wait_ms = 0: never wait for a lock (lazy path); > 0: wait at most that long for the referrer's profile
-- row (completion path). p_include_history = true ONLY for the owner-approved reconciliation: it also counts tests on the referrer's own
-- campaign completed before the policy date. Returns the outcome as text. Internal: no client can call it.
-- ---------------------------------------------------------------------------
create or replace function public.referral_try_settle(p_referee uuid, p_wait_ms integer default 0, p_include_history boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_cap     constant integer := 3;
  f         public.referrals;
  v_from    timestamptz;
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

  select own_campaign_counts_from into v_from from public.referral_policy where id = 1;
  -- A qualifying test: a rewarded test since the claim (the ledger row exists only for a successful, reserved, time-checked submission).
  -- On a campaign of someone else: always. On the referrer's own campaign: only if completed on/after the policy date (or when the
  -- owner-approved reconciliation asks for history).
  select exists (select 1 from public.credit_ledger l
                  where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at
                    and (p_include_history
                         or l.created_at >= v_from
                         or not exists (select 1 from public.campaigns c where c.id = l.campaign_id and c.owner_id = f.referrer_id)))
    into v_ok;
  if not v_ok then
    update public.referrals set settle_reason = 'no_qualifying_test_yet', evaluated_at = clock_timestamp() where referee_id = f.referee_id;
    return 'no_qualifying_test_yet';
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
    perform public.referral_try_settle(new.user_id, 250, false);
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
-- The lazy safety net now uses the same function (same signature, same privileges: signed-in clients only). It never includes history.
-- ---------------------------------------------------------------------------
create or replace function public.settle_referral_rewards()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_cap  constant integer := 3;
  v_from timestamptz;
  r      record;
  n      integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  select own_campaign_counts_from into v_from from public.referral_policy where id = 1;

  for r in
    select f.referee_id
      from public.referrals f
     where f.rewarded_at is null
       and f.settle_failures < 3
       -- a referrer already at the cap can never be paid again: keep those rows out of the 25-row window (durable ledger count)
       and (select count(*) from public.credit_ledger g where g.user_id = f.referrer_id and g.reason = 'referral_reward') < c_cap
       and exists (select 1 from public.credit_ledger l
                    where l.user_id = f.referee_id and l.reason = 'test_reward' and l.created_at >= f.created_at
                      and (l.created_at >= v_from
                           or not exists (select 1 from public.campaigns c where c.id = l.campaign_id and c.owner_id = f.referrer_id)))
     order by f.created_at
     limit 25
  loop
    if public.referral_try_settle(r.referee_id, 0, false) = 'paid' then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_my_referrals(): "converted" now counts every invitee who finished a test since the claim (same policy as the settlement), so the
-- numbers shown to the referrer match what is paid. Same signature, same privileges.
-- ---------------------------------------------------------------------------
create or replace function public.get_my_referrals()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'code',      (select p.ref_code from public.profiles p where p.id = auth.uid()),
    'cap',       3,
    'invited',   (select count(*) from public.referrals r where r.referrer_id = auth.uid()),
    'converted', (select count(*) from public.referrals r
                   where r.referrer_id = auth.uid()
                     and exists (select 1 from public.credit_ledger l
                                  where l.user_id = r.referee_id and l.reason = 'test_reward' and l.created_at >= r.created_at)),
    'rewarded',  (select count(*) from public.credit_ledger g where g.user_id = auth.uid() and g.reason = 'referral_reward')
  )
$$;

-- ---------------------------------------------------------------------------
-- Privileges: internal functions are not callable by any client. (settle_referral_rewards / get_my_referrals keep their existing grants.)
-- ---------------------------------------------------------------------------
revoke all on function public.referral_try_settle(uuid, integer, boolean) from public, anon, authenticated;
revoke all on function public.referral_settle_on_reward()                 from public, anon, authenticated;
