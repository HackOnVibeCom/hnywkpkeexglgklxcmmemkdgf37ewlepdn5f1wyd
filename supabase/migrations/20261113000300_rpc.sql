-- PeerProbe — atomic RPC functions. These are the ONLY write path.
--
-- All are SECURITY DEFINER with an empty search_path (everything schema-qualified),
-- identify the caller via auth.uid() (never a client-supplied user id), and are
-- executable only by `authenticated` (anonymous-auth users included), never `anon`.
-- Errors are raised as short machine-readable codes (message text) that the
-- frontend maps to friendly copy: not_authenticated, profile_missing,
-- invalid_name, invalid_url, invalid_task, invalid_feedback, invalid_rating,
-- insufficient_credits, campaign_not_found, campaign_closed, own_campaign,
-- already_tested.

-- ---------------------------------------------------------------------------
-- ensure_profile(): idempotent bootstrap. Creates the profile and grants the
-- starter credit exactly once per identity. Safe to call on every page load.
-- Concurrency: the INSERT ... ON CONFLICT DO NOTHING lets only one transaction
-- create the row; the loser sees no inserted row and grants nothing. The partial
-- unique index credit_ledger_one_starter is a second backstop.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_starter constant integer := 1;
  v_uid     uuid := auth.uid();
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.profiles (id, credit_balance)
  values (v_uid, c_starter)
  on conflict (id) do nothing
  returning * into v_profile;

  if found then
    insert into public.credit_ledger (user_id, delta, reason)
    values (v_uid, c_starter, 'starter');
  else
    select * into v_profile from public.profiles where id = v_uid;
  end if;

  return v_profile;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_project_with_campaign(): create a project and request one test,
-- spending exactly one credit. Profile row is locked FOR UPDATE so concurrent
-- calls cannot overspend; balance check + insert + ledger + decrement are one
-- transaction. Returns the new campaign id.
-- ---------------------------------------------------------------------------
create or replace function public.create_project_with_campaign(
  p_name        text,
  p_url         text,
  p_description text,
  p_task        text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_price       constant integer := 1;
  v_uid         uuid := auth.uid();
  v_balance     integer;
  v_project_id  uuid;
  v_campaign_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  p_name        := public.trim_all(coalesce(p_name, ''));
  p_url         := public.trim_all(coalesce(p_url, ''));
  p_description := nullif(public.trim_all(coalesce(p_description, '')), '');
  p_task        := public.trim_all(coalesce(p_task, ''));

  if char_length(p_name) not between 2 and 80 then
    raise exception 'invalid_name';
  end if;
  if not public.is_valid_public_url(p_url) then
    raise exception 'invalid_url';
  end if;
  if p_description is not null and char_length(p_description) > 500 then
    raise exception 'invalid_description';
  end if;
  if char_length(p_task) not between 20 and 600 then
    raise exception 'invalid_task';
  end if;

  select credit_balance into v_balance
  from public.profiles where id = v_uid
  for update;

  if not found then
    raise exception 'profile_missing';
  end if;
  if v_balance < c_price then
    raise exception 'insufficient_credits';
  end if;

  insert into public.projects (owner_id, name, url, description)
  values (v_uid, p_name, p_url, p_description)
  returning id into v_project_id;

  insert into public.campaigns (project_id, owner_id, task_description)
  values (v_project_id, v_uid, p_task)
  returning id into v_campaign_id;

  insert into public.credit_ledger (user_id, delta, reason, campaign_id)
  values (v_uid, -c_price, 'campaign_spend', v_campaign_id);

  update public.profiles
     set credit_balance = credit_balance - c_price
   where id = v_uid;

  return v_campaign_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- list_open_campaigns(): discovery feed. Exposes only what a prospective tester
-- needs (no owner id, no URL). Excludes your own campaigns and ones you already
-- tested. Oldest first so waiting founders are served first.
-- ---------------------------------------------------------------------------
create or replace function public.list_open_campaigns()
returns table (
  campaign_id      uuid,
  project_name     text,
  description      text,
  task_description text,
  created_at       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, p.name, p.description, c.task_description, c.created_at
  from public.campaigns c
  join public.projects p on p.id = c.project_id
  where c.status = 'open'
    and c.owner_id <> auth.uid()
    and not exists (
      select 1 from public.test_submissions s
      where s.campaign_id = c.id and s.tester_id = auth.uid()
    )
  order by c.created_at asc
  limit 50
$$;

-- ---------------------------------------------------------------------------
-- get_campaign_for_test(): the single campaign a tester is about to test,
-- including the website URL. Same eligibility filter as the feed.
-- ---------------------------------------------------------------------------
create or replace function public.get_campaign_for_test(p_campaign_id uuid)
returns table (
  campaign_id      uuid,
  project_name     text,
  project_url      text,
  description      text,
  task_description text,
  created_at       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, p.name, p.url, p.description, c.task_description, c.created_at
  from public.campaigns c
  join public.projects p on p.id = c.project_id
  where c.id = p_campaign_id
    and c.status = 'open'
    and c.owner_id <> auth.uid()
    and not exists (
      select 1 from public.test_submissions s
      where s.campaign_id = c.id and s.tester_id = auth.uid()
    )
$$;

-- ---------------------------------------------------------------------------
-- submit_test(): record structured feedback and award one credit.
-- The campaign row is locked FOR UPDATE, so two testers racing for a
-- one-response campaign are serialized: the first wins, the second gets
-- campaign_closed and no credit. Submission + reward + balance + campaign
-- status are one transaction; the unique (campaign_id, tester_id) constraint and
-- credit_ledger_one_reward make a duplicate reward impossible.
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
  c_reward  constant integer := 1;
  v_uid     uuid := auth.uid();
  v_campaign public.campaigns;
  v_sub_id  uuid;
  v_balance integer;
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

  select * into v_campaign
  from public.campaigns where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign_not_found';
  end if;
  if v_campaign.owner_id = v_uid then
    raise exception 'own_campaign';
  end if;
  if v_campaign.status <> 'open' then
    raise exception 'campaign_closed';
  end if;

  perform 1 from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'profile_missing';
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

  return jsonb_build_object(
    'submission_id',   v_sub_id,
    'credits_awarded', c_reward,
    'balance',         v_balance
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: PostgreSQL grants EXECUTE to PUBLIC by default.
-- Lock to `authenticated` only (anonymous-auth users hold that role).
-- ---------------------------------------------------------------------------
revoke all on function public.ensure_profile()                                              from public, anon;
revoke all on function public.create_project_with_campaign(text, text, text, text)          from public, anon;
revoke all on function public.list_open_campaigns()                                         from public, anon;
revoke all on function public.get_campaign_for_test(uuid)                                   from public, anon;
revoke all on function public.submit_test(uuid, boolean, text, text, integer, boolean)      from public, anon;
revoke all on function public.is_valid_public_url(text)                                     from public, anon, authenticated;
revoke all on function public.enforce_not_own_campaign()                                    from public, anon, authenticated;

grant execute on function public.ensure_profile()                                           to authenticated;
grant execute on function public.create_project_with_campaign(text, text, text, text)       to authenticated;
grant execute on function public.list_open_campaigns()                                      to authenticated;
grant execute on function public.get_campaign_for_test(uuid)                                to authenticated;
grant execute on function public.submit_test(uuid, boolean, text, text, integer, boolean)   to authenticated;
-- is_valid_public_url is used by CHECK constraints and RPCs (running as owner);
-- it needs no direct client access.

-- trim_all is only used by CHECK constraints and RPCs (which run as the owner).
revoke all on function public.trim_all(text) from public, anon, authenticated;
