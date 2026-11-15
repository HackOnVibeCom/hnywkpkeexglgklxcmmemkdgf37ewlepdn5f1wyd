-- UXBarter - migration 8: Experience profile (four open-ended answers per category), qualification, AI consent
--
-- Replaces the multiple-choice screening of migration 7 (which is already live and is NOT edited) with:
--   * FOUR SHORT-ANSWER questions per category for ALL five categories (versioned, category specific),
--   * the tester's answers STORED (owner-only; RLS on, no policy, no client grant; only SECURITY DEFINER RPCs touch them),
--   * an explicit, revocable CONSENT to AI processing (nothing may be sent to an AI service without it),
--   * a qualification record for the three PROFESSIONAL categories that only a SERVER-ONLY interface (service_role) can
--     write: nothing in the browser, and no timeout, can create a pass,
--   * a participation rule enforced in PostgreSQL: to reserve ANY task (open or targeted) a tester must have completed the
--     four answers of at least one selected category.
--
-- Category states (computed, never stored):
--   inactive            not in the profile
--   incomplete          in the profile, four answers for the CURRENT question version are missing
--   active              general category (Students & Learners, Everyday & Non-Technical): answers complete.
--                       professional category: answers complete AND a valid 'qualified' decision exists
--   pending_assessment  professional, answers complete, no valid decision yet (waits for the AI assessment service)
--   not_qualified       professional, a valid 'not_qualified' decision for the current answers (editing the answers re-opens it)
-- A decision is valid only for the exact answers (sha256) and question version it was made for.
--
-- NOT touched: start_test / submit_test, credits, referrals, reservations (15 min), the 60 s minimum, the daily reward cap,
-- CAPTCHA, anonymous auth, campaigns, migrations 1-7. Function bodies replaced here (same signatures): tester_eligibility,
-- enforce_campaign_eligibility, list_matched_campaigns, get_screening, submit_screening (the last two now refuse, so the old
-- multiple-choice rule can never create a pass again). Everything else is new.

-- ---------------------------------------------------------------------------
-- 1. Tables. RLS on, NO policy, NO grant: clients only reach them through the RPCs below.
-- ---------------------------------------------------------------------------
create table public.experience_questions (
  category   text        not null check (category in ('tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical')),
  version    integer     not null check (version >= 1),
  position   smallint    not null check (position between 1 and 4),
  qid        text        not null check (qid ~ '^q[1-4]$'),
  prompt     text        not null check (char_length(prompt) between 20 and 300),
  hint       text        check (hint is null or char_length(hint) <= 200),
  created_at timestamptz not null default now(),
  primary key (category, version, qid),
  unique (category, version, position)
);

