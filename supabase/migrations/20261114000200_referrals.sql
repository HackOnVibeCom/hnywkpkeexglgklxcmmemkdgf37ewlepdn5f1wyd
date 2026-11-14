-- PeerProbe — Phase 2: referral links (idempotent, capped rewards).
--
-- Product rule (the genuine reason to invite someone): you share a link; when a founder who joined
-- through it finishes their FIRST real, rewarded test, YOU earn +1 Test Credit (= one free test of your
-- own product). Up to 3 rewarded referrals per referrer. The invitee still gets the normal starter credit.
--
-- Safety properties (enforced in code AND by constraints):
--   * One referral per invitee, ever (referrals.referee_id is the primary key).
--   * One reward per invitee, ever (unique partial index on credit_ledger.referee_id).
--   * At most 3 rewards per referrer (checked under the referrer's profile lock).
--   * No self-referral; no mutual (A->B and B->A) referrals.
--   * Only a NEW user can be referred: claim is refused once the caller has earned a test reward, and a
--     reward only counts a test that happened AFTER the claim.
--   * The qualifying test must be on SOMEONE ELSE'S campaign (never the referrer's own): otherwise the
--     referrer could time the invitee's test against the feedback they receive and de-anonymise the tester,
--     and a referrer's alt identity could "complete" the referrer's own campaign to harvest credits.
--   * The reward is paid by a separate idempotent settlement call (not inside submit_test), so no new lock
--     order is introduced into the money path. The settler never WAITS for a lock (SKIP LOCKED); the ledger
--     column referee_id deliberately has NO foreign key (an FK would take a KEY SHARE lock on the invitee's
--     profile row = a wait, and would block deleting a paid invitee).
--   * Rows that can never be paid (referrer already at the cap, or a repeatedly failing row) are excluded
--     from the settlement cursor, so they can never starve legitimate referrals queued behind them.
--   * Invitees stay anonymous to the referrer: the referee id is not readable by clients (column grants), and
--     claim_referral gives no information about whether a code exists unless the claim succeeds.
--
-- Constant: referrals rewarded per referrer = 3 (settle_referral_rewards, get_my_referrals, src/lib/limits.ts).

-- ---------------------------------------------------------------------------
-- 1. profiles.ref_code: a short random public code per identity (the ?ref= value).
--    Volatile default => every existing row gets its own value during the rewrite.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column ref_code text not null default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
create unique index profiles_ref_code_key on public.profiles (ref_code);
alter table public.profiles
  add constraint profiles_ref_code_format check (ref_code ~ '^[a-z0-9]{6,16}$');

-- ---------------------------------------------------------------------------
-- 2. referrals: who invited whom. No client access at all (RPC only).
-- ---------------------------------------------------------------------------
create table public.referrals (
  referee_id  uuid        primary key references public.profiles (id) on delete cascade,
  referrer_id uuid        not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  rewarded_at timestamptz,
  settle_failures smallint not null default 0,   -- a row that keeps failing is parked after 3 tries
  constraint referrals_not_self check (referee_id <> referrer_id)
);
create index referrals_referrer_idx on public.referrals (referrer_id);
-- The settlement cursor only ever looks at unpaid rows.
create index referrals_unpaid_idx on public.referrals (created_at) where rewarded_at is null;

revoke all on public.referrals from anon, authenticated;
alter table public.referrals enable row level security;   -- no policies: the table is invisible to clients

