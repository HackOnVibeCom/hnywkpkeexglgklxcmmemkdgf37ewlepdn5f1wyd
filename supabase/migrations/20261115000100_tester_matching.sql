-- UXBarter - migration 6: Targeted Tester Matching v1
--
-- ADDITIVE ONLY. Nothing that exists is altered, dropped or re-granted:
--   * no existing table is rewritten (one new nullable-free column with a constant default on `campaigns`),
--   * no existing function is replaced (the old Discover / create RPCs keep working for the deployed UI),
--   * no existing policy or privilege changes.
-- Rolling back = redeploy the previous UI (it never calls anything below); the new objects can stay.
--
-- What it adds
--   1. public.tester_profiles       OPTIONAL, PRIVATE tester profile (nickname, short bio, categories).
--                                   RLS on, NO policy, NO grant: clients can only reach it through the RPCs
--                                   below, and each RPC only ever touches the caller's own row. Nobody can read
--                                   another identity's nickname or biography.
--   2. campaigns.target_categories  the founder's preferred tester categories (default empty = "anyone", i.e.
--                                   every existing campaign keeps behaving exactly as before).
--   3. RPCs (SECURITY DEFINER, search_path pinned, EXECUTE only for `authenticated`):
--        get_my_tester_profile / save_tester_profile / delete_my_tester_profile
--        create_targeted_campaign   - create_project_with_campaign + target categories, ONE transaction
--        list_matched_campaigns     - Discover feed with deterministic "recommended" ordering
--   4. normalize_tester_categories   internal validator (single source of truth for the allowed category ids).
--
-- Matching is a PREFERENCE, never a gate: start_test / submit_test / credits / reservations / rewards /
-- referral rules are untouched, so any tester can still test any open campaign (marketplace supply is small).
-- The matching rule is plain set intersection - deterministic and explainable, not a model.

