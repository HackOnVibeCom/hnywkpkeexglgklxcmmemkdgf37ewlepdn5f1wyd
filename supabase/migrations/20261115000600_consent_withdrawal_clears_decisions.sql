-- UXBarter - consent withdrawal removes AI-derived qualification decisions (product decision, 2026-11-15)
--
-- WHY. A professional-category decision (public.category_qualifications) is the outcome of AI processing of the tester's private
-- answers. When the tester withdraws AI consent, that processing result must go too: every qualified professional category
-- returns to PENDING (category_state = 'pending_assessment'), exactly as if it had never been assessed. The anonymous account,
-- the profile, the written answers and access to Open Testing are untouched (participation_ready depends on answers only).
-- Re-granting consent makes the pending categories assessable again (a new subject_ref is issued by set_ai_consent).
--
-- OWNERSHIP / COORDINATION. category_qualifications, ai_consents and set_ai_consent belong to the profile workstream's
-- migration 20261115000300 (contract v1). That file is NOT edited. This migration is a small ADDITIVE layer on top of it
-- (two triggers, no change to any existing function, table, policy or privilege) and REQUIRES migration 8 to be applied first.
-- It supersedes the contract's section 10 sentence "a decision persists after consent withdrawal" (see docs/AI_INTEGRATION_CONTRACT.md,
-- section 11, amendment A4). If the profile workstream prefers to put the same two lines inside set_ai_consent, this migration
-- can be dropped without any other change (the triggers are the only objects it creates).
--
-- 1. AFTER UPDATE trigger on ai_consents: on a true -> false transition, delete every decision of that user. It runs inside the
--    SAME transaction as set_ai_consent (or any other writer), so a withdrawal is never visible without the removal.
-- 2. AFTER INSERT/UPDATE trigger on category_qualifications: a decision can only be written while consent is active. It takes
--    FOR SHARE on the consent row, which serialises it against a concurrent withdrawal: either the withdrawal commits first (the
--    write is refused) or the write commits first (the withdrawal's trigger then deletes it). No interleaving leaves a decision
--    behind a withdrawal. service_record_qualification already checks consent_required; this closes the read-committed race.
--    It is an AFTER trigger on purpose: the table's own CHECK constraints (source, status, hash format ...) are evaluated first,
--    so their behaviour and error messages are exactly the profile workstream's.

create or replace function public.ai_withdrawal_clears_decisions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.category_qualifications q where q.user_id = new.user_id;
  return null;
end;
$$;

drop trigger if exists ai_consents_withdrawal_clears_decisions on public.ai_consents;
create trigger ai_consents_withdrawal_clears_decisions
  after update of ai_processing on public.ai_consents
  for each row
  when (old.ai_processing and not new.ai_processing)
  execute function public.ai_withdrawal_clears_decisions();

create or replace function public.qualification_requires_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.ai_consents c where c.user_id = new.user_id and c.ai_processing for share;
  if not found then
    raise exception 'consent_required';
  end if;
  return null;
end;
$$;

drop trigger if exists category_qualifications_require_consent on public.category_qualifications;
create trigger category_qualifications_require_consent
  after insert or update on public.category_qualifications
  for each row
  execute function public.qualification_requires_consent();

revoke all on function public.ai_withdrawal_clears_decisions() from public, anon, authenticated;
revoke all on function public.qualification_requires_consent() from public, anon, authenticated;
