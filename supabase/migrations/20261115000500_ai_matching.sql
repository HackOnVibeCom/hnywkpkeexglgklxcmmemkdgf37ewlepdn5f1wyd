-- UXBarter - AI relevance matching + professional assessment: storage for AI-DERIVED data, erasure, usage caps
--
-- ADDITIVE ONLY. No existing table, function, policy or privilege is altered; nothing here changes who may reserve or
-- submit a test. Eligibility stays exactly where it is (tester_eligibility + the reservation trigger); the AI only
-- ORDERS/EXPLAINS campaigns the server already says the tester may take, and records professional-category decisions
-- ONLY through the profile workstream's service_record_qualification.
--
-- OWNERSHIP BOUNDARY. The tester's voluntary text, the AI-processing consent, the qualification state machine and the
-- erasure-event log belong to migration 20261115000300_experience_profile.sql (contract v1). This migration creates NO
-- consent table, NO answers table and NO qualification table; it only stores what the model derived, keyed by the opaque
-- subject_ref that contract hands out. It has no migration-time dependency on migration 8 (plpgsql bodies are late-bound);
-- at RUNTIME it needs service_list_erasure_events (ai_apply_erasure_events).
--
-- What it adds
--   1. ai_profile_analyses     per-user cache of the structured experience representation.
--   2. ai_match_cache          per-user, per-campaign cache of validated verdicts.
--   3. ai_assessment_notes     per-user, per-category "needs clarification" outcomes (the only assessment result NOT stored in
--                              category_qualifications), so the same unchanged answers are not paid for twice.
--   4. ai_usage / ai_usage_global   per-user (per kind) and global daily call + token counters (cost control).
--   5. ai_erasure_cursor       position in the contract's erasure-event log.
--   6. User RPC (authenticated)     delete_my_ai_data(): erase everything the AI derived about the caller, immediately.
--   7. Service RPCs (service_role ONLY; the Edge Function passes a user id it verified from the caller's JWT):
--      ai_get_cache, ai_put_analysis, ai_put_matches, ai_get_assessment_notes, ai_put_assessment_note, ai_purge_user,
--      ai_apply_erasure_events, ai_reserve_run, ai_record_tokens, ai_consent_active.
--
-- All new tables: RLS on, NO policy, NO grant => reachable only through the RPCs above. Every derived row stores the
-- subject_ref it was derived under; a row whose subject_ref is not the tester's CURRENT one is never served (consent granted
-- again => new subject_ref => old rows are dead) and is erased by ai_apply_erasure_events.
-- Rolling back = redeploy the previous UI and remove the Edge Function; the tables can stay (no client uses them).

-- ---------------------------------------------------------------------------
-- 1-3. Derived-data stores. Keys are content hashes (they include the profile contract's etag, the policy version and the
--      model name), so any relevant change simply misses the cache.
-- ---------------------------------------------------------------------------
create table public.ai_profile_analyses (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  subject_ref uuid        not null,
  input_hash  text        not null check (char_length(input_hash) = 64),
  analysis    jsonb       not null,
  model       text        not null check (char_length(model) <= 80),
  created_at  timestamptz not null default now()
);

create table public.ai_match_cache (
  user_id       uuid        not null references public.profiles (id) on delete cascade,
  campaign_id   uuid        not null references public.campaigns (id) on delete cascade,
  subject_ref   uuid        not null,
  profile_hash  text        not null check (char_length(profile_hash) = 64),
  campaign_hash text        not null check (char_length(campaign_hash) = 64),
  result        jsonb       not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, campaign_id)
);

create table public.ai_assessment_notes (
  user_id      uuid        not null references public.profiles (id) on delete cascade,
  category     text        not null check (category in ('tech_savvy', 'founders_builders', 'business_office')),
  subject_ref  uuid        not null,
  answers_hash text        not null check (char_length(answers_hash) = 64),
  outcome      text        not null check (outcome = 'needs_clarification'),
  payload      jsonb       not null check (octet_length(payload::text) <= 4096),
  model        text        check (model is null or char_length(model) <= 80),
  created_at   timestamptz not null default now(),
  primary key (user_id, category)
);

