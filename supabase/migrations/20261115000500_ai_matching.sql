-- UXBarter - AI-powered relevance matching: storage for AI-DERIVED data, usage caps (cost control)
--
-- ADDITIVE ONLY. No existing table, function, policy or privilege is altered; nothing here changes who may reserve or
-- submit a test. Eligibility stays exactly where it is (tester_eligibility + the reservation trigger); the AI only
-- ORDERS/EXPLAINS campaigns the server already says the tester may take.
--
-- OWNERSHIP BOUNDARY. The tester's voluntary text (bio, the four free-text answers per category), the AI-processing
-- consent and the qualification state belong to the profile / qualification workstream and are read by the Edge Function
-- through ITS server-only contract (public.service_get_ai_profile, contract v1). This migration deliberately creates no
-- consent table and no answers table and has NO migration-time dependency on them: it only stores what the model derived.
--
-- What it adds
--   1. ai_profile_analyses   per-user cache of the structured experience representation (content-hash keyed).
--   2. ai_match_cache        per-user, per-campaign cache of validated verdicts (content-hash keyed).
--   3. ai_usage / ai_usage_global   per-user and global daily call + token counters (cost control).
--   4. User RPC (authenticated)     delete_my_ai_data(): erase everything the AI derived about the caller.
--   5. Service RPCs (service_role ONLY; the Edge Function passes a user id it verified from the caller's JWT):
--      ai_get_cache, ai_put_analysis, ai_put_matches, ai_purge_user, ai_reserve_run, ai_record_tokens.
--
-- All new tables: RLS on, NO policy, NO grant => reachable only through the RPCs above. Cache rows contain model OUTPUT
-- about that user only (including short verbatim quotes of their own text), never another user's data.
-- Rolling back = redeploy the previous UI and remove the Edge Function; the tables can stay (no client uses them).

-- ---------------------------------------------------------------------------
-- 1-2. Caches. Keys are content hashes, so a changed profile / answer / campaign / prompt version simply misses the cache.
-- ---------------------------------------------------------------------------
create table public.ai_profile_analyses (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  input_hash text        not null check (char_length(input_hash) = 64),
  analysis   jsonb       not null,
  model      text        not null check (char_length(model) <= 80),
  created_at timestamptz not null default now()
);

create table public.ai_match_cache (
  user_id       uuid        not null references public.profiles (id) on delete cascade,
  campaign_id   uuid        not null references public.campaigns (id) on delete cascade,
  profile_hash  text        not null check (char_length(profile_hash) = 64),
  campaign_hash text        not null check (char_length(campaign_hash) = 64),
  result        jsonb       not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, campaign_id)
);

-- ---------------------------------------------------------------------------
-- 3. Usage counters (UTC day).
-- ---------------------------------------------------------------------------
create table public.ai_usage (
  user_id       uuid    not null references public.profiles (id) on delete cascade,
  day           date    not null,
  runs          integer not null default 0,
  openai_calls  integer not null default 0,
  input_tokens  bigint  not null default 0,
  output_tokens bigint  not null default 0,
  last_run_at   timestamptz,
  primary key (user_id, day)
);

create table public.ai_usage_global (
  day           date primary key,
  openai_calls  integer not null default 0,
  input_tokens  bigint  not null default 0,
  output_tokens bigint  not null default 0
);

alter table public.ai_profile_analyses enable row level security;
alter table public.ai_match_cache      enable row level security;
alter table public.ai_usage            enable row level security;
alter table public.ai_usage_global     enable row level security;
revoke all on public.ai_profile_analyses from anon, authenticated;
revoke all on public.ai_match_cache      from anon, authenticated;
revoke all on public.ai_usage            from anon, authenticated;
revoke all on public.ai_usage_global     from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. User RPC: erase what the AI derived about ME (analysis + verdicts). Usage counters are kept (they are the cost
--    ceiling, not personal content). The UI calls this when the tester turns AI off; the Edge Function also purges
--    whenever it sees that consent is not granted.
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
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  delete from public.ai_profile_analyses where user_id = v_uid;
  get diagnostics v_a = row_count;
  delete from public.ai_match_cache where user_id = v_uid;
  get diagnostics v_m = row_count;
  return jsonb_build_object('deleted_analyses', v_a, 'deleted_verdicts', v_m);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Service-only RPCs.
-- ---------------------------------------------------------------------------
create or replace function public.ai_get_cache(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'analysis', (select jsonb_build_object('input_hash', a.input_hash, 'analysis', a.analysis)
                 from public.ai_profile_analyses a where a.user_id = p_user),
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object('campaign_id', m.campaign_id, 'profile_hash', m.profile_hash,
                                          'campaign_hash', m.campaign_hash, 'result', m.result))
      from public.ai_match_cache m where m.user_id = p_user), '[]'::jsonb))
$$;

