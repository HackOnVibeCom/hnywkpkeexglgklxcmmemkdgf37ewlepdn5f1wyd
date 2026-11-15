-- UXBarter - migration 7: Matching v2 = explicit Open vs Targeted testing + category qualification screening
--
-- ADDITIVE, and it does NOT change any existing function body. What it adds:
--   * campaigns.testing_mode ('open' | 'targeted'), default 'open'. EVERY existing campaign - including those created
--     with Matching v1 "preferred categories" - stays OPEN: they keep behaving exactly as before (v1 categories remain a
--     mere recommendation hint on open campaigns). Nothing is silently converted into a restricted campaign.
--   * Targeted testing: the founder picks >= 1 REQUIRED categories (stored in the existing target_categories column).
--     A tester is eligible when their profile contains at least one required category AND, for that category,
--       - Students & Learners / Everyday & Non-Technical Users (general): nothing more is needed;
--       - Tech-Savvy Users / Founders & Product Builders / Business & Office Users (professional): they hold a
--         completed screening for that category at the CURRENT screening version.
--     Eligibility is enforced INSIDE PostgreSQL by a trigger on test_reservations, i.e. at the moment a reservation
--     window is created (start_test, re-reserving a lapsed reservation). A live reservation is never re-checked, and
--     submit_test needs a live reservation, so editing the profile mid-test cannot break a valid in-progress test and
--     an ineligible tester can neither reserve nor submit. The React UI only explains; it enforces nothing.
--   * Screening: short, experience-based, SELF-REPORTED questions per professional category (4 each). It is NOT a
--     verification of any credential. Only the outcome is stored (category, version, passed, number of areas, time);
--     the individual answers are evaluated and discarded. Retakes are limited to 3 attempts per category per rolling
--     24 hours; a tester who is already screened at the current version cannot re-submit.
--   * RPCs (SECURITY DEFINER, search_path = '', EXECUTE for `authenticated` only):
--       create_campaign_v2, list_campaigns_v2, get_campaign_eligibility,
--       get_screening, submit_screening, get_my_screening_status
--   * Internal helpers (not executable by clients): category_requires_screening, screening_current_version,
--       is_screened, tester_eligibility, enforce_campaign_eligibility (trigger function).
-- start_test / submit_test / credits / reservations / daily cap / referrals / expiry / refunds are untouched.
-- Rolling back = redeploy the previous UI (it never calls anything below) and, if ever needed, the down script in
-- docs/MATCHING_V2_ROLLOUT.md. The one behavioural change visible to an OLD UI is that a TARGETED campaign (which only
-- the new UI can create) refuses an ineligible tester's reservation with 'not_eligible'.

-- ---------------------------------------------------------------------------
-- 1. Campaign mode. Constant default => no table rewrite, every existing row reads 'open'.
-- ---------------------------------------------------------------------------
alter table public.campaigns
  add column testing_mode text not null default 'open'
    constraint campaigns_testing_mode_check check (testing_mode in ('open', 'targeted')),
  add constraint campaigns_targeted_requires_categories
    check (testing_mode <> 'targeted' or cardinality(target_categories) >= 1);

