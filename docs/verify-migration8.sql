-- READ-ONLY verification of migration 8 (experience profile + qualification). ONE pure SELECT statement: it changes nothing
-- (it only reads the system catalogs, has_*_privilege(), function source text and row COUNTS - never answer text, bios or ids).
-- Paste into the Supabase SQL Editor AFTER the migration was applied. Every row of the "ok" column must be true;
-- the "info" rows (ok = NULL) only show current numbers.
select check_name, ok, detail from (
  select 1 as n, 'migration 8 recorded' as check_name,
         (select count(*) = 1 from supabase_migrations.schema_migrations where version = '20261115000300') as ok, '' as detail
  union all select 2, 'migrations 6 and 7 still recorded',
         (select count(*) = 2 from supabase_migrations.schema_migrations where version in ('20261115000100', '20261115000200')), ''
  union all select 3 + row_number() over (order by t), 'RLS on, no policy, no client privilege: ' || t,
         (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass)
           and (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = t)
           and not (has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete,truncate,references,trigger')
                 or has_table_privilege('authenticated', 'public.' || t, 'select,insert,update,delete,truncate,references,trigger'))
           and (select count(*) = 0 from information_schema.column_privileges
                 where table_schema = 'public' and table_name = t and grantee in ('anon', 'authenticated', 'PUBLIC'))
           and (select count(*) = 0 from pg_attribute where attrelid = ('public.' || t)::regclass and attnum > 0 and attacl is not null), ''
    from unnest(array['experience_questions', 'experience_answers', 'ai_consents', 'category_qualifications', 'experience_save_limits', 'ai_erasure_events']) as t
  union all select 10 + row_number() over (order by f), 'client RPC ' || f || ': authenticated YES, anon NO, PUBLIC NO, SECURITY DEFINER + search_path',
         has_function_privilege('authenticated', f::regprocedure, 'execute')
         and not has_function_privilege('anon', f::regprocedure, 'execute')
         and not has_function_privilege('public', f::regprocedure, 'execute')
         and (select prosecdef and coalesce(proconfig::text, '') like '%search_path%' from pg_proc where oid = f::regprocedure), ''
    from unnest(array[
      'public.get_experience_questions(text)',
      'public.save_experience_answers(text,jsonb)',
      'public.get_my_experience()',
      'public.set_ai_consent(boolean)',
      'public.delete_my_experience(text)',
      'public.list_matched_campaigns()',
      'public.list_campaigns_v2()',
      'public.get_campaign_eligibility(uuid)']) as f
  union all select 20 + row_number() over (order by f), 'SERVER-ONLY ' || f || ': service_role YES, anon NO, authenticated NO, PUBLIC NO, SECURITY DEFINER + search_path',
         has_function_privilege('service_role', f::regprocedure, 'execute')
         and not has_function_privilege('anon', f::regprocedure, 'execute')
         and not has_function_privilege('authenticated', f::regprocedure, 'execute')
         and not has_function_privilege('public', f::regprocedure, 'execute')
         and (select prosecdef and coalesce(proconfig::text, '') like '%search_path%' from pg_proc where oid = f::regprocedure), ''
    from unnest(array[
      'public.service_get_ai_profile(uuid)',
      'public.service_list_pending_assessments(integer)',
      'public.service_record_qualification(uuid,text,integer,text,text,jsonb)',
      'public.service_list_eligible_campaigns(uuid)',
      'public.service_list_erasure_events(bigint,integer)']) as f
  union all select 30 + row_number() over (order by f), 'internal ' || f || ': NOT executable by anon, authenticated or PUBLIC',
         not (has_function_privilege('anon', f::regprocedure, 'execute')
           or has_function_privilege('authenticated', f::regprocedure, 'execute')
           or has_function_privilege('public', f::regprocedure, 'execute')), ''
    from unnest(array[
      'public.experience_current_version(text)',
      'public.experience_complete(uuid,text)',
      'public.is_qualified(uuid,text)',
      'public.category_state(uuid,text)',
      'public.active_tester_categories(uuid)',
      'public.tester_participation_ready(uuid)',
      'public.normalize_experience_answers(text,jsonb)',
      'public.experience_hash(integer,jsonb)',
      'public.experience_category_json(uuid,text)',
      'public.tester_eligibility(uuid,text,text[])',
      'public.enforce_campaign_eligibility()',
      'public.log_erasure_on_profile_removed()',
      'public.log_erasure_on_consent_row_deleted()']) as f
  union all select 50, 'the retired multiple-choice screening can no longer create a pass (submit_screening / get_screening refuse)',
         (select prosrc like '%screening_replaced%' from pg_proc where oid = 'public.submit_screening(text,jsonb)'::regprocedure)
         and (select prosrc like '%screening_replaced%' from pg_proc where oid = 'public.get_screening(text)'::regprocedure), ''
  union all select 51, 'the reservation trigger is installed and enabled, and its function applies the eligibility rule to ALL campaigns',
         (select count(*) = 1 from pg_trigger where tgrelid = 'public.test_reservations'::regclass and tgname = 'test_reservations_eligibility' and tgenabled = 'O')
         and (select prosrc like '%tester_eligibility%' and prosrc not like '%distinct from ''targeted''%' from pg_proc where oid = 'public.enforce_campaign_eligibility()'::regprocedure), ''
  union all select 52, 'start_test / submit_test carry no eligibility logic of their own (enforcement stays in the trigger)',
         (select count(*) = 0 from pg_proc where oid in ('public.start_test(uuid)'::regprocedure, 'public.submit_test(uuid,boolean,text,text,integer,boolean)'::regprocedure) and prosrc like '%tester_eligibility%'), ''
  union all select 53, 'questions: 5 categories x 1 version x 4 open-ended questions (q1..q4), no options column',
         (select count(*) = 20 from public.experience_questions)
         and (select count(distinct category) = 5 and min(c) = 4 and max(c) = 4 from (select category, count(*) c from public.experience_questions where version = 1 group by category) x)
         and (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'experience_questions' and column_name in ('options', 'choices', 'correct')), ''
  union all select 54, 'the qualification table can only hold ASSESSMENT decisions bound to an answers hash (no legacy source possible)',
         (select count(*) = 0 from public.category_qualifications where source <> 'ai_assessment' or answers_hash is null or question_version < 1)
         and (select count(*) = 0 from pg_constraint where conrelid = 'public.category_qualifications'::regclass and pg_get_constraintdef(oid) like '%legacy%'), ''
  union all select 56, 'no AI decision exists without consent history (every ai_assessment row has a consent row)',
         (select count(*) = 0 from public.category_qualifications q where q.source = 'ai_assessment'
            and not exists (select 1 from public.ai_consents c where c.user_id = q.user_id)), ''
  union all select 57, 'every campaign that existed before migration 7 is still OPEN testing',
         (select count(*) = 0 from public.campaigns where testing_mode <> 'open' and created_at < (select min(created_at) from public.screening_versions)), ''
  union all select 60 + row_number() over (order by f), 'existing RPC ' || f || ' unchanged: authenticated YES, anon NO',
         has_function_privilege('authenticated', f::regprocedure, 'execute') and not has_function_privilege('anon', f::regprocedure, 'execute'), ''
    from unnest(array[
      'public.start_test(uuid)',
      'public.submit_test(uuid,boolean,text,text,integer,boolean)',
      'public.create_project_with_campaign(text,text,text,text)',
      'public.create_targeted_campaign(text,text,text,text,text[])',
      'public.create_campaign_v2(text,text,text,text,text,text[])',
      'public.list_open_campaigns()',
      'public.get_my_tester_profile()',
      'public.save_tester_profile(text,text,text[])',
      'public.get_my_status()',
      'public.cancel_campaign(uuid)']) as f
  union all select 80, 'credit conservation: ledger sum = sum of balances',
         (select coalesce(sum(delta), 0) from public.credit_ledger) = (select coalesce(sum(credit_balance), 0) from public.profiles),
         (select coalesce(sum(delta), 0) || ' = ' || (select coalesce(sum(credit_balance), 0) from public.profiles)::text from public.credit_ledger)
  union all select 81, 'info: tester profiles (all-time)', null, (select count(*)::text from public.tester_profiles)
  union all select 82, 'info: testers who must now COMPLETE answers before testing (profile exists, no complete category)', null,
         (select count(*)::text from public.tester_profiles t where not public.tester_participation_ready(t.user_id))
  union all select 83, 'info: testers who are participation-ready right now', null,
         (select count(*)::text from public.tester_profiles t where public.tester_participation_ready(t.user_id))
  union all select 84, 'info: earlier multiple-choice passes that now simply wait for the assessment (history only)', null, (select count(distinct (user_id, category))::text from public.screening_attempts where passed)
  union all select 85, 'info: answer sets / consents granted / assessment decisions (counts only)', null,
         (select count(*) || ' / ' || (select count(*) from public.ai_consents where ai_processing) || ' / ' || (select count(*) from public.category_qualifications where source = 'ai_assessment') from public.experience_answers)
  union all select 87, 'info: erasure events logged for the AI service (counts only)', null, (select count(*)::text from public.ai_erasure_events)
  union all select 86, 'info: campaigns / reservations / submissions', null,
         (select count(*) || ' / ' || (select count(*) from public.test_reservations) || ' / ' || (select count(*) from public.test_submissions) from public.campaigns)
) t order by n;