-- ---------------------------------------------------------------------------
-- 3. credit_ledger: new reason + the invitee a reward is for (idempotency backstop).
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.credit_ledger'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%test_reward%' and pg_get_constraintdef(oid) like '%starter%'
      and pg_get_constraintdef(oid) not like '%delta%'
  loop
    execute format('alter table public.credit_ledger drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.credit_ledger
  add constraint credit_ledger_reason_check
  check (reason in ('starter', 'test_reward', 'campaign_spend', 'campaign_refund', 'referral_reward'));

do $$
begin
  if (select count(*) from pg_constraint
      where conrelid = 'public.credit_ledger'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%starter%' and pg_get_constraintdef(oid) not like '%delta%') <> 1 then
    raise exception 'migration check failed: credit_ledger must have exactly one reason CHECK';
  end if;
end $$;

-- Plain uuid, intentionally NOT a foreign key (see header): the unique index below is the idempotency key,
-- and deleting an invitee must neither wait for nor be blocked by a ledger row that merely mentions them.
alter table public.credit_ledger
  add column referee_id uuid;

-- A reward row must name its invitee; no other row may.
alter table public.credit_ledger
  add constraint credit_ledger_referee_only_for_referral
  check ((reason = 'referral_reward') = (referee_id is not null));

-- One reward per invitee, ever (double-payment backstop).
create unique index credit_ledger_one_referral_reward on public.credit_ledger (referee_id)
  where reason = 'referral_reward';

-- Hide the new referee_id column from clients: replace the table-level SELECT by an explicit column list
-- (so a referrer can never learn the identity of the people they invited, nor their tester ids).
revoke select on public.credit_ledger from authenticated;
grant select (id, user_id, delta, reason, campaign_id, created_at) on public.credit_ledger to authenticated;

-- ---------------------------------------------------------------------------
-- 4. claim_referral(code): link the caller to the identity that owns `code`. Idempotent; returns a
--    machine-readable result instead of raising, so a stale/odd link never shows an error to a new user.
-- ---------------------------------------------------------------------------
create or replace function public.claim_referral(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_code     text := lower(btrim(coalesce(p_code, '')));
  v_referrer uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_code !~ '^[a-z0-9]{6,16}$' then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_code');
  end if;
  perform 1 from public.profiles where id = v_uid;
  if not found then
    raise exception 'profile_missing';
  end if;

  -- Checks about the CALLER come first and do not look at the code at all, so they cannot be used to probe
  -- which codes exist. After them, a code is only ever "confirmed" by a successful claim, which uses up the
  -- caller's one and only claim.
  if exists (select 1 from public.referrals r where r.referee_id = v_uid) then
    return jsonb_build_object('claimed', false, 'reason', 'already_referred');
  end if;
  -- Only a brand-new participant can be referred (no earned test reward yet).
  if exists (select 1 from public.credit_ledger l where l.user_id = v_uid and l.reason = 'test_reward') then
    return jsonb_build_object('claimed', false, 'reason', 'already_active');
  end if;

  select id into v_referrer from public.profiles where ref_code = v_code;
  if v_referrer is null then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_code');
  end if;
  if v_referrer = v_uid then
    return jsonb_build_object('claimed', false, 'reason', 'self');
  end if;

  -- Serialise the two directions of a pair, so "A claims B" and "B claims A" cannot both pass the mutual
  -- check on stale snapshots (READ COMMITTED: the check below runs after the lock and sees the other commit).
  perform pg_advisory_xact_lock(hashtextextended(least(v_uid::text, v_referrer::text) || '|' || greatest(v_uid::text, v_referrer::text), 0));

  -- No mutual referrals (A invited B, B tries to "invite" A back). Answered as an unknown code on purpose:
  -- the reply must not reveal that the code's owner is one of the caller's own invitees.
  if exists (select 1 from public.referrals r where r.referee_id = v_referrer and r.referrer_id = v_uid) then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_code');
  end if;

  insert into public.referrals (referee_id, referrer_id) values (v_uid, v_referrer)
  on conflict (referee_id) do nothing;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'already_referred');
  end if;
  return jsonb_build_object('claimed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. settle_referral_rewards(): pay +1 to referrers whose invitee has completed their FIRST rewarded test
--    (after the claim). Idempotent, bounded (25 per call), never waits for locks, one bad row cannot stop
--    the others. Any signed-in client may call it (like settle_expired_campaigns).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6. get_my_referrals(): the caller's code and real counts (no invitee identities).
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
                                  where l.user_id = r.referee_id and l.reason = 'test_reward' and l.created_at >= r.created_at
                                    and not exists (select 1 from public.campaigns c where c.id = l.campaign_id and c.owner_id = r.referrer_id))),
    'rewarded',  (select count(*) from public.credit_ledger g where g.user_id = auth.uid() and g.reason = 'referral_reward')
  )
$$;

-- ---------------------------------------------------------------------------
-- 7. Function privileges.
-- ---------------------------------------------------------------------------
revoke all on function public.claim_referral(text)            from public, anon;
revoke all on function public.settle_referral_rewards()       from public, anon;
revoke all on function public.get_my_referrals()              from public, anon;
grant execute on function public.claim_referral(text)         to authenticated;
grant execute on function public.settle_referral_rewards()    to authenticated;
grant execute on function public.get_my_referrals()           to authenticated;