-- ---------------------------------------------------------------------------
-- 4. Usage counters (UTC day). kind = 'match' | 'assess': the minimum-interval throttle is per kind, so opening Discover
--    right after saving answers never blocks the other; the call and token ceilings are shared in the global row.
-- ---------------------------------------------------------------------------
create table public.ai_usage (
  user_id       uuid    not null references public.profiles (id) on delete cascade,
  day           date    not null,
  kind          text    not null check (kind in ('match', 'assess')),
  runs          integer not null default 0,
  openai_calls  integer not null default 0,
  input_tokens  bigint  not null default 0,
  output_tokens bigint  not null default 0,
  last_run_at   timestamptz,
  primary key (user_id, day, kind)
);

create table public.ai_usage_global (
  day           date primary key,
  openai_calls  integer not null default 0,
  input_tokens  bigint  not null default 0,
  output_tokens bigint  not null default 0
);

-- ---------------------------------------------------------------------------
-- 5. Cursor into the contract's erasure-event log (single row).
-- ---------------------------------------------------------------------------
create table public.ai_erasure_cursor (
  id                 smallint primary key check (id = 1),
  last_id            bigint      not null default 0,
  last_reconciled_at timestamptz
);
insert into public.ai_erasure_cursor (id, last_id) values (1, 0);

alter table public.ai_profile_analyses enable row level security;
alter table public.ai_match_cache      enable row level security;
alter table public.ai_assessment_notes enable row level security;
alter table public.ai_usage            enable row level security;
alter table public.ai_usage_global     enable row level security;
alter table public.ai_erasure_cursor   enable row level security;
revoke all on public.ai_profile_analyses from anon, authenticated;
revoke all on public.ai_match_cache      from anon, authenticated;
revoke all on public.ai_assessment_notes from anon, authenticated;
revoke all on public.ai_usage            from anon, authenticated;
revoke all on public.ai_usage_global     from anon, authenticated;
revoke all on public.ai_erasure_cursor   from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. User RPC: erase what the AI derived about ME (analysis, verdicts, clarification notes). Usage counters are kept (they
--    are the cost ceiling, not personal content). The UI calls this when the tester switches AI off or deletes answers; the
--    erasure-event poller below is the contract-level safety net for every path (including ones that never call this).
--    It does NOT touch qualification decisions (owned by the profile workstream). Withdrawing consent removes them through
--    migration 20261115000600 (docs/AI_MATCHING.md "Consent withdrawal").
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_ai_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a   integer;
  v_m   integer;
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  delete from public.ai_profile_analyses where user_id = v_uid;
  get diagnostics v_a = row_count;
  delete from public.ai_match_cache where user_id = v_uid;
  get diagnostics v_m = row_count;
  delete from public.ai_assessment_notes where user_id = v_uid;
  get diagnostics v_n = row_count;
  return jsonb_build_object('deleted_analyses', v_a, 'deleted_verdicts', v_m, 'deleted_notes', v_n);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Service-only RPCs.
-- ---------------------------------------------------------------------------
-- Rows are returned only for the tester's CURRENT subject_ref.
create or replace function public.ai_get_cache(p_user uuid, p_subject_ref uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'analysis', (select jsonb_build_object('input_hash', a.input_hash, 'analysis', a.analysis)
                 from public.ai_profile_analyses a where a.user_id = p_user and a.subject_ref = p_subject_ref),
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object('campaign_id', m.campaign_id, 'profile_hash', m.profile_hash,
                                          'campaign_hash', m.campaign_hash, 'result', m.result))
      from public.ai_match_cache m where m.user_id = p_user and m.subject_ref = p_subject_ref), '[]'::jsonb))
$$;

