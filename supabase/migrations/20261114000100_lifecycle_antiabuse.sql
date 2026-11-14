-- PeerProbe — Phase 1: campaign lifecycle + anti-abuse.
--
-- Adds (without touching migrations 1-3, which are already applied):
--   * 7-day campaign expiry (campaigns.expires_at) and an 'expired' status.
--   * 15-minute test reservations (test_reservations) via start_test().
--   * submit_test() now REQUIRES an active reservation and >= 60 s of testing.
--   * Max 5 rewarded tests per identity per rolling 24 h.
--   * cancel_campaign() and settle_expired_campaigns(): refund exactly 1 credit, at most once,
--     only for campaigns that never received feedback.
--   * Discover/test-page RPCs hide expired and reserved campaigns *in SQL, before the LIMIT*, so
--     dead or in-progress campaigns can never starve the feed.
--
-- Invariants (enforced in code AND by constraints/indexes):
--   - Feedback is never deleted: nothing here deletes from test_submissions; cancel/expire only
--     touch campaigns whose status is still 'open' (=> response_count = 0, no submissions).
--   - Refund is idempotent: status transition happens under the campaign row lock and a unique
--     partial index allows one 'campaign_refund' ledger row per campaign.
--   - Reward is idempotent: unchanged unique indexes + unique (campaign, tester) submission.
--   - Balances cannot go negative: profiles.credit_balance CHECK >= 0 (refunds only add).
--   - Lock order everywhere is campaign row -> profile row (no deadlocks).
--   - Reservations expire by time alone (evaluated with now()); no cron needed.
--
-- Constants (change EVERYWHERE listed AND in src/lib/limits.ts):
--   expiry 7 days            : campaigns.expires_at default, settle uses the column
--   reservation 15 minutes   : start_test (c_hold)
--   min testing time 60 s    : start_test (c_min_test), submit_test (c_min_test), get_campaign_for_test (literal)
--   reward cap 5 / rolling 24 h : start_test, submit_test (c_daily_cap), get_my_status (literal)
--   3 starts per (campaign, tester) : start_test (c_max_starts) + test_reservations.starts CHECK

-- ---------------------------------------------------------------------------
-- 1. campaigns: expiry + closed_at + 'expired' status
-- ---------------------------------------------------------------------------
alter table public.campaigns add column expires_at timestamptz;
update public.campaigns set expires_at = created_at + interval '7 days';
alter table public.campaigns alter column expires_at set default (now() + interval '7 days');
alter table public.campaigns alter column expires_at set not null;
alter table public.campaigns add column closed_at timestamptz;

alter table public.campaigns
  add constraint campaigns_expiry_after_creation check (expires_at > created_at);