create or replace function public.ai_put_analysis(p_user uuid, p_input_hash text, p_analysis jsonb, p_model text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null or p_input_hash is null or p_analysis is null or p_model is null then
    raise exception 'invalid_arguments';
  end if;
  insert into public.ai_profile_analyses (user_id, input_hash, analysis, model)
  values (p_user, p_input_hash, p_analysis, left(p_model, 80))
  on conflict (user_id) do update
    set input_hash = excluded.input_hash, analysis = excluded.analysis, model = excluded.model, created_at = now();
end;
$$;

-- p_matches = [{ campaign_id, profile_hash, campaign_hash, result }]; rows for campaigns that no longer exist are
-- skipped (the FK would otherwise fail the whole batch). Keeps at most 200 rows per user (oldest dropped).
create or replace function public.ai_put_matches(p_user uuid, p_matches jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
  v_m jsonb;
begin
  if p_user is null or p_matches is null or jsonb_typeof(p_matches) <> 'array' then
    raise exception 'invalid_arguments';
  end if;
  if jsonb_array_length(p_matches) > 100 then
    raise exception 'too_many_matches';
  end if;
  for v_m in select * from jsonb_array_elements(p_matches) loop
    if not exists (select 1 from public.campaigns c where c.id = (v_m ->> 'campaign_id')::uuid) then
      continue;
    end if;
    insert into public.ai_match_cache (user_id, campaign_id, profile_hash, campaign_hash, result)
    values (p_user, (v_m ->> 'campaign_id')::uuid, v_m ->> 'profile_hash', v_m ->> 'campaign_hash', v_m -> 'result')
    on conflict (user_id, campaign_id) do update
      set profile_hash = excluded.profile_hash, campaign_hash = excluded.campaign_hash,
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

-- Same erasure as delete_my_ai_data, for the Edge Function (consent not granted / withdrawn elsewhere).
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
end;
$$;

-- Atomically admit (or refuse) one recommendation run that needs p_calls OpenAI requests.
--   'ok' | 'too_fast' | 'user_daily_cap' | 'global_cap'
-- Counters are bumped BEFORE the OpenAI call (a crash can only over-count, never let spend escape the caps).
-- Lock order is always user row -> global row, so concurrent runs cannot deadlock.
create or replace function public.ai_reserve_run(
  p_user                 uuid,
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
  v_day date := (now() at time zone 'utc')::date;
  v_now timestamptz := clock_timestamp();
  v_u   public.ai_usage;
  v_g   public.ai_usage_global;
begin
  if p_user is null or p_calls is null or p_calls < 1 or p_calls > 4
     or p_user_daily_cap is null or p_global_daily_cap is null or p_global_token_cap is null
     or p_min_interval_seconds is null or p_min_interval_seconds < 0 then
    raise exception 'invalid_arguments';
  end if;
  insert into public.ai_usage (user_id, day) values (p_user, v_day) on conflict do nothing;
  insert into public.ai_usage_global (day) values (v_day) on conflict do nothing;
  select * into v_u from public.ai_usage where user_id = p_user and day = v_day for update;
  select * into v_g from public.ai_usage_global where day = v_day for update;

  if v_u.last_run_at is not null and v_now - v_u.last_run_at < make_interval(secs => p_min_interval_seconds) then
    return 'too_fast';
  end if;
  if v_u.openai_calls + p_calls > p_user_daily_cap then
    return 'user_daily_cap';
  end if;
  if v_g.openai_calls + p_calls > p_global_daily_cap or (v_g.input_tokens + v_g.output_tokens) >= p_global_token_cap then
    return 'global_cap';
  end if;

  update public.ai_usage
     set runs = runs + 1, openai_calls = openai_calls + p_calls, last_run_at = v_now
   where user_id = p_user and day = v_day;
  update public.ai_usage_global set openai_calls = openai_calls + p_calls where day = v_day;
  return 'ok';
end;
$$;

create or replace function public.ai_record_tokens(p_user uuid, p_input bigint, p_output bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
begin
  if p_user is null or p_input is null or p_output is null or p_input < 0 or p_output < 0 then
    raise exception 'invalid_arguments';
  end if;
  insert into public.ai_usage (user_id, day) values (p_user, v_day) on conflict do nothing;
  insert into public.ai_usage_global (day) values (v_day) on conflict do nothing;
  update public.ai_usage set input_tokens = input_tokens + p_input, output_tokens = output_tokens + p_output
   where user_id = p_user and day = v_day;
  update public.ai_usage_global set input_tokens = input_tokens + p_input, output_tokens = output_tokens + p_output
   where day = v_day;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges (explicit: new functions are EXECUTE-able by PUBLIC unless revoked).
-- ---------------------------------------------------------------------------
revoke all on function public.delete_my_ai_data()                             from public, anon;
grant execute on function public.delete_my_ai_data()                          to authenticated;

revoke all on function public.ai_get_cache(uuid)                              from public, anon, authenticated;
revoke all on function public.ai_put_analysis(uuid, text, jsonb, text)        from public, anon, authenticated;
revoke all on function public.ai_put_matches(uuid, jsonb)                     from public, anon, authenticated;
revoke all on function public.ai_purge_user(uuid)                             from public, anon, authenticated;
revoke all on function public.ai_reserve_run(uuid, integer, integer, integer, bigint, integer) from public, anon, authenticated;
revoke all on function public.ai_record_tokens(uuid, bigint, bigint)          from public, anon, authenticated;
grant execute on function public.ai_get_cache(uuid)                           to service_role;
grant execute on function public.ai_put_analysis(uuid, text, jsonb, text)     to service_role;
grant execute on function public.ai_put_matches(uuid, jsonb)                  to service_role;
grant execute on function public.ai_purge_user(uuid)                          to service_role;
grant execute on function public.ai_reserve_run(uuid, integer, integer, integer, bigint, integer) to service_role;
grant execute on function public.ai_record_tokens(uuid, bigint, bigint)       to service_role;
