-- PRIVACY-ERASURE SCHEDULE for the AI layer (NOT executed yet; run with the owner's approval, in the Supabase SQL editor or
-- `npx supabase db query --remote --yes --file docs/enable-erasure-cron.sql`).
--
-- What it does: once a minute, public.ai_apply_erasure_events() applies the profile workstream's erasure events and deletes every AI-derived
-- row (analyses, cached recommendations, clarification notes) whose tester withdrew consent / deleted answers / deleted their account.
-- The Edge Function also runs the same sweep at the start of every request, so the schedule only guarantees erasure when there is NO traffic
-- or when the AI kill switches are off.
--
-- State checked on Production (read-only, 2026-11-15): pg_cron 1.6.4 is AVAILABLE but NOT installed (schema "cron" absent);
-- cron.database_name = postgres; ai_apply_erasure_events is owned by postgres and executable by it (the cron job runs as the scheduling user).
-- Prerequisite (one human action, either way): enable the extension. Dashboard -> Database -> Extensions -> search "pg_cron" -> enable
-- (recommended), OR run the first statement below as the project owner.
--
-- Safety: the function is SECURITY DEFINER, takes no required argument, returns at once if another sweep holds the cursor row
-- (FOR UPDATE SKIP LOCKED), only deletes rows without active consent, and writes nothing when there is nothing to do. Tested in
-- supabase/tests/ai_matching.mjs and the Deno end-to-end. pg_cron itself cannot be tested outside Supabase.

create extension if not exists pg_cron;

-- manual dry run first: must return an integer (number of erasure events processed) and no error
select public.ai_apply_erasure_events();

select cron.schedule('ai-erasure-sweep', '* * * * *', $$select public.ai_apply_erasure_events()$$);

-- verification (read-only)
select jobid, jobname, schedule, active from cron.job where jobname = 'ai-erasure-sweep';
-- after a few minutes:
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'ai-erasure-sweep') order by start_time desc limit 5;
-- remove:
--   select cron.unschedule('ai-erasure-sweep');