-- Replace the status CHECK (looked up by definition: don't rely on the auto-generated name).
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.campaigns'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%' and pg_get_constraintdef(oid) like '%completed%'
  loop
    execute format('alter table public.campaigns drop constraint %I', r.conname);
  end loop;
end $$;

-- No code path ever produced 'cancelled' before this migration, but backfill defensively so the
-- consistency CHECK below can never reject existing production rows.
update public.campaigns set closed_at = coalesce(completed_at, created_at)
 where status = 'cancelled' and closed_at is null;

alter table public.campaigns
  add constraint campaigns_status_check check (status in ('open', 'completed', 'cancelled', 'expired'));
alter table public.campaigns
  add constraint campaigns_closed_at_consistent
  check ((status in ('cancelled', 'expired')) = (closed_at is not null));

create index campaigns_open_expiry_idx on public.campaigns (expires_at) where status = 'open';

-- ---------------------------------------------------------------------------
-- 2. credit_ledger: new reason 'campaign_refund' (one per campaign)
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
  check (reason in ('starter', 'test_reward', 'campaign_spend', 'campaign_refund'));

-- Sanity: exactly one reason-CHECK may remain, and it must allow refunds.
do $$
begin
  if (select count(*) from pg_constraint
      where conrelid = 'public.credit_ledger'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%starter%' and pg_get_constraintdef(oid) not like '%delta%') <> 1 then
    raise exception 'migration check failed: credit_ledger must have exactly one reason CHECK';
  end if;
end $$;

-- A campaign can be refunded at most once (double-refund backstop).
create unique index credit_ledger_one_refund on public.credit_ledger (campaign_id)
  where reason = 'campaign_refund';

-- ---------------------------------------------------------------------------
-- 3. test_reservations: one row per (campaign, tester).
--    Active  = consumed_at IS NULL AND expires_at > now().
--    first_started_at never moves: the 60 s minimum is measured from it, so a tester who lets a
--    reservation lapse and re-reserves does not have to wait again.
--    starts is capped (3) so one tester cannot hog a campaign by re-reserving forever.
-- ---------------------------------------------------------------------------
create table public.test_reservations (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid        not null references public.campaigns (id) on delete cascade,
  tester_id        uuid        not null references public.profiles (id) on delete cascade,
  first_started_at timestamptz not null default now(),
  started_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  consumed_at      timestamptz,
  starts           smallint    not null default 1 check (starts between 1 and 3),
  constraint test_reservations_one_per_tester unique (campaign_id, tester_id),
  constraint test_reservations_window check (expires_at > started_at and started_at >= first_started_at)
);
create index test_reservations_tester_active_idx on public.test_reservations (tester_id) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- 4. Internal helper: close an OPEN, unanswered campaign and refund what was spent.
--    Caller MUST already hold the campaign row lock. Returns the owner's new balance, or NULL if
--    nothing was closed (already closed / has feedback). Never callable from the API.
-- ---------------------------------------------------------------------------
create or replace function public.close_campaign_refund(p_campaign_id uuid, p_new_status text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid;
  v_refund  integer;
  v_balance integer;
begin
  if p_new_status not in ('cancelled', 'expired') then
    raise exception 'invalid_status';
  end if;

  update public.campaigns c
     set status = p_new_status, closed_at = now()
   where c.id = p_campaign_id
     and c.status = 'open'
     and c.response_count = 0
     and not exists (select 1 from public.test_submissions s where s.campaign_id = c.id)
  returning c.owner_id into v_owner;

  if not found then
    return null;
  end if;

  -- Refund exactly what this campaign cost (looked up from the ledger, never client-supplied).
  select -l.delta into v_refund
  from public.credit_ledger l
  where l.campaign_id = p_campaign_id and l.reason = 'campaign_spend' and l.user_id = v_owner;

  if v_refund is null or v_refund <= 0 then
    raise exception 'refund_not_found';   -- rolls back the status change too
  end if;

  insert into public.credit_ledger (user_id, delta, reason, campaign_id)
  values (v_owner, v_refund, 'campaign_refund', p_campaign_id);   -- unique index = at most once

  update public.profiles
     set credit_balance = credit_balance + v_refund
   where id = v_owner
  returning credit_balance into v_balance;

  return v_balance;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. start_test(): reserve a campaign for 15 minutes (idempotent for the holder).
-- ---------------------------------------------------------------------------
create or replace function public.start_test(p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_hold       constant interval := interval '15 minutes';
  c_min_test   constant interval := interval '60 seconds';
  c_daily_cap  constant integer  := 5;
  c_max_starts constant integer  := 3;
  v_uid   uuid := auth.uid();
  v_c     public.campaigns;
  v_r     public.test_reservations;
  v_have  boolean;
  v_other uuid;
  v_n     integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_c from public.campaigns where id = p_campaign_id for update;   -- 1st lock: campaign
  if not found then
    raise exception 'campaign_not_found';
  end if;
  if v_c.owner_id = v_uid then
    raise exception 'own_campaign';
  end if;
  if v_c.status <> 'open' then
    raise exception 'campaign_closed';
  end if;

  perform 1 from public.profiles where id = v_uid for update;                    -- 2nd lock: profile
  if not found then
    raise exception 'profile_missing';
  end if;

  if exists (select 1 from public.test_submissions s where s.campaign_id = p_campaign_id and s.tester_id = v_uid) then
    raise exception 'already_tested';
  end if;

  select * into v_r from public.test_reservations
   where campaign_id = p_campaign_id and tester_id = v_uid for update;
  v_have := found;

  -- Idempotent: my own live reservation is returned unchanged (a page refresh must not reset timers).
  if v_have and v_r.consumed_at is null and v_r.expires_at > clock_timestamp() then
    return jsonb_build_object(
      'campaign_id', p_campaign_id, 'reservation_expires_at', v_r.expires_at,
      'min_submit_at', v_r.first_started_at + c_min_test, 'server_now', now());
  end if;

  if v_c.expires_at <= clock_timestamp() then
    raise exception 'campaign_expired';
  end if;

  if exists (select 1 from public.test_reservations o
              where o.campaign_id = p_campaign_id and o.tester_id <> v_uid
                and o.consumed_at is null and o.expires_at > clock_timestamp()) then
    raise exception 'campaign_reserved';
  end if;

  -- One live reservation per tester: a script cannot lock up many tasks at once.
  select o.campaign_id into v_other from public.test_reservations o
   where o.tester_id = v_uid and o.consumed_at is null and o.expires_at > clock_timestamp()
     and o.campaign_id <> p_campaign_id
   limit 1;
  if v_other is not null then
    raise exception 'reservation_exists' using detail = v_other::text;
  end if;

  select count(*) into v_n from public.credit_ledger l
   where l.user_id = v_uid and l.reason = 'test_reward' and l.created_at > now() - interval '24 hours';
  if v_n >= c_daily_cap then
    raise exception 'daily_limit';
  end if;

  if v_have then
    if v_r.starts >= c_max_starts then
      raise exception 'reservation_limit';
    end if;
    update public.test_reservations
       set started_at = now(), expires_at = now() + c_hold, starts = starts + 1
     where id = v_r.id
    returning * into v_r;
  else
    insert into public.test_reservations (campaign_id, tester_id, expires_at)
    values (p_campaign_id, v_uid, now() + c_hold)
    returning * into v_r;
  end if;

  return jsonb_build_object(
    'campaign_id', p_campaign_id, 'reservation_expires_at', v_r.expires_at,
    'min_submit_at', v_r.first_started_at + c_min_test, 'server_now', now());
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. submit_test(): same signature as before; now requires a live reservation, >= 60 s of
--    testing, and enforces the 5 / rolling-24h reward cap. Lock order: campaign -> profile.
--    A tester holding a live reservation may finish even if the campaign expired meanwhile
--    (expiry settlement skips reserved campaigns), so typed feedback is never stranded.
-- ---------------------------------------------------------------------------
create or replace function public.submit_test(
  p_campaign_id    uuid,
  p_task_completed boolean,
  p_friction       text,
  p_suggestion     text,
  p_ux_rating      integer,
  p_share_consent  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_reward    constant integer  := 1;
  c_min_test  constant interval := interval '60 seconds';
  c_daily_cap constant integer  := 5;
  v_uid      uuid := auth.uid();
  v_campaign public.campaigns;
  v_r        public.test_reservations;
  v_have     boolean;
  v_sub_id   uuid;
  v_balance  integer;
  v_n        integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  p_friction   := public.trim_all(coalesce(p_friction, ''));
  p_suggestion := public.trim_all(coalesce(p_suggestion, ''));

  if p_task_completed is null
     or char_length(p_friction) not between 10 and 2000
     or char_length(p_suggestion) not between 10 and 2000 then
    raise exception 'invalid_feedback';
  end if;
  if p_ux_rating is null or p_ux_rating not between 1 and 5 then
    raise exception 'invalid_rating';
  end if;

  select * into v_campaign from public.campaigns where id = p_campaign_id for update;   -- campaign first
  if not found then
    raise exception 'campaign_not_found';
  end if;
  if v_campaign.owner_id = v_uid then
    raise exception 'own_campaign';
  end if;

  perform 1 from public.profiles where id = v_uid for update;                           -- then profile
  if not found then
    raise exception 'profile_missing';
  end if;

  if v_campaign.status <> 'open' then
    -- A retry after a lost response (the first submit succeeded) must not be told "no credit earned".
    if exists (select 1 from public.test_submissions s where s.campaign_id = p_campaign_id and s.tester_id = v_uid) then
      raise exception 'already_tested';
    end if;
    raise exception 'campaign_closed';
  end if;

  select * into v_r from public.test_reservations
   where campaign_id = p_campaign_id and tester_id = v_uid for update;
  v_have := found;
  if not v_have then
    raise exception 'reservation_required';
  end if;
  if v_r.consumed_at is not null then
    raise exception 'already_tested';
  end if;
  -- clock_timestamp(), not now(): now() is the transaction START, stale after waiting on a lock.
  if v_r.expires_at <= clock_timestamp() then
    raise exception 'reservation_expired';
  end if;
  if clock_timestamp() < v_r.first_started_at + c_min_test then
    raise exception 'too_fast' using detail = ceil(extract(epoch from (v_r.first_started_at + c_min_test - clock_timestamp())))::text;
  end if;

  select count(*) into v_n from public.credit_ledger l
   where l.user_id = v_uid and l.reason = 'test_reward' and l.created_at > now() - interval '24 hours';
  if v_n >= c_daily_cap then
    raise exception 'daily_limit';
  end if;

  begin
    insert into public.test_submissions
      (campaign_id, tester_id, task_completed, friction, suggestion, ux_rating, share_consent)
    values
      (p_campaign_id, v_uid, p_task_completed, p_friction, p_suggestion,
       p_ux_rating::smallint, coalesce(p_share_consent, false))
    returning id into v_sub_id;
  exception when unique_violation then
    raise exception 'already_tested';
  end;

  insert into public.credit_ledger (user_id, delta, reason, campaign_id)
  values (v_uid, c_reward, 'test_reward', p_campaign_id);

  update public.profiles
     set credit_balance = credit_balance + c_reward
   where id = v_uid
  returning credit_balance into v_balance;

  update public.campaigns
     set response_count = response_count + 1,
         status         = case when response_count + 1 >= max_responses then 'completed' else status end,
         completed_at   = case when response_count + 1 >= max_responses then now() else completed_at end
   where id = p_campaign_id;

  update public.test_reservations set consumed_at = now() where id = v_r.id;

  return jsonb_build_object(
    'submission_id',   v_sub_id,
    'credits_awarded', c_reward,
    'balance',         v_balance
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. cancel_campaign(): owner cancels an unanswered campaign and gets the credit back.
--    Refused while a tester holds a live reservation (so nobody loses work in progress).
--    Idempotent: cancelling an already cancelled/expired campaign refunds nothing.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_campaign(p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_c       public.campaigns;
  v_balance integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_c from public.campaigns where id = p_campaign_id for update;   -- campaign first
  if not found or v_c.owner_id <> v_uid then
    raise exception 'campaign_not_found';          -- same answer for "not yours": no existence leak
  end if;

  if v_c.status in ('cancelled', 'expired') then
    select credit_balance into v_balance from public.profiles where id = v_uid;
    return jsonb_build_object('status', v_c.status, 'refunded', false, 'balance', v_balance);
  end if;
  if v_c.status <> 'open' then
    raise exception 'campaign_closed';              -- completed: has feedback, never refundable
  end if;

  if exists (select 1 from public.test_reservations t
              where t.campaign_id = p_campaign_id and t.consumed_at is null and t.expires_at > now()) then
    raise exception 'campaign_reserved';
  end if;

  v_balance := public.close_campaign_refund(p_campaign_id, 'cancelled');
  if v_balance is null then
    raise exception 'campaign_closed';
  end if;
  return jsonb_build_object('status', 'cancelled', 'refunded', true, 'balance', v_balance);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. settle_expired_campaigns(): expire + refund campaigns past expires_at that have no live
--    reservation. Any signed-in client may call it (idempotent, bounded to 25 rows, SKIP LOCKED so
--    concurrent callers never block each other). Called by Dashboard and Discover on load.
-- ---------------------------------------------------------------------------
create or replace function public.settle_expired_campaigns()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  for r in
    select c.id, c.owner_id from public.campaigns c
     where c.status = 'open' and c.expires_at <= now()
       and not exists (select 1 from public.test_reservations t
                        where t.campaign_id = c.id and t.consumed_at is null and t.expires_at > now())
     order by c.expires_at
     limit 25
     for update of c skip locked
  loop
    -- Re-check with a fresh snapshot now that the row is locked (a reservation may have committed
    -- between the scan and the lock).
    perform 1 from public.test_reservations t
      where t.campaign_id = r.id and t.consumed_at is null and t.expires_at > now();
    if found then
      continue;
    end if;

    -- NEVER WAIT for an owner's profile lock here. This loop already holds other campaign locks (they
    -- are taken in batches); blocking on profile locks in an arbitrary order could deadlock two
    -- concurrent settlers (S1 holds P(O1) wants P(O2); S2 the reverse). SKIP LOCKED cannot wait, so no
    -- cycle can form; a skipped campaign is simply settled by the next call.
    perform 1 from public.profiles p where p.id = r.owner_id for update skip locked;
    if not found then
      continue;
    end if;

    -- One malformed campaign (e.g. missing spend row) must never stop everyone else's refunds: the
    -- sub-block rolls back only THIS campaign and the loop moves on.
    begin
      if public.close_campaign_refund(r.id, 'expired') is not null then
        n := n + 1;
      end if;
    exception when others then
      raise warning 'settle_expired_campaigns: skipped campaign % (%)', r.id, sqlerrm;
    end;
  end loop;

  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Discovery RPCs (return types change => drop + recreate). Expired and other-testers'-reserved
--    campaigns are excluded INSIDE the query, before LIMIT 50.
-- ---------------------------------------------------------------------------
drop function public.list_open_campaigns();
create function public.list_open_campaigns()
returns table (
  campaign_id            uuid,
  project_name           text,
  description            text,
  task_description       text,
  created_at             timestamptz,
  expires_at             timestamptz,
  reserved_by_me         boolean,
  reservation_expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, p.name, p.description, c.task_description, c.created_at, c.expires_at,
         (mine.id is not null), mine.expires_at
  from public.campaigns c
  join public.projects p on p.id = c.project_id
  left join public.test_reservations mine
         on mine.campaign_id = c.id and mine.tester_id = auth.uid()
        and mine.consumed_at is null and mine.expires_at > now()
  where c.status = 'open'
    and c.owner_id <> auth.uid()
    and (c.expires_at > now() or mine.id is not null)
    and not exists (
      select 1 from public.test_submissions s
      where s.campaign_id = c.id and s.tester_id = auth.uid()
    )
    and not exists (
      select 1 from public.test_reservations o
      where o.campaign_id = c.id and o.tester_id <> auth.uid()
        and o.consumed_at is null and o.expires_at > now()
    )
  order by (mine.id is not null) desc, c.created_at asc
  limit 50
$$;

-- The website URL is only revealed to the tester who holds a live reservation.
drop function public.get_campaign_for_test(uuid);
create function public.get_campaign_for_test(p_campaign_id uuid)
returns table (
  campaign_id            uuid,
  project_name           text,
  project_url            text,
  description            text,
  task_description       text,
  created_at             timestamptz,
  expires_at             timestamptz,
  reserved_by_me         boolean,
  reserved_by_other      boolean,
  reservation_expires_at timestamptz,
  min_submit_at          timestamptz,
  server_now             timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, p.name,
         case when mine.id is not null then p.url end,
         p.description, c.task_description, c.created_at, c.expires_at,
         (mine.id is not null),
         exists (select 1 from public.test_reservations o
                  where o.campaign_id = c.id and o.tester_id <> auth.uid()
                    and o.consumed_at is null and o.expires_at > now()),
         mine.expires_at,
         mine.first_started_at + interval '60 seconds',
         now()
  from public.campaigns c
  join public.projects p on p.id = c.project_id
  left join public.test_reservations mine
         on mine.campaign_id = c.id and mine.tester_id = auth.uid()
        and mine.consumed_at is null and mine.expires_at > now()
  where c.id = p_campaign_id
    and c.status = 'open'
    and c.owner_id <> auth.uid()
    and (c.expires_at > now() or mine.id is not null)
    and not exists (
      select 1 from public.test_submissions s
      where s.campaign_id = c.id and s.tester_id = auth.uid()
    )
$$;

-- ---------------------------------------------------------------------------
-- 10. get_my_status(): the caller's reward quota + live reservation, for honest UI.
-- ---------------------------------------------------------------------------
create or replace function public.get_my_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with r as (
    select l.created_at from public.credit_ledger l
    where l.user_id = auth.uid() and l.reason = 'test_reward' and l.created_at > now() - interval '24 hours'
  )
  select jsonb_build_object(
    'server_now', now(),
    'rewards_24h', (select count(*) from r),
    'daily_limit', 5,
    'next_reward_slot_at',
       case when (select count(*) from r) >= 5 then (select min(created_at) + interval '24 hours' from r) end,
    'active_reservation',
       (select jsonb_build_object('campaign_id', t.campaign_id, 'expires_at', t.expires_at)
          from public.test_reservations t
         where t.tester_id = auth.uid() and t.consumed_at is null and t.expires_at > now()
         limit 1)
  )
$$;

-- ---------------------------------------------------------------------------
-- 11. Table privileges + RLS for test_reservations.
--     Founders may see WHETHER their campaign is being tested (to explain why Cancel is refused),
--     never WHO: tester_id is not granted. Testers use the RPCs.
-- ---------------------------------------------------------------------------
revoke all on public.test_reservations from anon, authenticated;
alter table public.test_reservations enable row level security;

grant select (campaign_id, expires_at, consumed_at) on public.test_reservations to authenticated;
create policy reservations_select_campaign_owner on public.test_reservations
  for select to authenticated
  using (
    exists (
      select 1 from public.campaigns c
      where c.id = test_reservations.campaign_id and c.owner_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 12. Function privileges (re-stated for every function created or replaced above).
-- ---------------------------------------------------------------------------
revoke all on function public.close_campaign_refund(uuid, text)                          from public, anon, authenticated;

revoke all on function public.start_test(uuid)                                           from public, anon;
revoke all on function public.cancel_campaign(uuid)                                      from public, anon;
revoke all on function public.settle_expired_campaigns()                                 from public, anon;
revoke all on function public.get_my_status()                                            from public, anon;
revoke all on function public.list_open_campaigns()                                      from public, anon;
revoke all on function public.get_campaign_for_test(uuid)                                from public, anon;
revoke all on function public.submit_test(uuid, boolean, text, text, integer, boolean)   from public, anon;

grant execute on function public.start_test(uuid)                                        to authenticated;
grant execute on function public.cancel_campaign(uuid)                                   to authenticated;
grant execute on function public.settle_expired_campaigns()                              to authenticated;
grant execute on function public.get_my_status()                                         to authenticated;
grant execute on function public.list_open_campaigns()                                   to authenticated;
grant execute on function public.get_campaign_for_test(uuid)                             to authenticated;
grant execute on function public.submit_test(uuid, boolean, text, text, integer, boolean) to authenticated;
