-- PeerProbe — core schema.
--
-- Design rules (see supabase/README.md):
--   * The database is the source of truth. Browsers never write to tables directly;
--     every write goes through a SECURITY DEFINER RPC (migration 0003).
--   * Identity = Supabase Anonymous Auth user (auth.users.id). No email / password.
--   * Credits are an append-only ledger (credit_ledger) mirrored by profiles.credit_balance,
--     both changed only inside the same RPC transaction.

-- ---------------------------------------------------------------------------
-- URL validation shared by table CHECKs and RPCs.
-- Public http(s) URL with a real DNS hostname: no IP literals, no localhost,
-- no user:pass@, no javascript:/data: schemes. (Non-ASCII hosts: use punycode.)
-- ---------------------------------------------------------------------------
create or replace function public.is_valid_public_url(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_url is not null
     and char_length(p_url) <= 2048
     and p_url ~* '^https?://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
$$;

-- ---------------------------------------------------------------------------
-- trim_all(): trims ALL whitespace incl. newlines, tabs, NBSP and zero-width
-- characters. Plain btrim() only strips U+0020, so "\n\n\n" would otherwise
-- satisfy minimum-length checks. Matches what JS String.trim() does client-side.
-- ---------------------------------------------------------------------------
create or replace function public.trim_all(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
    p_text,
    '^[[:space:] ​‌‍⁠﻿]+|[[:space:] ​‌‍⁠﻿]+$',
    '', 'g')
$$;

-- ---------------------------------------------------------------------------
-- profiles: one row per anonymous identity. Holds the spendable balance.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  credit_balance integer     not null default 0 check (credit_balance >= 0),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- projects: a website a founder wants tested.
-- ---------------------------------------------------------------------------
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references public.profiles (id) on delete cascade,
  name        text        not null check (char_length(public.trim_all(name)) between 2 and 80),
  url         text        not null check (public.is_valid_public_url(url)),
  description text        check (description is null or char_length(description) <= 500),
  created_at  timestamptz not null default now()
);
create index projects_owner_idx on public.projects (owner_id);

-- ---------------------------------------------------------------------------
-- campaigns: one requested test (a task) for a project.
-- MVP: exactly one response per campaign (max_responses = 1). Raise the CHECK
-- (and the per-campaign price in create_project_with_campaign) to expand later.
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid        not null references public.projects (id) on delete cascade,
  owner_id         uuid        not null references public.profiles (id) on delete cascade,
  task_description text        not null check (char_length(public.trim_all(task_description)) between 20 and 600),
  status           text        not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  max_responses    integer     not null default 1 check (max_responses = 1),
  response_count   integer     not null default 0 check (response_count between 0 and max_responses),
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index campaigns_owner_idx on public.campaigns (owner_id);
create index campaigns_open_idx  on public.campaigns (created_at) where status = 'open';

-- ---------------------------------------------------------------------------
-- test_submissions: structured human feedback.
-- UNIQUE (campaign_id, tester_id) => one response per tester per campaign.
-- share_consent = tester allows the founder to show this feedback publicly.
-- Default false; nothing in the MVP exposes feedback publicly regardless.
-- ---------------------------------------------------------------------------
create table public.test_submissions (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid        not null references public.campaigns (id) on delete cascade,
  tester_id      uuid        not null references public.profiles (id) on delete cascade,
  task_completed boolean     not null,
  friction       text        not null check (char_length(public.trim_all(friction)) between 10 and 2000),
  suggestion     text        not null check (char_length(public.trim_all(suggestion)) between 10 and 2000),
  ux_rating      smallint    not null check (ux_rating between 1 and 5),
  share_consent  boolean     not null default false,
  created_at     timestamptz not null default now(),
  constraint test_submissions_one_per_tester unique (campaign_id, tester_id)
);
create index test_submissions_tester_idx on public.test_submissions (tester_id);

-- Defence in depth: a tester can never submit against their own campaign,
-- even if some future code path forgets the RPC check.
create or replace function public.enforce_not_own_campaign()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.campaigns c
    where c.id = new.campaign_id and c.owner_id = new.tester_id
  ) then
    raise exception 'own_campaign';
  end if;
  return new;
end;
$$;

create trigger test_submissions_not_own
  before insert on public.test_submissions
  for each row execute function public.enforce_not_own_campaign();

-- ---------------------------------------------------------------------------
-- credit_ledger: append-only history. Partial unique indexes make the three
-- money events idempotent even if application code has a bug:
--   * one starter credit per identity
--   * one reward per tester per campaign
--   * one spend per campaign
-- ---------------------------------------------------------------------------
create table public.credit_ledger (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null references public.profiles (id) on delete cascade,
  delta       integer     not null check (delta <> 0),
  reason      text        not null check (reason in ('starter', 'test_reward', 'campaign_spend')),
  campaign_id uuid        references public.campaigns (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint credit_ledger_sign check (
    (reason = 'campaign_spend' and delta < 0) or (reason <> 'campaign_spend' and delta > 0)
  )
);
create index credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);

create unique index credit_ledger_one_starter on public.credit_ledger (user_id)
  where reason = 'starter';
create unique index credit_ledger_one_reward  on public.credit_ledger (user_id, campaign_id)
  where reason = 'test_reward';
create unique index credit_ledger_one_spend   on public.credit_ledger (campaign_id)
  where reason = 'campaign_spend';
