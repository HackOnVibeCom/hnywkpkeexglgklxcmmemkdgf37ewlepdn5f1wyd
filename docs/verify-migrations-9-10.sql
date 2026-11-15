-- READ-ONLY verification of migrations 20261115000500 (AI infrastructure) and 20261115000600 (consent withdrawal).
-- Run in the Supabase SQL editor AFTER applying them (and after docs/verify-migration8.sql). One SELECT, no writes.
-- Every row with ok = true must be true; rows whose check starts with "info:" are counts for humans (ok is always true).
-- Tested against the real migrations: supabase/tests/release_rehearsal.mjs runs this file and requires every ok to be true.

with
tables as (
  select unnest(array['ai_profile_analyses','ai_match_cache','ai_assessment_notes','ai_usage','ai_usage_global','ai_erasure_cursor']) as t
),
svc_fns as (
  select unnest(array[
    'ai_get_cache(uuid, uuid)','ai_put_analysis(uuid, uuid, text, jsonb, text)','ai_put_matches(uuid, uuid, jsonb)',
    'ai_get_assessment_notes(uuid, uuid)','ai_put_assessment_note(uuid, uuid, text, text, jsonb, text)','ai_purge_user(uuid)',
    'ai_apply_erasure_events(integer)','ai_reserve_run(uuid, text, integer, integer, integer, bigint, integer)',
    'ai_record_tokens(uuid, text, bigint, bigint)','ai_consent_active(uuid, uuid)'
  ]) as sig
)
select check_name, ok from (
  select 1 as n, 'migration 8 is present (ai_consents, category_qualifications, service_record_qualification)' as check_name,
         (to_regclass('public.ai_consents') is not null and to_regclass('public.category_qualifications') is not null
          and to_regprocedure('public.service_record_qualification(uuid, text, integer, text, text, jsonb)') is not null) as ok
  union all
  select 2, 'all 6 AI tables exist with row level security ON and NO policy',
         (select count(*) = 6 and bool_and(c.relrowsecurity) and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename in (select t from tables))
          from tables x join pg_class c on c.oid = to_regclass('public.' || x.t))
  union all
  select 3, 'anon / authenticated have NO table privileges on any AI table',
         (select not bool_or(has_table_privilege(r, 'public.' || x.t, 'select,insert,update,delete')) from tables x, unnest(array['anon','authenticated']) r)
  union all
  select 4, 'all 10 service functions exist',
         (select count(*) = 10 and bool_and(to_regprocedure('public.' || sig) is not null) from svc_fns)
  union all
  select 5, 'service functions: EXECUTE for service_role, NOT for anon / authenticated / public',
         (select bool_and(has_function_privilege('service_role', to_regprocedure('public.' || sig), 'execute')
                      and not has_function_privilege('anon', to_regprocedure('public.' || sig), 'execute')
                      and not has_function_privilege('authenticated', to_regprocedure('public.' || sig), 'execute')) from svc_fns)
  union all
  select 6, 'delete_my_ai_data(): authenticated yes, anon no',
         (has_function_privilege('authenticated', to_regprocedure('public.delete_my_ai_data()'), 'execute')
          and not has_function_privilege('anon', to_regprocedure('public.delete_my_ai_data()'), 'execute'))
  union all
  select 7, 'all AI functions are SECURITY DEFINER with an empty search_path',
         (select bool_and(p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%'))
          from pg_proc p where p.pronamespace = 'public'::regnamespace
            and (p.proname like 'ai\_%' or p.proname = 'delete_my_ai_data' or p.proname in ('ai_withdrawal_clears_decisions','qualification_requires_consent')))
  union all
  select 8, 'erasure cursor row exists (id = 1)', (select count(*) = 1 from public.ai_erasure_cursor where id = 1)
  union all
  select 9, 'migration 10: trigger on ai_consents clears decisions on withdrawal (enabled)',
         (select count(*) = 1 from pg_trigger where tgname = 'ai_consents_withdrawal_clears_decisions' and not tgisinternal and tgenabled = 'O')
  union all
  select 10, 'migration 10: trigger on category_qualifications requires consent (enabled)',
         (select count(*) = 1 from pg_trigger where tgname = 'category_qualifications_require_consent' and not tgisinternal and tgenabled = 'O')
  union all
  select 11, 'no AI-derived row exists without active consent for its subject_ref (erasure invariant; may be false for up to ~60 s after a withdrawal until the sweep runs)',
         (not exists (select 1 from public.ai_profile_analyses a where not exists (select 1 from public.ai_consents c where c.user_id = a.user_id and c.ai_processing and c.subject_ref = a.subject_ref))
          and not exists (select 1 from public.ai_match_cache m where not exists (select 1 from public.ai_consents c where c.user_id = m.user_id and c.ai_processing and c.subject_ref = m.subject_ref))
          and not exists (select 1 from public.ai_assessment_notes n where not exists (select 1 from public.ai_consents c where c.user_id = n.user_id and c.ai_processing and c.subject_ref = n.subject_ref)))
  union all
  select 12, 'no qualification decision exists for a user without active AI consent (migration 10 invariant)',
         (not exists (select 1 from public.category_qualifications q where not exists (select 1 from public.ai_consents c where c.user_id = q.user_id and c.ai_processing)))
  union all
  select 13, 'info: testers with a profile that must still write their four answers (count: ' || (select count(*) from public.tester_profiles t where not public.tester_participation_ready(t.user_id)) || ')', true
  union all
  select 14, 'info: AI consents granted (count: ' || (select count(*) from public.ai_consents where ai_processing) || ')', true
  union all
  select 15, 'info: qualification decisions (count: ' || (select count(*) from public.category_qualifications) || ')', true
  union all
  select 16, 'info: AI call counters today (calls: ' || coalesce((select openai_calls from public.ai_usage_global where day = (now() at time zone 'utc')::date), 0) || ')', true
) v order by n;