-- Is AI processing CURRENTLY granted for exactly this (user, subject_ref)? The Edge Function calls it immediately before EVERY
-- OpenAI request (not only at the start of a run), so a withdrawal that happens while a run is in progress stops the next
-- model call. Read-only, no side effects, never returns data.
create or replace function public.ai_consent_active(p_user uuid, p_subject_ref uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- plpgsql (late-bound): this migration must not depend on migration 8 at creation time.
  return exists (select 1 from public.ai_consents c where c.user_id = p_user and c.ai_processing and c.subject_ref = p_subject_ref);
end;
$$;

create or replace function public.ai_put_analysis(p_user uuid, p_subject_ref uuid, p_input_hash text, p_analysis jsonb, p_model text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null or p_subject_ref is null or p_input_hash is null or p_analysis is null or p_model is null then
    raise exception 'invalid_arguments';
  end if;
  -- Never store derived data for a consent that was withdrawn (or re-issued under a new subject_ref) while the model was thinking.
  perform 1 from public.ai_consents c where c.user_id = p_user and c.ai_processing and c.subject_ref = p_subject_ref for share;
  if not found then
    return;
  end if;
  insert into public.ai_profile_analyses (user_id, subject_ref, input_hash, analysis, model)
  values (p_user, p_subject_ref, p_input_hash, p_analysis, left(p_model, 80))
  on conflict (user_id) do update
    set subject_ref = excluded.subject_ref, input_hash = excluded.input_hash, analysis = excluded.analysis,
        model = excluded.model, created_at = now();
end;
$$;

-- p_matches = [{ campaign_id, profile_hash, campaign_hash, result }]; rows for campaigns that no longer exist are
-- skipped (the FK would otherwise fail the whole batch). Keeps at most 200 rows per user (oldest dropped).
create or replace function public.ai_put_matches(p_user uuid, p_subject_ref uuid, p_matches jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
  v_m jsonb;
begin
  if p_user is null or p_subject_ref is null or p_matches is null or jsonb_typeof(p_matches) <> 'array' then
    raise exception 'invalid_arguments';
  end if;
  if jsonb_array_length(p_matches) > 100 then
    raise exception 'too_many_matches';
  end if;
  perform 1 from public.ai_consents c where c.user_id = p_user and c.ai_processing and c.subject_ref = p_subject_ref for share;
  if not found then
    return 0; -- consent withdrawn / re-issued while the model was thinking: store nothing
  end if;
  for v_m in select * from jsonb_array_elements(p_matches) loop
    if not exists (select 1 from public.campaigns c where c.id = (v_m ->> 'campaign_id')::uuid) then
      continue;
    end if;
    insert into public.ai_match_cache (user_id, campaign_id, subject_ref, profile_hash, campaign_hash, result)
    values (p_user, (v_m ->> 'campaign_id')::uuid, p_subject_ref, v_m ->> 'profile_hash', v_m ->> 'campaign_hash', v_m -> 'result')
    on conflict (user_id, campaign_id) do update
      set subject_ref = excluded.subject_ref, profile_hash = excluded.profile_hash, campaign_hash = excluded.campaign_hash,
          result = excluded.result, created_at = now();
    v_n := v_n + 1;
  end loop;
  delete from public.ai_match_cache m
  where m.user_id = p_user
    and m.campaign_id in (
      select x.campaign_id from public.ai_match_cache x
      where x.user_id = p_user order by x.created_at desc, x.campaign_id offset 200);
  return v_n;
end;
$$;

create or replace function public.ai_get_assessment_notes(p_user uuid, p_subject_ref uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('category', n.category, 'answers_hash', n.answers_hash, 'outcome', n.outcome, 'payload', n.payload)), '[]'::jsonb)
  from public.ai_assessment_notes n where n.user_id = p_user and n.subject_ref = p_subject_ref
$$;

create or replace function public.ai_put_assessment_note(
  p_user uuid, p_subject_ref uuid, p_category text, p_answers_hash text, p_payload jsonb, p_model text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null or p_subject_ref is null or p_category is null or p_answers_hash is null or p_payload is null then
    raise exception 'invalid_arguments';
  end if;
  perform 1 from public.ai_consents c where c.user_id = p_user and c.ai_processing and c.subject_ref = p_subject_ref for share;
  if not found then
    return;
  end if;
  insert into public.ai_assessment_notes (user_id, category, subject_ref, answers_hash, outcome, payload, model)
  values (p_user, p_category, p_subject_ref, p_answers_hash, 'needs_clarification', p_payload, left(p_model, 80))
  on conflict (user_id, category) do update
    set subject_ref = excluded.subject_ref, answers_hash = excluded.answers_hash, payload = excluded.payload,
        model = excluded.model, created_at = now();
end;
$$;

-- Erase everything this user's rows hold (consent not granted / withdrawn elsewhere).
create or replace function public.ai_purge_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null then
    raise exception 'invalid_arguments';
  end if;
  delete from public.ai_profile_analyses where user_id = p_user;
  delete from public.ai_match_cache where user_id = p_user;
  delete from public.ai_assessment_notes where user_id = p_user;
end;
$$;

-- THE erasure mechanism of the contract (docs/AI_INTEGRATION_CONTRACT.md section 10): read the profile workstream's
-- erasure events after my own cursor, delete EVERYTHING held for each subject_ref (all reasons, any category: derived data is
-- cheap to recompute and must never outlive a withdrawal), and only then advance the cursor - all in one transaction.
--
-- RECONCILIATION. Identity ids are not commit-ordered: an event inserted by a slow transaction can become visible AFTER a later
-- event was already processed and the cursor moved past it, so "id > cursor" would never return it. Therefore, at most once per
-- minute (and whenever events were processed), everything held for a subject_ref that has NO active consent row any more is
-- deleted too. That is idempotent, independent of event ordering, and also covers rows written after an erasure.
--
-- Called by the Edge Function at the start of every request (a global sweep: any request erases for every tester) and, strongly
-- recommended, by pg_cron so erasure also happens with no traffic. A concurrent sweep skips (returns 0) instead of waiting.
create or replace function public.ai_apply_erasure_events(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last  bigint;
  v_at    timestamptz;
  v_ev    record;
  v_n     integer := 0;
  v_recon boolean := false;
begin
  select c.last_id, c.last_reconciled_at into v_last, v_at from public.ai_erasure_cursor c where c.id = 1 for update skip locked;
  if not found then
    return 0; -- another sweep is running
  end if;
  for v_ev in select e.id, e.subject_ref from public.service_list_erasure_events(v_last, least(greatest(coalesce(p_limit, 500), 1), 1000)) e order by e.id loop
    delete from public.ai_profile_analyses where subject_ref = v_ev.subject_ref;
    delete from public.ai_match_cache where subject_ref = v_ev.subject_ref;
    delete from public.ai_assessment_notes where subject_ref = v_ev.subject_ref;
    v_last := v_ev.id;
    v_n := v_n + 1;
  end loop;

  if v_n > 0 or v_at is null or v_at < clock_timestamp() - interval '60 seconds' then
    delete from public.ai_profile_analyses a
     where not exists (select 1 from public.ai_consents c where c.user_id = a.user_id and c.ai_processing and c.subject_ref = a.subject_ref);
    delete from public.ai_match_cache m
     where not exists (select 1 from public.ai_consents c where c.user_id = m.user_id and c.ai_processing and c.subject_ref = m.subject_ref);
    delete from public.ai_assessment_notes n
     where not exists (select 1 from public.ai_consents c where c.user_id = n.user_id and c.ai_processing and c.subject_ref = n.subject_ref);
    v_recon := true;
  end if;

  if v_n > 0 or v_recon then -- no write (and no hot-row churn) when nothing happened
    update public.ai_erasure_cursor set last_id = v_last, last_reconciled_at = case when v_recon then clock_timestamp() else last_reconciled_at end where id = 1;
  end if;
  return v_n;
end;
$$;

-- Atomically admit (or refuse) one run that needs p_calls OpenAI requests.
--   'ok' | 'too_fast' | 'user_daily_cap' | 'global_cap'
-- Counters are bumped BEFORE the OpenAI call (a crash can only over-count, never let spend escape the caps).
-- Lock order is always user row -> global row, so concurrent runs cannot deadlock. The daily per-user call cap counts
-- both kinds together (so does the global cap); only the throttle is per kind.
create or replace function public.ai_reserve_run(
  p_user                 uuid,
  p_kind                 text,
  p_calls                integer,
  p_user_daily_cap       integer,
  p_global_daily_cap     integer,
  p_global_token_cap     bigint,
  p_min_interval_seconds integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day   date := (now() at time zone 'utc')::date;
  v_now   timestamptz := clock_timestamp();
  v_u     public.ai_usage;
  v_total integer;
  v_g     public.ai_usage_global;
begin
  if p_user is null or p_kind is null or p_kind not in ('match', 'assess') or p_calls is null or p_calls < 1 or p_calls > 4
     or p_user_daily_cap is null or p_global_daily_cap is null or p_global_token_cap is null
     or p_min_interval_seconds is null or p_min_interval_seconds < 0 then
    raise exception 'invalid_arguments';
  end if;
  insert into public.ai_usage (user_id, day, kind) values (p_user, v_day, p_kind) on conflict do nothing;
  insert into public.ai_usage_global (day) values (v_day) on conflict do nothing;
  select * into v_u from public.ai_usage where user_id = p_user and day = v_day and kind = p_kind for update;
  select * into v_g from public.ai_usage_global where day = v_day for update;
  select coalesce(sum(u.openai_calls), 0) into v_total from public.ai_usage u where u.user_id = p_user and u.day = v_day;

  if v_u.last_run_at is not null and v_now - v_u.last_run_at < make_interval(secs => p_min_interval_seconds) then
    return 'too_fast';
  end if;
  if v_total + p_calls > p_user_daily_cap then
    return 'user_daily_cap';
  end if;
  if v_g.openai_calls + p_calls > p_global_daily_cap or (v_g.input_tokens + v_g.output_tokens) >= p_global_token_cap then
    return 'global_cap';
  end if;

  update public.ai_usage
     set runs = runs + 1, openai_calls = openai_calls + p_calls, last_run_at = v_now
   where user_id = p_user and day = v_day and kind = p_kind;
  update public.ai_usage_global set openai_calls = openai_calls + p_calls where day = v_day;
  return 'ok';
end;
$$;

create or replace function public.ai_record_tokens(p_user uuid, p_kind text, p_input bigint, p_output bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
begin
  if p_user is null or p_kind is null or p_kind not in ('match', 'assess') or p_input is null or p_output is null or p_input < 0 or p_output < 0 then
    raise exception 'invalid_arguments';
  end if;
  insert into public.ai_usage (user_id, day, kind) values (p_user, v_day, p_kind) on conflict do nothing;
  insert into public.ai_usage_global (day) values (v_day) on conflict do nothing;
  update public.ai_usage set input_tokens = input_tokens + p_input, output_tokens = output_tokens + p_output
   where user_id = p_user and day = v_day and kind = p_kind;
  update public.ai_usage_global set input_tokens = input_tokens + p_input, output_tokens = output_tokens + p_output
   where day = v_day;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Privileges (explicit: new functions are EXECUTE-able by PUBLIC unless revoked).
-- ---------------------------------------------------------------------------
revoke all on function public.delete_my_ai_data()                             from public, anon;
grant execute on function public.delete_my_ai_data()                          to authenticated;

revoke all on function public.ai_consent_active(uuid, uuid)                   from public, anon, authenticated;
revoke all on function public.ai_get_cache(uuid, uuid)                        from public, anon, authenticated;
revoke all on function public.ai_put_analysis(uuid, uuid, text, jsonb, text)  from public, anon, authenticated;
revoke all on function public.ai_put_matches(uuid, uuid, jsonb)               from public, anon, authenticated;
revoke all on function public.ai_get_assessment_notes(uuid, uuid)             from public, anon, authenticated;
revoke all on function public.ai_put_assessment_note(uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.ai_purge_user(uuid)                             from public, anon, authenticated;
revoke all on function public.ai_apply_erasure_events(integer)                from public, anon, authenticated;
revoke all on function public.ai_reserve_run(uuid, text, integer, integer, integer, bigint, integer) from public, anon, authenticated;
revoke all on function public.ai_record_tokens(uuid, text, bigint, bigint)    from public, anon, authenticated;
grant execute on function public.ai_consent_active(uuid, uuid)                to service_role;
grant execute on function public.ai_get_cache(uuid, uuid)                     to service_role;
grant execute on function public.ai_put_analysis(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.ai_put_matches(uuid, uuid, jsonb)            to service_role;
grant execute on function public.ai_get_assessment_notes(uuid, uuid)          to service_role;
grant execute on function public.ai_put_assessment_note(uuid, uuid, text, text, jsonb, text) to service_role;
grant execute on function public.ai_purge_user(uuid)                          to service_role;
grant execute on function public.ai_apply_erasure_events(integer)             to service_role;
grant execute on function public.ai_reserve_run(uuid, text, integer, integer, integer, bigint, integer) to service_role;
grant execute on function public.ai_record_tokens(uuid, text, bigint, bigint) to service_role;
