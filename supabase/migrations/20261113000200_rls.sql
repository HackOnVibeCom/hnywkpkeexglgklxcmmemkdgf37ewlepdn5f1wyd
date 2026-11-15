-- PeerProbe — Row Level Security and table privileges.
--
-- Model: the browser (role `authenticated`, which includes anonymous-auth users)
-- may only READ rows it owns / is party to. It has NO insert/update/delete on
-- any table. All writes happen in SECURITY DEFINER RPCs (migration 0003).
-- The unauthenticated `anon` role gets nothing at all.

-- With "automatic table exposure" disabled, nothing is granted implicitly: the API role must be
-- able to resolve objects in the schema. Idempotent; `anon` deliberately gets no schema access.
grant usage on schema public to authenticated;

-- Start from zero: Supabase's default privileges hand out broad grants.
revoke all on public.profiles         from anon, authenticated;
revoke all on public.projects         from anon, authenticated;
revoke all on public.campaigns        from anon, authenticated;
revoke all on public.test_submissions from anon, authenticated;
revoke all on public.credit_ledger    from anon, authenticated;

-- Close the door on FUTURE objects too: Supabase default privileges would otherwise hand
-- anon/authenticated ALL on any table/sequence/function created later by this role.
-- (Applies to objects created by the role running migrations. If your project also creates
-- objects as supabase_admin, repeat with `for role supabase_admin`, which needs that role.)
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
-- Postgres grants EXECUTE to PUBLIC on every new function; only the schema-less form removes that
-- built-in default (an `in schema` revoke cannot). Scope: functions later created by this role.
alter default privileges revoke execute on functions from public;

alter table public.profiles         enable row level security;
alter table public.projects         enable row level security;
alter table public.campaigns        enable row level security;
alter table public.test_submissions enable row level security;
alter table public.credit_ledger    enable row level security;

-- profiles: you see only your own balance.
grant select on public.profiles to authenticated;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

-- projects: owners only. Testers get what they need via get_campaign_for_test().
grant select on public.projects to authenticated;
create policy projects_select_own on public.projects
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- campaigns: owners only. Discovery goes through list_open_campaigns().
grant select on public.campaigns to authenticated;
create policy campaigns_select_own on public.campaigns
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- test_submissions: visible to the tester who wrote it and to the campaign owner.
-- Column-level grant hides tester_id from the owner (testers stay anonymous).
-- NOTE: because of this, clients must list columns explicitly — `select *` is
-- rejected by Postgres when a column is not granted.
grant select (id, campaign_id, task_completed, friction, suggestion, ux_rating, share_consent, created_at)
  on public.test_submissions to authenticated;
create policy submissions_select_party on public.test_submissions
  for select to authenticated
  using (
    tester_id = (select auth.uid())
    or exists (
      select 1 from public.campaigns c
      where c.id = test_submissions.campaign_id
        and c.owner_id = (select auth.uid())
    )
  );

-- credit_ledger: your own history only.
grant select on public.credit_ledger to authenticated;
create policy ledger_select_own on public.credit_ledger
  for select to authenticated
  using (user_id = (select auth.uid()));

-- There is deliberately NO public/anon policy anywhere: private feedback is never
-- exposed publicly. Public proof cards (post-MVP) must be a separate, explicit
-- view/RPC that filters on test_submissions.share_consent = true.