-- ---------------------------------------------------------------------------
-- 2. Which categories require screening. Single source of truth.
-- ---------------------------------------------------------------------------
create or replace function public.category_requires_screening(p_category text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_category in ('tech_savvy', 'founders_builders', 'business_office')
$$;

-- ---------------------------------------------------------------------------
-- 3. Screening content (reference data, versioned) and attempt outcomes. RLS on, NO policy, NO grant:
--    clients only reach these through the RPCs below.
-- ---------------------------------------------------------------------------
create table public.screening_versions (
  category   text        not null check (public.category_requires_screening(category)),
  version    integer     not null check (version >= 1),
  min_areas  smallint    not null check (min_areas >= 1),
  created_at timestamptz not null default now(),
  primary key (category, version)
);

create table public.screening_questions (
  category text     not null,
  version  integer  not null,
  qid      text     not null check (qid ~ '^q[1-9]$'),
  position smallint not null check (position between 1 and 9),
  prompt   text     not null check (char_length(prompt) between 10 and 200),
  options  jsonb    not null check (jsonb_typeof(options) = 'array'),
  primary key (category, version, qid),
  unique (category, version, position),
  foreign key (category, version) references public.screening_versions (category, version) on delete cascade
);

-- One row per submitted attempt. NO answers are stored (data minimisation): only the outcome.
create table public.screening_attempts (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  category   text        not null check (public.category_requires_screening(category)),
  version    integer     not null,
  passed     boolean     not null,
  areas      smallint    not null check (areas >= 0),
  created_at timestamptz not null default clock_timestamp()
);
create index screening_attempts_user_cat_idx on public.screening_attempts (user_id, category, created_at desc);

alter table public.screening_versions  enable row level security;
alter table public.screening_questions enable row level security;
alter table public.screening_attempts  enable row level security;
revoke all on public.screening_versions  from anon, authenticated;
revoke all on public.screening_questions from anon, authenticated;
revoke all on public.screening_attempts  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Screening content, version 1: 4 experience-based questions per professional category.
--    Practical activities, real tools, real work. No trivia, no demographics. The last option of every question is
--    "None of these" (id 'none'). Passing = hands-on experience reported in at least 2 of the 4 areas (min_areas = 2).
-- ---------------------------------------------------------------------------
insert into public.screening_versions (category, version, min_areas) values
  ('tech_savvy', 1, 2), ('founders_builders', 1, 2), ('business_office', 1, 2);

insert into public.screening_questions (category, version, qid, position, prompt, options) values
('tech_savvy', 1, 'q1', 1, 'In the last 12 months, which of these have you done yourself?', $j$[
  {"id":"code","label":"Wrote or edited code or scripts"},
  {"id":"terminal","label":"Used a terminal or command line"},
  {"id":"setup","label":"Installed or configured software or devices beyond the default settings (for example self-hosting, a home network or automations)"},
  {"id":"integrate","label":"Connected tools with APIs, webhooks or automation services"},
  {"id":"none","label":"None of these"}]$j$::jsonb),
('tech_savvy', 1, 'q2', 2, 'Which of these tools have you used regularly?', $j$[
  {"id":"git","label":"Git or GitHub (or a similar version control tool)"},
  {"id":"editor","label":"A code editor or IDE"},
  {"id":"devtools","label":"Browser developer tools"},
  {"id":"cloud","label":"A cloud or hosting console (for example AWS, Google Cloud, Azure, Vercel or Netlify)"},
  {"id":"pkg","label":"A package manager or build tool"},
  {"id":"none","label":"None of these"}]$j$::jsonb),
('tech_savvy', 1, 'q3', 3, 'Which of these have you done when trying new software?', $j$[
  {"id":"docs","label":"Read technical documentation or a changelog"},
  {"id":"bug","label":"Reported a bug or requested a feature"},
  {"id":"beta","label":"Tried a beta or early-access product"},
  {"id":"compare","label":"Compared several alternatives in detail before choosing one"},
  {"id":"none","label":"None of these"}]$j$::jsonb),
('tech_savvy', 1, 'q4', 4, 'Which of these have you done in a job, your studies or a project?', $j$[
  {"id":"qa","label":"Tested software or checked it against requirements"},
  {"id":"support","label":"Troubleshot technical problems for other people"},
  {"id":"deploy","label":"Deployed or maintained an app, website or service"},
  {"id":"automate","label":"Automated a repetitive task with a script or tool"},
  {"id":"none","label":"None of these"}]$j$::jsonb),

('founders_builders', 1, 'q1', 1, 'Which of these have you done yourself?', $j$[
  {"id":"launch","label":"Launched a product, service or side project"},
  {"id":"company","label":"Started or helped run a startup or small company"},
  {"id":"team","label":"Worked in a product, design or engineering team on a software product"},
  {"id":"validate","label":"Tested an idea with potential customers before building it"},
  {"id":"none","label":"None of these"}]$j$::jsonb),
('founders_builders', 1, 'q2', 2, 'Which product-building activities have you done in the last 12 months?', $j$[
  {"id":"spec","label":"Wrote a product spec, roadmap or user stories"},
  {"id":"design","label":"Designed screens or prototypes"},
  {"id":"research","label":"Ran user interviews or usability tests"},
  {"id":"metrics","label":"Defined success metrics or reviewed product analytics"},
  {"id":"none","label":"None of these"}]$j$::jsonb),
('founders_builders', 1, 'q3', 3, 'Which tools have you used to build or run a product?', $j$[
  {"id":"tracker","label":"An issue or project tracker (for example Jira, Linear or Trello)"},
  {"id":"design_tool","label":"A design or prototyping tool (for example Figma)"},
  {"id":"analytics","label":"A product analytics tool (for example Google Analytics, Mixpanel or Amplitude)"},
  {"id":"nocode","label":"A no-code or low-code builder"},
  {"id":"site","label":"A website or landing page builder"},
  {"id":"none","label":"None of these"}]$j$::jsonb),
('founders_builders', 1, 'q4', 4, 'Which of these have you done with real users or customers?', $j$[
  {"id":"talk","label":"Talked to customers about the problem a product solves"},
  {"id":"ship","label":"Shipped a change based on user feedback"},
  {"id":"support","label":"Handled customer support requests for a product"},
  {"id":"pilot","label":"Ran a pilot, beta or waitlist"},
  {"id":"none","label":"None of these"}]$j$::jsonb),

('business_office', 1, 'q1', 1, 'Which of these tasks do you handle in a job or business?', $j$[
  {"id":"finance","label":"Invoicing, bookkeeping or accounting"},
  {"id":"admin","label":"Scheduling, calendars or administrative coordination"},
  {"id":"support","label":"Customer communication or support"},
  {"id":"sales","label":"Sales, quotes or lead follow-up"},
  {"id":"marketing","label":"Marketing, content or email campaigns"},
  {"id":"people","label":"Recruiting, HR or payroll"},
  {"id":"ops","label":"Orders, inventory or day-to-day operations"},
  {"id":"none","label":"None of these"}]$j$::jsonb),
('business_office', 1, 'q2', 2, 'Which kinds of business software do you use regularly?', $j$[
  {"id":"sheets","label":"Spreadsheets (for example Excel or Google Sheets)"},
  {"id":"accounting","label":"Accounting or invoicing software (for example QuickBooks or Xero)"},
  {"id":"crm","label":"A CRM (for example HubSpot, Salesforce or Pipedrive)"},
  {"id":"pm","label":"Project or task tools (for example Asana, Monday or Trello)"},
  {"id":"office","label":"Office suites, email and shared calendars"},
  {"id":"none","label":"None of these"}]$j$::jsonb),
('business_office', 1, 'q3', 3, 'Which of these have you done at work in the last 12 months?', $j$[
  {"id":"choose","label":"Helped choose or evaluate new software for a team"},
  {"id":"train","label":"Trained or onboarded colleagues on a tool"},
  {"id":"reports","label":"Built reports or dashboards"},
  {"id":"vendors","label":"Managed a budget, vendor or subscription"},
  {"id":"none","label":"None of these"}]$j$::jsonb),
('business_office', 1, 'q4', 4, 'Which processes have you been responsible for?', $j$[
  {"id":"billing","label":"Billing or collecting payments"},
  {"id":"onboard","label":"Onboarding customers or clients"},
  {"id":"booking","label":"Bookings, scheduling or dispatching"},
  {"id":"reporting","label":"Regular reporting to a manager or client"},
  {"id":"none","label":"None of these"}]$j$::jsonb);

-- ---------------------------------------------------------------------------
-- 5. Internal helpers (never callable from the API).
-- ---------------------------------------------------------------------------
create or replace function public.screening_current_version(p_category text)
returns integer
language sql
stable
set search_path = ''
as $$
  select max(v.version) from public.screening_versions v where v.category = p_category
$$;

-- Screened = a PASSED attempt at the CURRENT version. A later failed attempt never revokes it; a new content
-- version (a new row in screening_versions) requires a fresh screening.
create or replace function public.is_screened(p_user uuid, p_category text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.screening_attempts a
    where a.user_id = p_user and a.category = p_category and a.passed
      and a.version = public.screening_current_version(p_category)
  )
$$;

-- The single eligibility rule. Open campaigns: always eligible. Targeted: profile must include >= 1 required category
-- and, for professional categories, a current screening. Reasons: no_profile | category_mismatch | screening_required.
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

-- ---------------------------------------------------------------------------
-- 6. SERVER-SIDE ENFORCEMENT: a reservation window can only be created by an eligible tester.
--    Fires on INSERT and when started_at is rewritten (re-reserving a lapsed reservation). It does NOT fire when a
--    reservation is consumed (consumed_at) and start_test returns a live reservation before it ever reaches a write,
--    so a valid in-progress test is never disturbed by a later profile edit.
-- ---------------------------------------------------------------------------
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

create trigger test_reservations_eligibility
  before insert or update of started_at on public.test_reservations
  for each row execute function public.enforce_campaign_eligibility();

-- ---------------------------------------------------------------------------
-- 7. create_campaign_v2: explicit mode. Validates BEFORE any credit moves, then delegates to the unchanged
--    create_project_with_campaign (all credit / locking logic stays in one place), then stamps mode + categories.
--      open     : categories (optional) are PREFERRED = a recommendation hint, nobody is excluded.
--      targeted : >= 1 REQUIRED category; only eligible testers can reserve.
-- ---------------------------------------------------------------------------
create or replace function public.create_campaign_v2(
  p_name        text,
  p_url         text,
  p_description text,
  p_task        text,
  p_mode        text,
  p_categories  text[]
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
  if p_mode is null or p_mode not in ('open', 'targeted') then
    raise exception 'invalid_mode';
  end if;
  v_cats := public.normalize_tester_categories(p_categories); -- raises invalid_categories
  if p_mode = 'targeted' and cardinality(v_cats) = 0 then
    raise exception 'targeted_requires_categories';
  end if;

  v_id := public.create_project_with_campaign(p_name, p_url, p_description, p_task);
  update public.campaigns
     set testing_mode = p_mode, target_categories = v_cats
   where id = v_id and owner_id = auth.uid();
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Discover feed. Same visibility rules as list_open_campaigns / list_matched_campaigns (a parity test keeps them in
--    sync): targeted campaigns are SHOWN to everyone (a non-eligible tester may view them) but flagged.
--    fit: 'recommended' (eligible and my categories overlap) | 'eligible' | 'not_eligible'.
--    Order (before LIMIT 50): my live reservation, recommended, eligible, not_eligible; then more overlapping
--    categories, oldest first, id.
-- ---------------------------------------------------------------------------
create or replace function public.list_campaigns_v2()
returns table (
  campaign_id            uuid,
  project_name           text,
  description            text,
  task_description       text,
  created_at             timestamptz,
  expires_at             timestamptz,
  reserved_by_me         boolean,
  reservation_expires_at timestamptz,
  testing_mode           text,
  target_categories      text[],
  match_categories       text[],
  fit                    text,
  eligible               boolean,
  ineligible_reason      text,
  missing_screening      text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, p.name, p.description, c.task_description, c.created_at, c.expires_at,
         (mine.id is not null), mine.expires_at,
         c.testing_mode, c.target_categories,
         el.overlap,
         case when not (el.eligible or mine.id is not null) then 'not_eligible'
              when cardinality(el.overlap) > 0               then 'recommended'
              else 'eligible' end,
         (el.eligible or mine.id is not null),
         case when el.eligible or mine.id is not null then null else el.reason end,
         case when el.eligible or mine.id is not null then '{}'::text[] else el.missing_screening end
  from public.campaigns c
  join public.projects p on p.id = c.project_id
  left join public.test_reservations mine
         on mine.campaign_id = c.id and mine.tester_id = auth.uid()
        and mine.consumed_at is null and mine.expires_at > now()
  cross join lateral public.tester_eligibility(auth.uid(), c.testing_mode, c.target_categories) as el
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
           case when not (el.eligible or mine.id is not null) then 2
                when cardinality(el.overlap) > 0               then 0
                else 1 end asc,
           cardinality(el.overlap) desc,
           c.created_at asc,
           c.id asc
  limit 50
$$;

-- What the test page needs to EXPLAIN why a tester can or cannot start (reasons are enforced by the trigger above).
create or replace function public.get_campaign_eligibility(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_c    public.campaigns;
  v_e    record;
  v_hold boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  select * into v_c from public.campaigns where id = p_campaign_id;
  if not found or v_c.status <> 'open' then
    return null;
  end if;
  v_hold := exists (
    select 1 from public.test_reservations r
    where r.campaign_id = v_c.id and r.tester_id = v_uid and r.consumed_at is null and r.expires_at > clock_timestamp());
  select * into v_e from public.tester_eligibility(v_uid, v_c.testing_mode, v_c.target_categories);
  return jsonb_build_object(
    'campaign_id', v_c.id,
    'testing_mode', v_c.testing_mode,
    'required_categories', to_jsonb(v_c.target_categories),
    'eligible', (v_hold or v_e.eligible),
    'reason', case when v_hold then 'in_progress' else v_e.reason end,
    'missing_screening', case when v_hold then '[]'::jsonb else to_jsonb(v_e.missing_screening) end,
    'overlap', to_jsonb(v_e.overlap),
    'own_campaign', (v_c.owner_id = v_uid));
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Screening RPCs.
-- ---------------------------------------------------------------------------
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

create or replace function public.get_my_screening_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max  constant integer := 3;
  v_uid  uuid := auth.uid();
  v_out  jsonb := '[]'::jsonb;
  v_cat  text;
  v_ver  integer;
  v_used integer;
  v_old  timestamptz;
  v_when timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  foreach v_cat in array array['tech_savvy', 'founders_builders', 'business_office'] loop
    v_ver := public.screening_current_version(v_cat);
    select count(*), min(a.created_at) into v_used, v_old from public.screening_attempts a
     where a.user_id = v_uid and a.category = v_cat and a.created_at > now() - interval '24 hours';
    select max(a.created_at) into v_when from public.screening_attempts a
     where a.user_id = v_uid and a.category = v_cat and a.passed and a.version = v_ver;
    v_out := v_out || jsonb_build_object(
      'category', v_cat,
      'version', v_ver,
      'qualified', (v_when is not null),
      'qualified_at', v_when,
      'attempts_left', greatest(c_max - v_used, 0),
      'next_attempt_at', case when v_used >= c_max then v_old + interval '24 hours' end);
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges (explicit: new functions are EXECUTE-able by PUBLIC unless revoked).
-- ---------------------------------------------------------------------------
revoke all on function public.category_requires_screening(text)               from public, anon, authenticated;
revoke all on function public.screening_current_version(text)                 from public, anon, authenticated;
revoke all on function public.is_screened(uuid, text)                         from public, anon, authenticated;
revoke all on function public.tester_eligibility(uuid, text, text[])          from public, anon, authenticated;
revoke all on function public.enforce_campaign_eligibility()                  from public, anon, authenticated;

revoke all on function public.create_campaign_v2(text, text, text, text, text, text[]) from public, anon;
revoke all on function public.list_campaigns_v2()                             from public, anon;
revoke all on function public.get_campaign_eligibility(uuid)                  from public, anon;
revoke all on function public.get_screening(text)                             from public, anon;
revoke all on function public.submit_screening(text, jsonb)                   from public, anon;
revoke all on function public.get_my_screening_status()                       from public, anon;

grant execute on function public.create_campaign_v2(text, text, text, text, text, text[]) to authenticated;
grant execute on function public.list_campaigns_v2()                          to authenticated;
grant execute on function public.get_campaign_eligibility(uuid)               to authenticated;
grant execute on function public.get_screening(text)                          to authenticated;
grant execute on function public.submit_screening(text, jsonb)                to authenticated;
grant execute on function public.get_my_screening_status()                    to authenticated;
