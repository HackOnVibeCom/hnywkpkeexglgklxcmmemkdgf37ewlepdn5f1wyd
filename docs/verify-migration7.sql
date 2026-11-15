-- READ-ONLY verification of migration 7 (Matching v2). Pure SELECT: it changes nothing.
-- Paste into the Supabase SQL Editor AFTER the migration was applied. Every row of the "ok" column must be true;
-- the "info" rows only show current numbers.
select check_name, ok, detail from (
  select 1 as n, 'migration 7 recorded' as check_name,
         (select count(*) = 1 from supabase_migrations.schema_migrations where version = '20261115000200') as ok, '' as detail
  union all select 2 + row_number() over (order by t), 'RLS on, no policy, no client privilege: ' || t,
         (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass)
           and (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = t)
           and not (has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete,truncate,references,trigger')
                 or has_table_privilege('authenticated', 'public.' || t, 'select,insert,update,delete,truncate,references,trigger'))
           and (select count(*) = 0 from information_schema.column_privileges
                 where table_schema = 'public' and table_name = t and grantee in ('anon', 'authenticated', 'PUBLIC')), ''
    from unnest(array['screening_versions', 'screening_questions', 'screening_attempts']) as t
  union all select 10 + row_number() over (order by f), 'RPC ' || f || ': authenticated YES, anon NO, PUBLIC NO, SECURITY DEFINER + search_path',
         has_function_privilege('authenticated', f::regprocedure, 'execute')
         and not has_function_privilege('anon', f::regprocedure, 'execute')
         and not has_function_privilege('public', f::regprocedure, 'execute')
         and (select prosecdef and coalesce(proconfig::text, '') like '%search_path%' from pg_proc where oid = f::regprocedure), ''
    from unnest(array[
      'public.create_campaign_v2(text,text,text,text,text,text[])',
      'public.list_campaigns_v2()',
      'public.get_campaign_eligibility(uuid)',
      'public.get_screening(text)',
      'public.submit_screening(text,jsonb)',
      'public.get_my_screening_status()']) as f
  union all select 20 + row_number() over (order by f), 'internal ' || f || ': NOT executable by anon, authenticated or PUBLIC',
         not (has_function_privilege('anon', f::regprocedure, 'execute')
           or has_function_privilege('authenticated', f::regprocedure, 'execute')
           or has_function_privilege('public', f::regprocedure, 'execute')), ''
    from unnest(array[
      'public.category_requires_screening(text)',
      'public.screening_current_version(text)',
      'public.is_screened(uuid,text)',
      'public.tester_eligibility(uuid,text,text[])',
      'public.enforce_campaign_eligibility()']) as f
  union all select 30, 'eligibility trigger installed and enabled on test_reservations',
         (select count(*) = 1 from pg_trigger where tgrelid = 'public.test_reservations'::regclass and tgname = 'test_reservations_eligibility' and tgenabled = 'O'), ''
  union all select 31, 'campaigns.testing_mode: NOT NULL, default open, CHECK present',
         (select a.attnotnull and pg_get_expr(d.adbin, d.adrelid) like '%open%'
            from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where a.attrelid = 'public.campaigns'::regclass and a.attname = 'testing_mode')
         and (select count(*) = 1 from pg_constraint where conrelid = 'public.campaigns'::regclass and conname = 'campaigns_testing_mode_check')
         and (select count(*) = 1 from pg_constraint where conrelid = 'public.campaigns'::regclass and conname = 'campaigns_targeted_requires_categories'), ''
  union all select 32, 'clients cannot write campaigns.testing_mode / read it as anon',
         not (has_column_privilege('authenticated', 'public.campaigns', 'testing_mode', 'insert,update,references')
           or has_column_privilege('anon', 'public.campaigns', 'testing_mode', 'select,insert,update')), ''
  union all select 33, 'EVERY existing campaign is OPEN testing (none silently restricted)',
         (select count(*) = 0 from public.campaigns where testing_mode <> 'open'), (select count(*) || ' campaigns checked' from public.campaigns)
  union all select 34, 'campaigns created with Matching-v1 preferred categories are still OPEN',
         (select count(*) = 0 from public.campaigns where target_categories <> '{}' and testing_mode <> 'open'), (select count(*) || ' campaigns have preferred categories' from public.campaigns where target_categories <> '{}')
  union all select 40, 'screening content seeded: 3 categories x 1 version x 4 questions',
         (select count(*) = 3 from public.screening_versions) and (select count(*) = 12 from public.screening_questions)
         and (select count(distinct category) = 3 and min(c) = 4 and max(c) = 4 from (select category, count(*) c from public.screening_questions group by category) x), ''
  union all select 41, 'no screening attempts yet (nothing was written by the migration)',
         (select count(*) = 0 from public.screening_attempts), ''
  union all select 42, 'screening attempts table stores no answers (outcome columns only)',
         (select string_agg(column_name, ',' order by ordinal_position) = 'id,user_id,category,version,passed,areas,created_at'
            from information_schema.columns where table_schema = 'public' and table_name = 'screening_attempts'), ''
  union all select 50 + row_number() over (order by f), 'existing RPC ' || f || ' unchanged: authenticated YES, anon NO',
         has_function_privilege('authenticated', f::regprocedure, 'execute') and not has_function_privilege('anon', f::regprocedure, 'execute'), ''
    from unnest(array[
      'public.list_open_campaigns()',
      'public.list_matched_campaigns()',
      'public.create_project_with_campaign(text,text,text,text)',
      'public.create_targeted_campaign(text,text,text,text,text[])',
      'public.get_campaign_for_test(uuid)',
      'public.start_test(uuid)',
      'public.submit_test(uuid,boolean,text,text,integer,boolean)',
      'public.cancel_campaign(uuid)',
      'public.get_my_status()',
      'public.claim_referral(text)',
      'public.settle_referral_rewards()',
      'public.get_my_referrals()',
      'public.ensure_profile()',
      'public.settle_expired_campaigns()',
      'public.save_tester_profile(text,text,text[])',
      'public.get_my_tester_profile()']) as f
  union all select 70, 'credit conservation: ledger sum = sum of balances',
         (select coalesce(sum(delta), 0) from public.credit_ledger) = (select coalesce(sum(credit_balance), 0) from public.profiles),
         (select coalesce(sum(delta), 0) || ' = ' || (select coalesce(sum(credit_balance), 0) from public.profiles)::text from public.credit_ledger)
  union all select 71, 'info: campaigns rows', null, (select count(*)::text from public.campaigns)
  union all select 72, 'info: test_reservations rows', null, (select count(*)::text from public.test_reservations)
  union all select 73, 'info: test_submissions rows', null, (select count(*)::text from public.test_submissions)
  union all select 74, 'info: credit_ledger rows', null, (select count(*)::text from public.credit_ledger)
  union all select 75, 'info: tester_profiles rows', null, (select count(*)::text from public.tester_profiles)
  union all select 76, 'info: profiles rows', null, (select count(*)::text from public.profiles)
) t order by n;
