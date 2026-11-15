-- UXBarter - EMERGENCY ROLLBACK of the migration-8 gate to the live Matching v2 (migration 7) behaviour.
--
-- WHEN: only if, after migrations 8-10 were applied, the new rules must be switched off at once (for example the four-answers
-- participation rule blocks too many testers, or the assessment cannot be served) AND/OR the previous (Matching v2) UI has to be
-- promoted again. A frontend rollback alone is NOT enough once migration 8 is applied: the old UI cannot complete the new profile.
--
-- WHAT IT DOES (and nothing else): re-creates, byte for byte, the five function bodies that migration 8 replaced, as they are
-- in migrations 20261115000100 and 20261115000200 (production state before migration 8):
--   tester_eligibility, enforce_campaign_eligibility, get_screening, submit_screening, list_matched_campaigns.
-- Result: open tasks need nothing again, targeted tasks use the legacy screening passes again, the old UI works.
--
-- WHAT IT KEEPS: every table and every row (answers, consents, decisions, AI caches, ledger, reservations, campaigns), the new RPCs
-- (harmless: the old UI never calls them) and migrations 9-10 (inert without the new UI). Nothing is dropped, so nothing is lost and
-- the rollout can be tried again later by re-running only the five CREATE OR REPLACE statements of migration 8.
-- It does NOT weaken the qualification rules of migration 8's tables: it simply stops enforcing them until you re-apply them.
--
-- Tested: supabase/tests/release_rehearsal.mjs applies migrations 8-10 on a populated database, runs this file, and checks that all
-- five function definitions are identical to the pre-migration-8 database and that legacy behaviour is back.
-- Run it in the Supabase SQL editor (or: supabase db query / psql) as the project owner. It is one transaction.

begin;

create or replace function public.tester_eligibility(p_user uuid, p_mode text, p_required text[])
returns table (eligible boolean, reason text, missing_screening text[], overlap text[])
language plpgsql
stable
set search_path = ''
as $$
declare
  v_cats    text[];
  v_overlap text[];
  v_ok      text[];
  v_missing text[];
begin
  select t.categories into v_cats from public.tester_profiles t where t.user_id = p_user;
  v_cats := coalesce(v_cats, '{}'::text[]);
  v_overlap := array(select x from unnest(p_required) as x where x = any (v_cats));

  if p_mode <> 'targeted' then
    return query select true, 'open'::text, '{}'::text[], v_overlap;
    return;
  end if;
  if cardinality(v_cats) = 0 then
    return query select false, 'no_profile'::text, '{}'::text[], '{}'::text[];
    return;
  end if;
  if cardinality(v_overlap) = 0 then
    return query select false, 'category_mismatch'::text, '{}'::text[], v_overlap;
    return;
  end if;

  v_ok := array(
    select c from unnest(v_overlap) as c
    where not public.category_requires_screening(c) or public.is_screened(p_user, c));
  if cardinality(v_ok) > 0 then
    return query select true, 'eligible'::text, '{}'::text[], v_overlap;
    return;
  end if;

  v_missing := array(
    select c from unnest(v_overlap) as c
    where public.category_requires_screening(c) and not public.is_screened(p_user, c));
  return query select false, 'screening_required'::text, v_missing, v_overlap;
end;
$$;

create or replace function public.enforce_campaign_eligibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text;
  v_req  text[];
  v_e    record;
begin
  if tg_op = 'UPDATE' and new.started_at is not distinct from old.started_at then
    return new;
  end if;
  select c.testing_mode, c.target_categories into v_mode, v_req from public.campaigns c where c.id = new.campaign_id;
  if v_mode is distinct from 'targeted' then
    return new;
  end if;
  select * into v_e from public.tester_eligibility(new.tester_id, v_mode, v_req);
  if not v_e.eligible then
    raise exception 'not_eligible' using detail = v_e.reason;
  end if;
  return new;
end;
$$;

