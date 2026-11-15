// Shared test harness: real Postgres (PGlite/WASM) + the REAL migration files, with only the
// Supabase-specific pieces stubbed: roles anon / authenticated / service_role, schema auth,
// auth.users and auth.uid() (reads request.jwt.claim.sub, the GUC PostgREST sets per request).
//
// The stub deliberately mimics Supabase's OLD permissive default privileges (broad grants on new
// tables/functions) so the migrations must revoke them themselves. The stricter "automatic table
// exposure disabled" setting is a subset of that, so it is covered too.
//
// Limits: PGlite is single-connection, so true parallel races cannot be exercised here. Exactly-once
// behaviour under concurrency relies on row locks + unique indexes; tests check those constraints
// directly. Real parallel races are covered by the live-API script (needs a real project).

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// MIGRATIONS_DIR is only for mutation testing the tests themselves (see README); default = real migrations.
const migDir = process.env.MIGRATIONS_DIR ?? join(here, '..', 'migrations');

/**
 * @param migrations       optional whitelist of migration file names to apply (default: all)
 * @param exposureDisabled true = model Supabase's "automatic table exposure DISABLED": NO default
 *                         privileges for anon/authenticated on new objects (the migrations must grant
 *                         everything explicitly). Default false = the old permissive defaults.
 * @param autoRls          true = model "automatic RLS": an event trigger enables RLS on every table
 *                         created in public.
 */
/**
 * upTo:      apply only migrations up to (and including) this file name. Suites that pin the behaviour of migrations that are
 *            ALREADY LIVE in production (6, 7) use it, so they keep testing exactly what runs there.
 * autoReady: TEST FIXTURE ONLY (never part of a migration): every new identity automatically gets a completed tester profile
 *            (Students & Learners + four valid answers), because since migration 8 a tester needs one to reserve ANY task.
 *            The credit / lifecycle / referral regression suites use it so they keep exercising their own subject; the
 *            participation rule itself is tested without the fixture (experience.mjs, upgrade.mjs).
 */
export async function createHarness({ migrations = null, quiet = false, exposureDisabled = false, autoRls = false, upTo = null, autoReady = false } = {}) {
  const db = new PGlite();

  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  if (!exposureDisabled) {
    // Mimic Supabase's old default privileges (broad grants that our migrations must revoke).
    await db.exec(`
      alter default privileges in schema public grant all on tables to anon, authenticated;
      alter default privileges in schema public grant all on functions to anon, authenticated;
    `);
  }
  if (autoRls) {
    await db.exec(`
      create function public.rls_auto_enable() returns event_trigger language plpgsql as $$
      declare r record; begin
        for r in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' and schema_name = 'public' loop
          execute format('alter table %s enable row level security', r.object_identity);
        end loop; end $$;
      create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE') execute function public.rls_auto_enable();
    `);
  }

  const files = readdirSync(migDir).filter((n) => n.endsWith('.sql')).sort();
  for (const f of files) {
    if (migrations && !migrations.includes(f)) continue;
    if (upTo && f > upTo) continue;
    await db.exec(readFileSync(join(migDir, f), 'utf8'));
    if (!quiet) console.log(`applied ${f}`);
  }

  if (autoReady) {
    await db.exec(`
      create function public.test_fixture_ready() returns trigger language plpgsql security definer set search_path = '' as $f$
      declare a jsonb := '{"q1":"fixture answer number one","q2":"fixture answer number two","q3":"fixture answer number three","q4":"fixture answer number four"}'::jsonb;
      begin
        insert into public.tester_profiles (user_id, nickname, categories) values (new.id, 'Fixture', '{students_learners}');
        insert into public.experience_answers (user_id, category, version, answers, answers_hash)
        values (new.id, 'students_learners', 1, a, public.experience_hash(1, a));
        return new;
      end $f$;
      create trigger test_fixture_ready after insert on public.profiles for each row execute function public.test_fixture_ready();
    `);
  }

  let passed = 0;
  let failed = 0;
  const ok = (cond, name, extra = '') => {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
  };

  /** Run SQL as a given identity (role + jwt sub). uid=null → role anon. */
  async function as(uid, fn) {
    await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
    try { return await fn(); }
    finally { await db.exec('reset role'); }
  }
  const q = (sql, params) => db.query(sql, params).then((r) => r.rows);
  const fails = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };
  const failsWith = async (fn, code) => (await fails(fn))?.includes(code) ?? false;

  const summary = () => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  };

  return { db, as, q, ok, fails, failsWith, summary, counts: () => ({ passed, failed }) };
}

/** Deterministic test user ids: 00000000-0000-0000-0000-0000000000NN */
export const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