-- One row per (identity, category): the LATEST answers. answers = {"q1": "...", ..., "q4": "..."} (validated, normalised).
create table public.experience_answers (
  user_id           uuid        not null references public.profiles (id) on delete cascade,
  category          text        not null check (category in ('tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical')),
  version           integer     not null check (version >= 1),
  answers           jsonb       not null check (jsonb_typeof(answers) = 'object' and octet_length(answers::text) <= 16000),
  answers_hash      text        not null check (answers_hash ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz not null default clock_timestamp(),
  updated_at        timestamptz not null default clock_timestamp(),
  primary key (user_id, category)
);

-- Save-rate state. Deliberately NOT part of experience_answers: deleting answers (delete_my_experience) must not reset the
-- limit, otherwise "delete + save" could re-trigger an assessment without bound. Fixed 24 h window per (identity, category).
create table public.experience_save_limits (
  user_id           uuid        not null references public.profiles (id) on delete cascade,
  category          text        not null check (category in ('tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical')),
  window_started_at timestamptz not null default clock_timestamp(),
  window_saves      smallint    not null default 1 check (window_saves >= 1),
  primary key (user_id, category)
);

-- Explicit, revocable consent to AI processing of the bio + answers. subject_ref is the ONLY identifier that may leave the
-- server towards an AI service; it is random (not derived from the account id) and rotates whenever consent is granted again.
create table public.ai_consents (
  user_id        uuid        primary key references public.profiles (id) on delete cascade,
  ai_processing  boolean     not null,
  policy_version smallint    not null default 1,
  subject_ref    uuid        not null default gen_random_uuid(),
  updated_at     timestamptz not null default clock_timestamp()
);

-- Qualification decisions for the PROFESSIONAL categories. Written ONLY by service_role (the assessment service). A decision is
-- bound to the answers it was made for (answers_hash + question_version). Passes of the retired multiple-choice screening
-- (migration 7) are deliberately NOT carried over: they cannot activate a category and cannot bypass the assessment.
create table public.category_qualifications (
  user_id          uuid        not null references public.profiles (id) on delete cascade,
  category         text        not null check (public.category_requires_screening(category)),
  status           text        not null check (status in ('qualified', 'not_qualified')),
  source           text        not null check (source = 'ai_assessment'),
  question_version integer     not null check (question_version >= 1),
  answers_hash     text        not null check (answers_hash ~ '^[0-9a-f]{64}$'),
  assessment       jsonb       check (assessment is null or octet_length(assessment::text) <= 4096),
  decided_at       timestamptz not null default clock_timestamp(),
  primary key (user_id, category)
);

-- Erasure signals for the AI service: one row whenever data that an AI service may have processed or cached is withdrawn or
-- deleted (consent withdrawn, answers deleted, tester profile removed, account deleted). Only the opaque subject_ref is stored.
-- The service reads it with service_list_erasure_events and must purge everything it keeps for that subject_ref.
create table public.ai_erasure_events (
  id          bigint      generated always as identity primary key,
  subject_ref uuid        not null,
  reason      text        not null check (reason in ('consent_withdrawn', 'answers_deleted', 'profile_removed', 'account_deleted')),
  category    text        check (category is null or category in ('tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical')),
  created_at  timestamptz not null default clock_timestamp()
);

alter table public.experience_questions    enable row level security;
alter table public.experience_answers      enable row level security;
alter table public.ai_consents             enable row level security;
alter table public.category_qualifications enable row level security;
alter table public.experience_save_limits  enable row level security;
alter table public.ai_erasure_events      enable row level security;
revoke all on public.ai_erasure_events       from anon, authenticated;
revoke all on public.experience_save_limits  from anon, authenticated;
revoke all on public.experience_questions    from anon, authenticated;
revoke all on public.experience_answers      from anon, authenticated;
revoke all on public.ai_consents             from anon, authenticated;
revoke all on public.category_qualifications from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Question content, version 1: four open-ended questions per category (experience, activities, tools, interests).
--    No multiple choice, no trivia, no demographics. A student can be an expert: no skill level is assumed from a category.
-- ---------------------------------------------------------------------------
insert into public.experience_questions (category, version, position, qid, prompt, hint) values
  ('tech_savvy', 1, 1, 'q1', 'What technologies, tools or software do you have experience using?', 'For example programming languages, developer tools, devices, platforms or apps you know well.'),
  ('tech_savvy', 1, 2, 'q2', 'Describe a technical project or activity you have worked on.', 'What was it, and what did you do yourself?'),
  ('tech_savvy', 1, 3, 'q3', 'Describe a technical problem you encountered and how you approached it.', 'How did you find the cause, and what did you try?'),
  ('tech_savvy', 1, 4, 'q4', 'What kinds of software or technology products are you most comfortable testing, and why?', null),

  ('founders_builders', 1, 1, 'q1', 'What products, startups or side projects have you built, launched or helped build, and what was your role?', 'Your own words. Real or small projects count.'),
  ('founders_builders', 1, 2, 'q2', 'Which tools do you use to plan, design, build, launch or measure a product?', 'For example design, analytics, no-code, project management or customer feedback tools.'),
  ('founders_builders', 1, 3, 'q3', 'Describe a product decision or trade-off you faced and how you made the call.', null),
  ('founders_builders', 1, 4, 'q4', 'What kinds of products or user journeys can you give the most useful feedback on, and why?', null),

  ('business_office', 1, 1, 'q1', 'What kind of work do you do, or have you done, in a business or office setting?', 'Your own words. No employer names are needed.'),
  ('business_office', 1, 2, 'q2', 'Which business or office tools do you use regularly?', 'For example spreadsheets, accounting, CRM, scheduling, email or collaboration tools.'),
  ('business_office', 1, 3, 'q3', 'Describe a work task or process you carry out with software, step by step.', null),
  ('business_office', 1, 4, 'q4', 'What types of business or workplace software are you most familiar with, and what do you find frustrating about them?', null),

  ('students_learners', 1, 1, 'q1', 'What subjects or fields are you currently studying or learning?', 'Any level. A learner can be an expert: nothing is assumed about your skill level.'),
  ('students_learners', 1, 2, 'q2', 'What tools, applications or technologies do you regularly use?', null),
  ('students_learners', 1, 3, 'q3', 'Describe a project, activity or skill you have developed through studying or independent learning.', null),
  ('students_learners', 1, 4, 'q4', 'What types of digital products do you feel familiar with or interested in testing?', null),

  ('everyday_nontechnical', 1, 1, 'q1', 'What do you mainly use apps, websites or devices for in your everyday life?', null),
  ('everyday_nontechnical', 1, 2, 'q2', 'Which apps, websites or services do you use most often?', null),
  ('everyday_nontechnical', 1, 3, 'q3', 'Describe a time you tried to do something with an app or website. What went well, and what was confusing?', null),
  ('everyday_nontechnical', 1, 4, 'q4', 'What kinds of products would you be happy to test, and which would you rather avoid?', null);

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (never callable from the API).
-- ---------------------------------------------------------------------------
create or replace function public.experience_current_version(p_category text)
returns integer
language sql
stable
set search_path = ''
as $$
  select max(v.version)
  from (
    select q.version from public.experience_questions q
    where q.category = p_category
    group by q.version
    having count(*) = 4
  ) v
$$;

-- Answers exist for the CURRENT question version (a new question version makes older answers "outdated" = incomplete).
create or replace function public.experience_complete(p_user uuid, p_category text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.experience_answers a
    where a.user_id = p_user and a.category = p_category
      and a.version = public.experience_current_version(p_category)
  )
$$;

-- A valid 'qualified' decision: general categories need none; a professional category needs an ASSESSMENT decision that is
-- valid only for the CURRENT question version AND the exact stored answers. (No other source exists.)
create or replace function public.is_qualified(p_user uuid, p_category text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when not public.category_requires_screening(p_category) then true
    else exists (
      select 1
      from public.category_qualifications q
      left join public.experience_answers a on a.user_id = q.user_id and a.category = q.category
      where q.user_id = p_user and q.category = p_category and q.status = 'qualified'
        and q.question_version = public.experience_current_version(p_category)
        and a.version = q.question_version and a.answers_hash = q.answers_hash
    )
  end
$$;

create or replace function public.category_state(p_user uuid, p_category text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_cats text[];
begin
  select t.categories into v_cats from public.tester_profiles t where t.user_id = p_user;
  if v_cats is null or not (p_category = any (v_cats)) then
    return 'inactive';
  end if;
  if not public.experience_complete(p_user, p_category) then
    return 'incomplete';
  end if;
  if not public.category_requires_screening(p_category) then
    return 'active';
  end if;
  if public.is_qualified(p_user, p_category) then
    return 'active';
  end if;
  if exists (
    select 1
    from public.category_qualifications q
    join public.experience_answers a on a.user_id = q.user_id and a.category = q.category
    where q.user_id = p_user and q.category = p_category and q.status = 'not_qualified' and q.source = 'ai_assessment'
      and q.question_version = a.version and a.answers_hash = q.answers_hash
      and a.version = public.experience_current_version(p_category)
  ) then
    return 'not_qualified';
  end if;
  return 'pending_assessment';
end;
$$;

-- The one definition of "active categories" (what counts for targeted eligibility and for matching).
create or replace function public.active_tester_categories(p_user uuid)
returns text[]
language sql
stable
set search_path = ''
as $$
  -- Must stay equivalent to category_state(p_user, c) = 'active' (tested): selected + complete answers (current version) and, for
  -- professional categories, a valid qualified decision for exactly these answers.
  select coalesce(
    array(
      select c.id
      from unnest(array['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical']) with ordinality as c(id, ord)
      join public.tester_profiles t on t.user_id = p_user and c.id = any (t.categories)
      join public.experience_answers a on a.user_id = p_user and a.category = c.id and a.version = public.experience_current_version(c.id)
      left join public.category_qualifications q on q.user_id = p_user and q.category = c.id and q.status = 'qualified'
      where not public.category_requires_screening(c.id)
         or (q.user_id is not null and q.question_version = a.version and q.answers_hash = a.answers_hash)
      order by c.ord
    ),
    '{}'::text[])
$$;

-- PARTICIPATION RULE: at least one SELECTED category has its four answers (current version). Professional categories count
-- here even while still pending assessment: this is profile completion, not qualification.
create or replace function public.tester_participation_ready(p_user uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.tester_profiles t, unnest(t.categories) as c(id)
    where t.user_id = p_user and public.experience_complete(p_user, c.id)
  )
$$;

-- Validates and normalises four answers. Basic input validation only: this is NOT a judgement of the content.
create or replace function public.normalize_experience_answers(p_category text, p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  c_min constant integer := 15;
  c_max constant integer := 800;
  v_ver   integer := public.experience_current_version(p_category);
  v_qid   text;
  v_raw   jsonb;
  v_txt   text;
  v_words text[];
  v_out   jsonb := '{}'::jsonb;
begin
  if v_ver is null then
    raise exception 'invalid_category';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object'
     or (select count(*) from jsonb_object_keys(p_answers)) <> 4 then
    raise exception 'invalid_answers' using detail = 'shape';
  end if;
  for v_qid in select q.qid from public.experience_questions q where q.category = p_category and q.version = v_ver order by q.position loop
    v_raw := p_answers -> v_qid;
    if v_raw is null or jsonb_typeof(v_raw) <> 'string' then
      raise exception 'invalid_answers' using detail = v_qid || ':missing';
    end if;
    if octet_length(v_raw #>> '{}') > 6000 then
      raise exception 'invalid_answers' using detail = v_qid || ':too_long'; -- before any regexp work
    end if;
    -- whitespace (incl. newlines) collapses to single spaces; trim_all also strips zero-width characters
    v_txt := public.trim_all(regexp_replace(v_raw #>> '{}', '[[:space:]]+', ' ', 'g'));
    if v_txt ~ '[[:cntrl:]]' then
      raise exception 'invalid_answers' using detail = v_qid || ':control_chars';
    end if;
    if char_length(v_txt) < c_min then
      raise exception 'invalid_answers' using detail = v_qid || ':too_short';
    end if;
    if char_length(v_txt) > c_max then
      raise exception 'invalid_answers' using detail = v_qid || ':too_long';
    end if;
    v_words := regexp_split_to_array(v_txt, ' ');
    if cardinality(v_words) < 3 or (select count(distinct lower(w)) from unnest(v_words) as w) < 3 then
      raise exception 'invalid_answers' using detail = v_qid || ':too_few_words';
    end if;
    v_out := v_out || jsonb_build_object(v_qid, v_txt);
  end loop;
  -- four copies of the same text are not four answers
  if (select count(distinct lower(v)) from jsonb_each_text(v_out) as e(k, v)) < 4 then
    raise exception 'invalid_answers' using detail = 'duplicate_answers';
  end if;
  return v_out;
end;
$$;

-- Deterministic fingerprint of a set of answers (the decision binds to it; the browser never supplies it).
create or replace function public.experience_hash(p_version integer, p_answers jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    sha256(convert_to(
      p_version::text
      || '|' || char_length(coalesce(p_answers ->> 'q1', '')) || ':' || coalesce(p_answers ->> 'q1', '')
      || '|' || char_length(coalesce(p_answers ->> 'q2', '')) || ':' || coalesce(p_answers ->> 'q2', '')
      || '|' || char_length(coalesce(p_answers ->> 'q3', '')) || ':' || coalesce(p_answers ->> 'q3', '')
      || '|' || char_length(coalesce(p_answers ->> 'q4', '')) || ':' || coalesce(p_answers ->> 'q4', ''), 'UTF8')),
    'hex')
$$;

-- One category's status as JSON (never contains the answers themselves).
create or replace function public.experience_category_json(p_user uuid, p_category text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_state   text := public.category_state(p_user, p_category);
  v_cur     integer := public.experience_current_version(p_category);
  v_a       record;
  v_q       record;
  v_consent boolean;
  v_reason  text;
  v_qual    jsonb := null;
begin
  select a.version, a.updated_at into v_a from public.experience_answers a where a.user_id = p_user and a.category = p_category;
  select coalesce((select c.ai_processing from public.ai_consents c where c.user_id = p_user), false) into v_consent;
  if v_state in ('active', 'not_qualified') and public.category_requires_screening(p_category) then
    select q.status, q.source, q.decided_at into v_q from public.category_qualifications q where q.user_id = p_user and q.category = p_category;
    if found then
      v_qual := jsonb_build_object('status', v_q.status, 'source', v_q.source, 'decided_at', v_q.decided_at);
    end if;
  end if;
  v_reason := case v_state
    when 'inactive' then 'not_selected'
    when 'incomplete' then case when v_a.version is not null then 'questions_changed' else 'answers_needed' end
    when 'pending_assessment' then case when v_consent then 'awaiting_assessment' else 'consent_required' end
    when 'not_qualified' then 'not_qualified'
    else 'active' end;
  return jsonb_build_object(
    'category', p_category,
    'requires_assessment', public.category_requires_screening(p_category),
    'selected', v_state <> 'inactive',
    'state', v_state,
    'reason', v_reason,
    'question_version', v_cur,
    'answers_version', v_a.version,
    'answers_complete', public.experience_complete(p_user, p_category),
    'answers_updated_at', v_a.updated_at,
    'qualification', v_qual);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Eligibility, now over ACTIVE categories plus the participation rule. Same signature and column names as migration 7
--    (missing_screening = categories that still need qualification: incomplete answers or pending assessment).
--    Reasons: profile_incomplete | category_mismatch | qualification_required (| open | eligible)
-- ---------------------------------------------------------------------------
create or replace function public.tester_eligibility(p_user uuid, p_mode text, p_required text[])
returns table (eligible boolean, reason text, missing_screening text[], overlap text[])
language plpgsql
stable
set search_path = ''
as $$
declare
  v_cats    text[];
  v_active  text[];
  v_overlap text[];
  v_pending text[];
begin
  if not public.tester_participation_ready(p_user) then
    return query select false, 'profile_incomplete'::text, '{}'::text[], '{}'::text[];
    return;
  end if;
  select t.categories into v_cats from public.tester_profiles t where t.user_id = p_user;
  v_cats    := coalesce(v_cats, '{}'::text[]);
  v_active  := public.active_tester_categories(p_user);
  v_overlap := array(select x from unnest(p_required) as x where x = any (v_active));

  if p_mode <> 'targeted' then
    return query select true, 'open'::text, '{}'::text[], v_overlap;
    return;
  end if;
  if cardinality(v_overlap) > 0 then
    return query select true, 'eligible'::text, '{}'::text[], v_overlap;
    return;
  end if;
  v_pending := array(select x from unnest(p_required) as x where x = any (v_cats));
  if cardinality(v_pending) = 0 then
    return query select false, 'category_mismatch'::text, '{}'::text[], '{}'::text[];
    return;
  end if;
  return query select false, 'qualification_required'::text, v_pending, '{}'::text[];
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. SERVER-SIDE ENFORCEMENT (same trigger as migration 7, new body). A reservation window can only be created by a
--    participation-ready tester - open tasks included - and, for targeted tasks, only by one with an active required
--    category. It fires when a window is CREATED (insert, or re-reserving a lapsed reservation): never on a live
--    reservation or on submit, so an in-progress test is never disturbed by a later profile / answer / question change.
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
  select * into v_e from public.tester_eligibility(new.tester_id, coalesce(v_mode, 'open'), coalesce(v_req, '{}'::text[]));
  if not v_e.eligible then
    raise exception 'not_eligible' using detail = v_e.reason;
  end if;
  return new;
end;
$$;

-- Matching v1 feed (used only by an older UI): recommends on ACTIVE categories only.
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
    select public.active_tester_categories(auth.uid()) as cats
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
-- 6. The multiple-choice screening of migration 7 is retired: it can no longer create a pass.
-- ---------------------------------------------------------------------------
create or replace function public.get_screening(p_category text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  raise exception 'screening_replaced';
end;
$$;

create or replace function public.submit_screening(p_category text, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  raise exception 'screening_replaced';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Client RPCs (authenticated only; every one scoped by auth.uid()).
-- ---------------------------------------------------------------------------

-- Questions of the CURRENT version + MY stored answers (prefill / edit). Owner-scoped.
create or replace function public.get_experience_questions(p_category text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max constant integer := 5;
  v_uid uuid := auth.uid();
  v_ver integer;
  v_a   public.experience_answers;
  v_has boolean;
  v_left integer := c_max;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  v_ver := public.experience_current_version(p_category);
  if p_category is null or v_ver is null then
    raise exception 'invalid_category';
  end if;
  select * into v_a from public.experience_answers a where a.user_id = v_uid and a.category = p_category;
  v_has := found;
  select greatest(c_max - l.window_saves, 0) into v_left
    from public.experience_save_limits l
   where l.user_id = v_uid and l.category = p_category and l.window_started_at > clock_timestamp() - interval '24 hours';
  v_left := coalesce(v_left, c_max);
  return jsonb_build_object(
    'category', p_category,
    'version', v_ver,
    'requires_assessment', public.category_requires_screening(p_category),
    'questions', (
      select jsonb_agg(jsonb_build_object('id', q.qid, 'prompt', q.prompt, 'hint', q.hint) order by q.position)
      from public.experience_questions q where q.category = p_category and q.version = v_ver),
    'answers', case when v_has then v_a.answers else null end,
    'answers_version', case when v_has then v_a.version else null end,
    'outdated', v_has and v_a.version <> v_ver,
    'updated_at', case when v_has then v_a.updated_at else null end,
    'saves_left', v_left);
end;
$$;

-- Save (create or replace) my four answers for one category. Validated, normalised, rate limited (5 saves per category per
-- fixed 24 h window, kept in experience_save_limits so that deleting answers cannot reset it: this bounds how often an
-- assessment can be triggered). Saving never activates a professional category.
create or replace function public.save_experience_answers(p_category text, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max  constant integer := 5;
  v_uid  uuid := auth.uid();
  v_ver  integer;
  v_norm jsonb;
  v_hash text;
  v_a    public.experience_answers;
  v_l    public.experience_save_limits;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  v_ver := public.experience_current_version(p_category);
  if p_category is null or v_ver is null then
    raise exception 'invalid_category';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'profile_missing';
  end if;
  if not exists (select 1 from public.tester_profiles where user_id = v_uid) then
    raise exception 'profile_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':exp:' || p_category, 0));

  v_norm := public.normalize_experience_answers(p_category, p_answers); -- raises invalid_answers BEFORE anything is written
  v_hash := public.experience_hash(v_ver, v_norm);

  select * into v_a from public.experience_answers a where a.user_id = v_uid and a.category = p_category for update;
  if found and v_a.version = v_ver and v_a.answers_hash = v_hash then
    return public.experience_category_json(v_uid, p_category); -- nothing changed: not counted
  end if;
  select * into v_l from public.experience_save_limits l where l.user_id = v_uid and l.category = p_category for update;
  if found and v_l.window_started_at > clock_timestamp() - interval '24 hours' and v_l.window_saves >= c_max then
    raise exception 'experience_rate_limited' using detail = (v_l.window_started_at + interval '24 hours')::text;
  end if;

  insert into public.experience_save_limits as l (user_id, category)
  values (v_uid, p_category)
  on conflict (user_id, category) do update
     set window_started_at = case when l.window_started_at > clock_timestamp() - interval '24 hours' then l.window_started_at else clock_timestamp() end,
         window_saves = case when l.window_started_at > clock_timestamp() - interval '24 hours' then l.window_saves + 1 else 1 end;

  insert into public.experience_answers as a (user_id, category, version, answers, answers_hash)
  values (v_uid, p_category, v_ver, v_norm, v_hash)
  on conflict (user_id, category) do update
     set version = excluded.version,
         answers = excluded.answers,
         answers_hash = excluded.answers_hash,
         updated_at = clock_timestamp();
  return public.experience_category_json(v_uid, p_category);
end;
$$;

-- My whole experience status (no answers inside): participation readiness, consent, the five categories.
create or replace function public.get_my_experience()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_cons public.ai_consents;
  v_cats jsonb := '[]'::jsonb;
  v_cat  text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  select * into v_cons from public.ai_consents c where c.user_id = v_uid;
  foreach v_cat in array array['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical'] loop
    v_cats := v_cats || public.experience_category_json(v_uid, v_cat);
  end loop;
  return jsonb_build_object(
    'has_profile', exists (select 1 from public.tester_profiles t where t.user_id = v_uid),
    'participation_ready', public.tester_participation_ready(v_uid),
    'ai_consent', jsonb_build_object(
      'granted', coalesce(v_cons.ai_processing, false),
      'policy_version', coalesce(v_cons.policy_version, 1),
      'updated_at', v_cons.updated_at),
    'categories', v_cats,
    'active_categories', to_jsonb(public.active_tester_categories(v_uid)));
end;
$$;

-- Opt in / out of AI processing. Nothing is ever sent to an AI service without granted = true (the server-only interface
-- below refuses to hand out the bio or the answers otherwise). Granting again after a withdrawal issues a NEW subject_ref.
create or replace function public.set_ai_consent(p_granted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.ai_consents;
  v_old public.ai_consents;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_granted is null then
    raise exception 'invalid_consent';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'profile_missing';
  end if;
  select * into v_old from public.ai_consents k where k.user_id = v_uid;
  if found and v_old.ai_processing and not p_granted then
    insert into public.ai_erasure_events (subject_ref, reason) values (v_old.subject_ref, 'consent_withdrawn');
  end if;
  insert into public.ai_consents as c (user_id, ai_processing)
  values (v_uid, p_granted)
  on conflict (user_id) do update
     set ai_processing = excluded.ai_processing,
         subject_ref = case when excluded.ai_processing and not c.ai_processing then gen_random_uuid() else c.subject_ref end,
         updated_at = clock_timestamp()
  returning * into v_row;
  return jsonb_build_object('granted', v_row.ai_processing, 'policy_version', v_row.policy_version, 'updated_at', v_row.updated_at);
end;
$$;

-- Delete MY experience answers (one category, or all of them) together with any assessment decisions made about them.
-- Consent is untouched (withdraw it with set_ai_consent(false)). An erasure event is logged for the AI service.
create or replace function public.delete_my_experience(p_category text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a   integer;
  v_q   integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_category is not null and public.experience_current_version(p_category) is null then
    raise exception 'invalid_category';
  end if;
  delete from public.experience_answers a where a.user_id = v_uid and (p_category is null or a.category = p_category);
  get diagnostics v_a = row_count;
  delete from public.category_qualifications q
   where q.user_id = v_uid and q.source = 'ai_assessment' and (p_category is null or q.category = p_category);
  get diagnostics v_q = row_count;
  if v_a > 0 or v_q > 0 then
    insert into public.ai_erasure_events (subject_ref, reason, category)
    select k.subject_ref, 'answers_deleted', p_category from public.ai_consents k where k.user_id = v_uid;
  end if;
  return jsonb_build_object('deleted_answers', v_a, 'deleted_decisions', v_q);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. SERVER-ONLY interface for the AI assessment / recommendation service (service_role only; never callable by
--    anon / authenticated). The service identifies the tester from a verified JWT on ITS server and passes the user id here;
--    the browser can never reach these. Contract: docs/AI_INTEGRATION_CONTRACT.md and src/lib/aiContract.ts.
-- ---------------------------------------------------------------------------

-- Everything the AI needs about ONE tester. The bio and the answers are included ONLY when consent is granted.
create or replace function public.service_get_ai_profile(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cons    public.ai_consents;
  v_granted boolean;
  v_prof    public.tester_profiles;
  v_cats    jsonb := '[]'::jsonb;
  v_fp      jsonb := '[]'::jsonb;
  v_cat     text;
  v_a       public.experience_answers;
  v_cj      jsonb;
  v_ans     jsonb;
  v_qual    jsonb;
  v_upd     timestamptz;
  v_has     boolean;
begin
  if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id) then
    return null;
  end if;
  select * into v_cons from public.ai_consents c where c.user_id = p_user_id;
  v_granted := coalesce(v_cons.ai_processing, false);
  select * into v_prof from public.tester_profiles t where t.user_id = p_user_id;
  v_upd := greatest(v_prof.updated_at, v_cons.updated_at);

  foreach v_cat in array array['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical'] loop
    v_cj := public.experience_category_json(p_user_id, v_cat);
    select * into v_a from public.experience_answers a where a.user_id = p_user_id and a.category = v_cat;
    v_has := found;
    v_ans := null;
    if v_granted and v_has and (v_cj ->> 'selected')::boolean and (v_cj ->> 'answers_complete')::boolean then
      select jsonb_agg(jsonb_build_object('question_id', q.qid, 'question', q.prompt, 'answer', v_a.answers ->> q.qid) order by q.position)
        into v_ans
        from public.experience_questions q where q.category = v_cat and q.version = v_a.version;
    end if;
    v_qual := v_cj -> 'qualification';
    v_upd := greatest(v_upd, v_a.updated_at, (v_qual ->> 'decided_at')::timestamptz);
    v_cats := v_cats || (jsonb_build_object(
      'category', v_cat,
      'kind', case when public.category_requires_screening(v_cat) then 'professional' else 'general' end,
      'selected', (v_cj ->> 'selected')::boolean,
      'state', v_cj ->> 'state',
      'question_version', (v_cj ->> 'question_version')::integer,
      'answers_version', v_cj -> 'answers_version',
      'answers_complete', (v_cj ->> 'answers_complete')::boolean,
      'answers_hash', case when v_has then to_jsonb(v_a.answers_hash) else null end,
      'answers_updated_at', v_cj -> 'answers_updated_at',
      'answers', v_ans,
      'qualification', v_qual));
    v_fp := v_fp || jsonb_build_array(jsonb_build_array(v_cat, v_cj ->> 'state', case when v_has then v_a.answers_hash else null end, v_qual));
  end loop;

  return jsonb_build_object(
    'contract_version', 1,
    'subject_ref', case when v_granted then to_jsonb(v_cons.subject_ref) else null end,
    'consent', jsonb_build_object('ai_processing', v_granted, 'policy_version', coalesce(v_cons.policy_version, 1), 'updated_at', v_cons.updated_at),
    'profile', case when v_prof.user_id is null then null else jsonb_build_object(
      'bio', case when v_granted then to_jsonb(v_prof.bio) else null end,
      'categories', to_jsonb(v_prof.categories),
      'updated_at', v_prof.updated_at) end,
    'categories', v_cats,
    'active_categories', to_jsonb(public.active_tester_categories(p_user_id)),
    'participation_ready', public.tester_participation_ready(p_user_id),
    'updated_at', v_upd,
    -- cache key: changes whenever anything an AI result can depend on changes (consent, bio, categories, answers, decisions)
    'etag', encode(sha256(convert_to(jsonb_build_array(v_granted, case when v_granted then v_cons.subject_ref end, case when v_granted then v_prof.bio end, v_prof.categories, v_fp)::text, 'UTF8')), 'hex'));
end;
$$;

-- Work queue for the assessment service: professional categories whose four answers are complete, that have no valid decision,
-- and whose owner CONSENTED to AI processing. No answers are returned here (fetch one tester with service_get_ai_profile).
create or replace function public.service_list_pending_assessments(p_limit integer default 50)
returns table (user_id uuid, subject_ref uuid, category text, question_version integer, answers_hash text, answers_updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.user_id, c.subject_ref, a.category, a.version, a.answers_hash, a.updated_at
  from public.experience_answers a
  join public.ai_consents c on c.user_id = a.user_id and c.ai_processing
  where public.category_requires_screening(a.category)
    and public.category_state(a.user_id, a.category) = 'pending_assessment'
  order by a.updated_at asc, a.user_id, a.category
  limit greatest(least(coalesce(p_limit, 50), 200), 1)
$$;

-- The ONLY way an assessment decision is written. Bound to the exact answers: a decision for answers that changed, for an
-- old question version, for a withdrawn consent or for a non-professional category is refused.
create or replace function public.service_record_qualification(
  p_user_id          uuid,
  p_category         text,
  p_question_version integer,
  p_answers_hash     text,
  p_status           text,
  p_assessment       jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.experience_answers;
  v_key text;
begin
  if p_status is null or p_status not in ('qualified', 'not_qualified') then
    raise exception 'invalid_status';
  end if;
  if p_category is null or not public.category_requires_screening(p_category) then
    raise exception 'category_not_assessable';
  end if;
  if p_assessment is not null then
    if jsonb_typeof(p_assessment) <> 'object' or octet_length(p_assessment::text) > 4096 then
      raise exception 'invalid_assessment';
    end if;
    for v_key in select jsonb_object_keys(p_assessment) loop
      if v_key not in ('model', 'rubric_version', 'summary', 'confidence') then
        raise exception 'invalid_assessment' using detail = v_key;
      end if;
    end loop;
    if char_length(coalesce(p_assessment ->> 'summary', '')) > 500 then
      raise exception 'invalid_assessment' using detail = 'summary';
    end if;
  end if;
  if not exists (select 1 from public.ai_consents c where c.user_id = p_user_id and c.ai_processing) then
    raise exception 'consent_required';
  end if;
  select * into v_a from public.experience_answers a where a.user_id = p_user_id and a.category = p_category for update;
  if not found or p_question_version is distinct from public.experience_current_version(p_category)
     or v_a.version <> p_question_version or v_a.answers_hash is distinct from p_answers_hash then
    raise exception 'stale_assessment';
  end if;
  insert into public.category_qualifications as q (user_id, category, status, source, question_version, answers_hash, assessment)
  values (p_user_id, p_category, p_status, 'ai_assessment', p_question_version, p_answers_hash, p_assessment)
  on conflict (user_id, category) do update
     set status = excluded.status, source = excluded.source, question_version = excluded.question_version,
         answers_hash = excluded.answers_hash, assessment = excluded.assessment, decided_at = clock_timestamp();
  return public.experience_category_json(p_user_id, p_category);
end;
$$;

-- (Only for testers who consented to AI processing: the listing reveals which categories are active for them.)
-- The campaigns a tester may actually act on, by the SAME rule as the database enforces (tester_eligibility): so a
-- recommendation service can never recommend a targeted task the tester cannot reserve. Same visibility rules as
-- list_campaigns_v2, for an explicit user id. Only public campaign fields (never the project URL).
create or replace function public.service_list_eligible_campaigns(p_user_id uuid)
returns table (
  campaign_id       uuid,
  project_name      text,
  description       text,
  task_description  text,
  created_at        timestamptz,
  expires_at        timestamptz,
  testing_mode      text,
  target_categories text[],
  match_categories  text[],
  reserved_by_me    boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, p.name, p.description, c.task_description, c.created_at, c.expires_at,
         c.testing_mode, c.target_categories, el.overlap, (mine.id is not null)
  from public.campaigns c
  join public.projects p on p.id = c.project_id
  left join public.test_reservations mine
         on mine.campaign_id = c.id and mine.tester_id = p_user_id
        and mine.consumed_at is null and mine.expires_at > now()
  cross join lateral public.tester_eligibility(p_user_id, c.testing_mode, c.target_categories) as el
  where exists (select 1 from public.ai_consents k where k.user_id = p_user_id and k.ai_processing)
    and c.status = 'open'
    and c.owner_id <> p_user_id
    and (c.expires_at > now() or mine.id is not null)
    and (el.eligible or mine.id is not null)
    and not exists (select 1 from public.test_submissions s where s.campaign_id = c.id and s.tester_id = p_user_id)
    and not exists (
      select 1 from public.test_reservations o
      where o.campaign_id = c.id and o.tester_id <> p_user_id and o.consumed_at is null and o.expires_at > now())
  order by (mine.id is not null) desc, c.created_at asc, c.id asc
  limit 200
$$;

-- ---------------------------------------------------------------------------
-- 9. Legacy screening: NO backfill. Real passes of the retired multiple-choice screening stay in screening_attempts as history
--    only; nothing reads them any more, so they cannot activate a professional category or bypass the assessment. Testers who
--    passed it earlier simply wait for the assessment like everybody else.
-- ---------------------------------------------------------------------------

-- Erasure signals for removals that do not go through the RPCs above (profile removal, account deletion by cascade).
create or replace function public.log_erasure_on_profile_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ai_erasure_events (subject_ref, reason)
  select k.subject_ref, 'profile_removed' from public.ai_consents k where k.user_id = old.user_id;
  return old;
end;
$$;
create trigger tester_profiles_erasure_log
  after delete on public.tester_profiles
  for each row execute function public.log_erasure_on_profile_removed();

create or replace function public.log_erasure_on_consent_row_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ai_erasure_events (subject_ref, reason) values (old.subject_ref, 'account_deleted');
  return old;
end;
$$;
create trigger ai_consents_erasure_log
  before delete on public.ai_consents
  for each row execute function public.log_erasure_on_consent_row_deleted();

-- The AI service polls this with its own cursor and must purge EVERYTHING it keeps for each subject_ref listed (cached
-- profiles, derived embeddings / summaries, recommendation caches). Only opaque references are returned.
create or replace function public.service_list_erasure_events(p_after_id bigint default 0, p_limit integer default 200)
returns table (id bigint, subject_ref uuid, reason text, category text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.subject_ref, e.reason, e.category, e.created_at
  from public.ai_erasure_events e
  where e.id > coalesce(p_after_id, 0)
  order by e.id
  limit greatest(least(coalesce(p_limit, 200), 1000), 1)
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges (explicit: new functions are EXECUTE-able by PUBLIC unless revoked).
-- ---------------------------------------------------------------------------
revoke all on function public.experience_current_version(text)                 from public, anon, authenticated;
revoke all on function public.experience_complete(uuid, text)                  from public, anon, authenticated;
revoke all on function public.is_qualified(uuid, text)                         from public, anon, authenticated;
revoke all on function public.category_state(uuid, text)                       from public, anon, authenticated;
revoke all on function public.active_tester_categories(uuid)                   from public, anon, authenticated;
revoke all on function public.tester_participation_ready(uuid)                 from public, anon, authenticated;
revoke all on function public.normalize_experience_answers(text, jsonb)        from public, anon, authenticated;
revoke all on function public.experience_hash(integer, jsonb)                  from public, anon, authenticated;
revoke all on function public.experience_category_json(uuid, text)             from public, anon, authenticated;
revoke all on function public.tester_eligibility(uuid, text, text[])           from public, anon, authenticated;
revoke all on function public.enforce_campaign_eligibility()                   from public, anon, authenticated;

revoke all on function public.get_experience_questions(text)                   from public, anon;
revoke all on function public.save_experience_answers(text, jsonb)             from public, anon;
revoke all on function public.get_my_experience()                              from public, anon;
revoke all on function public.set_ai_consent(boolean)                          from public, anon;
revoke all on function public.delete_my_experience(text)                       from public, anon;
revoke all on function public.list_matched_campaigns()                         from public, anon;
revoke all on function public.get_screening(text)                              from public, anon;
revoke all on function public.submit_screening(text, jsonb)                    from public, anon;
grant execute on function public.get_experience_questions(text)                to authenticated;
grant execute on function public.save_experience_answers(text, jsonb)          to authenticated;
grant execute on function public.get_my_experience()                           to authenticated;
grant execute on function public.set_ai_consent(boolean)                       to authenticated;
grant execute on function public.delete_my_experience(text)                    to authenticated;
grant execute on function public.list_matched_campaigns()                      to authenticated;
grant execute on function public.get_screening(text)                           to authenticated;
grant execute on function public.submit_screening(text, jsonb)                 to authenticated;

-- service-only interface: NOT executable by anon, authenticated or PUBLIC
revoke all on function public.service_get_ai_profile(uuid)                                                   from public, anon, authenticated;
revoke all on function public.service_list_pending_assessments(integer)                                      from public, anon, authenticated;
revoke all on function public.service_record_qualification(uuid, text, integer, text, text, jsonb)           from public, anon, authenticated;
revoke all on function public.service_list_eligible_campaigns(uuid)                                          from public, anon, authenticated;
revoke all on function public.service_list_erasure_events(bigint, integer)                                    from public, anon, authenticated;
revoke all on function public.log_erasure_on_profile_removed()                                               from public, anon, authenticated;
revoke all on function public.log_erasure_on_consent_row_deleted()                                           from public, anon, authenticated;
grant execute on function public.service_get_ai_profile(uuid)                                                to service_role;
grant execute on function public.service_list_pending_assessments(integer)                                   to service_role;
grant execute on function public.service_record_qualification(uuid, text, integer, text, text, jsonb)        to service_role;
grant execute on function public.service_list_eligible_campaigns(uuid)                                       to service_role;
grant execute on function public.service_list_erasure_events(bigint, integer)                                 to service_role;
