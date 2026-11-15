-- TARGETED CLEANUP of ONE abandoned throw-away test identity in Production. NOT EXECUTED. Run only with the owner's explicit approval.
--
--   identity : f6b685d5-111c-43d5-9106-1e227f3f9c9d   (anonymous, created 2026-11-15 22:12:19 UTC by an aborted test run; its browser
--              session no longer exists, so nobody can sign in as it)
--   footprint: 1 profiles row (1 starter credit), 1 tester_profiles row (Tech-Savvy Users), 1 experience_answers row (4 fictional
--              technical answers), 1 ai_consents row with ai_processing = TRUE, 1 credit_ledger row (starter +1).
--              No campaign, reservation, submission, referral, qualification, ai_usage or AI-derived row.
--   problem  : consent stays ON for an identity nobody controls, with its answers readable by the AI service whenever it is enabled
--              (only that identity's own request could ever process them, and nobody can make one). It is a loose end, not a leak.
--
-- WHAT THIS DOES (step 1 = recommended minimum, step 2 = optional):
--   1. withdraws AI consent EXACTLY like public.set_ai_consent(false) does for a signed-in tester: logs the 'consent_withdrawn' erasure
--      event, flips ai_processing to false (the migration-10 trigger then removes any AI decision), so the cron sweep removes every
--      AI-derived row that could ever exist for it.
--   2. (optional) deletes its free-text answers like public.delete_my_experience(NULL): the 'answers_deleted' erasure event is logged.
-- WHAT IT NEVER TOUCHES: profiles, credit balance, credit_ledger, referrals, campaigns, auth.users. Deleting the identity itself (auth user +
-- profile + ledger) is a SEPARATE decision (it would remove a credit_ledger row); this script does not do it.
--
-- HOW TO RUN (owner login, one transaction; the preview and the verification are read-only):
--   npx supabase db query --remote --yes --file docs/cleanup-abandoned-test-identity.sql
-- Rollback: step 1 is reversible by the identity's owner only (nobody); the erasure it triggers is not. That is the point.

-- 0. PREVIEW (read-only) - must show exactly the footprint above before anything is run
select 'consent' as what, c.ai_processing::text as value from public.ai_consents c where c.user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d'
union all select 'answers', count(*)::text from public.experience_answers where user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d'
union all select 'ledger_rows', count(*)::text from public.credit_ledger where user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d'
union all select 'credit_balance', credit_balance::text from public.profiles where id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d';

-- 1. withdraw consent (identical to set_ai_consent(false))
insert into public.ai_erasure_events (subject_ref, reason)
select c.subject_ref, 'consent_withdrawn' from public.ai_consents c
 where c.user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d' and c.ai_processing;
update public.ai_consents
   set ai_processing = false, updated_at = clock_timestamp()
 where user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d' and ai_processing;

-- 2. OPTIONAL - delete its free-text answers (identical to delete_my_experience(NULL)); remove this block to keep the answers
with d as (
  delete from public.experience_answers a where a.user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d' returning 1
), q as (
  delete from public.category_qualifications x where x.user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d' and x.source = 'ai_assessment' returning 1
)
insert into public.ai_erasure_events (subject_ref, reason, category)
select k.subject_ref, 'answers_deleted', null from public.ai_consents k
 where k.user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d' and ((select count(*) from d) > 0 or (select count(*) from q) > 0);

-- 3. VERIFICATION (read-only; run again after a minute for the cron sweep): consent false, answers 0, ledger_rows 1, credit_balance 1,
--    ai_derived 0, and the erasure cursor has advanced past the new events.
select 'consent' as what, c.ai_processing::text as value from public.ai_consents c where c.user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d'
union all select 'answers', count(*)::text from public.experience_answers where user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d'
union all select 'ledger_rows', count(*)::text from public.credit_ledger where user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d'
union all select 'credit_balance', credit_balance::text from public.profiles where id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d'
union all select 'ai_derived', ((select count(*) from public.ai_profile_analyses where user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d')
                              + (select count(*) from public.ai_match_cache where user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d')
                              + (select count(*) from public.ai_assessment_notes where user_id = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d'))::text
union all select 'erasure_cursor', last_id::text from public.ai_erasure_cursor where id = 1;