-- ---------------------------------------------------------------------------
-- 1. The five categories live in ONE place. Adding a category later = replace this function (a new migration);
--    existing rows stay valid because they only contain ids that are still allowed.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_tester_categories(p_categories text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_allowed constant text[] := array[
    'tech_savvy',            -- Tech-Savvy Users
    'founders_builders',     -- Founders & Product Builders
    'business_office',       -- Business & Office Users
    'students_learners',     -- Students & Learners
    'everyday_nontechnical'  -- Everyday & Non-Technical Users
  ];
begin
  if p_categories is null then
    return '{}'::text[];
  end if;
  -- Unknown ids, NULL elements and anything else are rejected (never silently dropped).
  if exists (select 1 from unnest(p_categories) as c where c is null or not (c = any (c_allowed))) then
    raise exception 'invalid_categories';
  end if;
  -- Canonical form: distinct ids in the fixed order above.
  return array(
    select a.id
    from unnest(c_allowed) with ordinality as a(id, ord)
    where a.id = any (p_categories)
    order by a.ord
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Private tester profile. One row per anonymous identity, optional.
-- ---------------------------------------------------------------------------
create table public.tester_profiles (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  nickname   text        not null check (char_length(nickname) between 2 and 30),
  bio        text        check (bio is null or char_length(bio) <= 280),
  categories text[]      not null default '{}'
             constraint tester_profiles_categories_canonical check (categories = public.normalize_tester_categories(categories)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tester_profiles enable row level security;
-- No policy and no grant on purpose: clients never touch this table directly (RPC-only).
revoke all on public.tester_profiles from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Campaign target audience. Constant default => existing rows are not rewritten and read as "no preference".
--    Owners already hold table-level SELECT on campaigns (RLS: own rows only); nobody holds UPDATE, so the
--    value can only be set through create_targeted_campaign.
-- ---------------------------------------------------------------------------
alter table public.campaigns
  add column target_categories text[] not null default '{}',
  add constraint campaigns_target_categories_canonical
    check (target_categories = public.normalize_tester_categories(target_categories));

-- ---------------------------------------------------------------------------
-- 4. Profile RPCs. Each one only ever reads / writes the caller's own row (auth.uid()).
-- ---------------------------------------------------------------------------
create or replace function public.get_my_tester_profile()
returns table (nickname text, bio text, categories text[], updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.nickname, t.bio, t.categories, t.updated_at
  from public.tester_profiles t
  where t.user_id = auth.uid()
$$;

create or replace function public.save_tester_profile(p_nickname text, p_bio text, p_categories text[])
returns table (nickname text, bio text, categories text[], updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_nick text;
  v_bio  text;
  v_cats text[];
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'profile_missing';
  end if;

  -- Whitespace (incl. newlines) collapses to single spaces; trim_all also strips zero-width characters.
  v_nick := public.trim_all(regexp_replace(coalesce(p_nickname, ''), '[[:space:]]+', ' ', 'g'));
  v_bio  := nullif(public.trim_all(regexp_replace(coalesce(p_bio, ''), '[[:space:]]+', ' ', 'g')), '');

  if char_length(v_nick) not between 2 and 30 or v_nick ~ '[[:cntrl:]]' then
    raise exception 'invalid_nickname';
  end if;
  if v_bio is not null and (char_length(v_bio) > 280 or v_bio ~ '[[:cntrl:]]') then
    raise exception 'invalid_bio';
  end if;
  v_cats := public.normalize_tester_categories(p_categories); -- raises invalid_categories

  return query
  insert into public.tester_profiles as t (user_id, nickname, bio, categories)
  values (v_uid, v_nick, v_bio, v_cats)
  on conflict (user_id) do update
     set nickname   = excluded.nickname,
         bio        = excluded.bio,
         categories = excluded.categories,
         updated_at = clock_timestamp()
  returning t.nickname, t.bio, t.categories, t.updated_at;
end;
$$;

create or replace function public.delete_my_tester_profile()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  n     integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  delete from public.tester_profiles where user_id = v_uid;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. create_targeted_campaign: validates the categories FIRST (so a bad request spends nothing), then delegates
--    to the unchanged create_project_with_campaign (all credit / locking / validation logic stays in ONE place),
--    then stamps the audience on the new campaign. One function call = one transaction.
--    A SEPARATE name (not an overload) keeps PostgREST routing unambiguous for old and new clients.
-- ---------------------------------------------------------------------------
create or replace function public.create_targeted_campaign(
  p_name              text,
  p_url               text,
  p_description       text,
  p_task              text,
  p_target_categories text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cats text[];
  v_id   uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  v_cats := public.normalize_tester_categories(p_target_categories); -- raises invalid_categories before any credit moves
  v_id := public.create_project_with_campaign(p_name, p_url, p_description, p_task);
  if cardinality(v_cats) > 0 then
    update public.campaigns set target_categories = v_cats where id = v_id and owner_id = auth.uid();
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. list_matched_campaigns: same visibility rules as list_open_campaigns (kept in sync by a parity test), plus
--    the audience fields. Ordering is a pure function of the data:
--      1. my own live reservation first (unchanged behaviour),
--      2. campaigns whose audience overlaps MY categories, most overlapping categories first,
--      3. everything else; within each group oldest first (waiting founders are served first), id as final tiebreak.
--    The ordering happens BEFORE `limit 50`, so a recommended task is never cut off by older, unrelated ones.
--    With no profile, no categories, or a campaign without a target, nothing is "recommended" and the order is
--    exactly the old one. match_categories is computed for the CALLER only; no other identity's data is exposed.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 7. Privileges (explicit: "automatic table exposure" is disabled on the project and new functions are
--    EXECUTE-able by PUBLIC unless revoked).
-- ---------------------------------------------------------------------------
revoke all on function public.normalize_tester_categories(text[]) from public, anon, authenticated;

revoke all on function public.get_my_tester_profile()                                 from public, anon;
revoke all on function public.save_tester_profile(text, text, text[])                 from public, anon;
revoke all on function public.delete_my_tester_profile()                              from public, anon;
revoke all on function public.create_targeted_campaign(text, text, text, text, text[]) from public, anon;
revoke all on function public.list_matched_campaigns()                                from public, anon;

grant execute on function public.get_my_tester_profile()                                 to authenticated;
grant execute on function public.save_tester_profile(text, text, text[])                 to authenticated;
grant execute on function public.delete_my_tester_profile()                              to authenticated;
grant execute on function public.create_targeted_campaign(text, text, text, text, text[]) to authenticated;
grant execute on function public.list_matched_campaigns()                                to authenticated;