create or replace function public.get_screening(p_category text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max  constant integer := 3;
  v_uid  uuid := auth.uid();
  v_ver  integer;
  v_min  smallint;
  v_used integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_category is null or not public.category_requires_screening(p_category) then
    raise exception 'screening_not_required';
  end if;
  v_ver := public.screening_current_version(p_category);
  if v_ver is null then
    raise exception 'screening_unavailable';
  end if;
  select v.min_areas into v_min from public.screening_versions v where v.category = p_category and v.version = v_ver;
  select count(*) into v_used from public.screening_attempts a
   where a.user_id = v_uid and a.category = p_category and a.created_at > now() - interval '24 hours';
  return jsonb_build_object(
    'category', p_category,
    'version', v_ver,
    'min_areas', v_min,
    'qualified', public.is_screened(v_uid, p_category),
    'max_attempts', c_max,
    'attempts_left', greatest(c_max - v_used, 0),
    'questions', (
      select coalesce(jsonb_agg(jsonb_build_object('id', q.qid, 'prompt', q.prompt, 'options', q.options) order by q.position), '[]'::jsonb)
      from public.screening_questions q where q.category = p_category and q.version = v_ver));
end;
$$;

create or replace function public.submit_screening(p_category text, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max    constant integer := 3;
  v_uid    uuid := auth.uid();
  v_ver    integer;
  v_min    smallint;
  v_n      integer;
  v_oldest timestamptz;
  v_q      record;
  v_arr    jsonb;
  v_el     jsonb;
  v_ids    text[];
  v_areas  integer := 0;
  v_passed boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_category is null or not public.category_requires_screening(p_category) then
    raise exception 'screening_not_required';
  end if;
  perform 1 from public.profiles where id = v_uid;
  if not found then
    raise exception 'profile_missing';
  end if;

  -- Serialise attempts per (identity, category): two parallel submissions cannot both slip under the limit.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_category, 0));

  v_ver := public.screening_current_version(p_category);
  if v_ver is null then
    raise exception 'screening_unavailable';
  end if;
  select v.min_areas into v_min from public.screening_versions v where v.category = p_category and v.version = v_ver;

  if public.is_screened(v_uid, p_category) then
    raise exception 'already_screened';
  end if;
  select count(*), min(a.created_at) into v_n, v_oldest from public.screening_attempts a
   where a.user_id = v_uid and a.category = p_category and a.created_at > now() - interval '24 hours';
  if v_n >= c_max then
    raise exception 'screening_rate_limited' using detail = (v_oldest + interval '24 hours')::text;
  end if;

  -- Validate the answers BEFORE anything is recorded: a malformed request never consumes an attempt.
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'invalid_answers';
  end if;
  if (select count(*) from jsonb_object_keys(p_answers)) <>
     (select count(*) from public.screening_questions q where q.category = p_category and q.version = v_ver) then
    raise exception 'invalid_answers';
  end if;
  for v_q in
    select q.qid, q.options from public.screening_questions q
     where q.category = p_category and q.version = v_ver order by q.position
  loop
    v_arr := p_answers -> v_q.qid;
    if v_arr is null or jsonb_typeof(v_arr) <> 'array' or jsonb_array_length(v_arr) < 1
       or jsonb_array_length(v_arr) > jsonb_array_length(v_q.options) then
      raise exception 'invalid_answers';
    end if;
    v_ids := '{}';
    for v_el in select value from jsonb_array_elements(v_arr) loop
      if jsonb_typeof(v_el) <> 'string'
         or not exists (select 1 from jsonb_array_elements(v_q.options) o where o ->> 'id' = v_el #>> '{}')
         or (v_el #>> '{}') = any (v_ids) then
        raise exception 'invalid_answers';
      end if;
      v_ids := v_ids || (v_el #>> '{}');
    end loop;
    if 'none' = any (v_ids) and cardinality(v_ids) > 1 then
      raise exception 'invalid_answers';
    end if;
    if not (v_ids = array['none']) then
      v_areas := v_areas + 1;
    end if;
  end loop;

  v_passed := v_areas >= v_min;
  insert into public.screening_attempts (user_id, category, version, passed, areas)
  values (v_uid, p_category, v_ver, v_passed, v_areas);

  return jsonb_build_object(
    'passed', v_passed,
    'areas', v_areas,
    'min_areas', v_min,
    'version', v_ver,
    'attempts_left', greatest(c_max - (v_n + 1), 0));
end;
$$;

create or replace function public.list_matched_campaigns()
returns table (
  campaign_id            uuid,
  project_name           text,
  description            text,
  task_description       text,
  created_at             timestamptz,
  expires_at             timestamptz,
  reserved_by_me         boolean,
  reservation_expires_at timestamptz,
  target_categories      text[],
  match_categories       text[],
  is_recommended         boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select coalesce(
             (select t.categories from public.tester_profiles t where t.user_id = auth.uid()),
             '{}'::text[]) as cats
  )
  select c.id, p.name, p.description, c.task_description, c.created_at, c.expires_at,
         (mine.id is not null), mine.expires_at,
         c.target_categories,
         mt.m,
         (cardinality(mt.m) > 0)
  from public.campaigns c
  join public.projects p on p.id = c.project_id
  cross join me
  cross join lateral (
    select array(
      select x from unnest(c.target_categories) as x where x = any (me.cats)
    ) as m
  ) mt
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
  order by (mine.id is not null) desc,
           (cardinality(mt.m) > 0) desc,
           cardinality(mt.m) desc,
           c.created_at asc,
           c.id asc
  limit 50
$$;

commit;

-- Re-applying migration 8's gate later (after the problem is fixed): run again, from
-- supabase/migrations/20261115000300_experience_profile.sql, ONLY the five "create or replace function" statements of
-- tester_eligibility, enforce_campaign_eligibility, list_matched_campaigns, get_screening, submit_screening.
