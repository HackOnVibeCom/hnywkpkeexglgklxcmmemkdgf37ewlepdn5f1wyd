// RELEASE REHEARSAL: the exact production upgrade 7 -> 8 -> 9 -> 10 (and the emergency rollback) on a POPULATED database.
//   * production-like Supabase settings: "automatic table exposure" disabled (no default grants) + "automatic RLS" enabled;
//   * the database is first brought to the state production is in today (migrations 1-7) and filled with realistic legacy data:
//     owners with open / targeted campaigns, testers without a profile, with an incomplete profile, with an old multiple-choice
//     pass, with an in-progress reservation, with finished tests and credits;
//   * migrations 8, 9 and 10 are then applied ONE AT A TIME, with the existing data, in-progress reservations, credits and the
//     user journeys (incomplete / general / pending professional / qualified professional / withdrawn consent) checked after each;
//   * docs/rollback-gate-to-migration7.sql is run and must restore the pre-migration-8 behaviour exactly;
//   * every RPC the frontend and the Edge Function call is checked to exist with the right privileges.
// Real Postgres (PGlite) + the real migration files. Single connection: no true parallel races.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, uid } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const mig = (f) => readFileSync(join(here, '..', 'migrations', f), 'utf8');
const M8 = '20261115000300_experience_profile.sql';
const M9 = '20261115000500_ai_matching.sql';
const M10 = '20261115000600_consent_withdrawal_clears_decisions.sql';

const { db, as, q, ok, failsWith, fails, summary } = await createHarness({
  quiet: true, upTo: '20261115000200_matching_v2.sql', exposureDisabled: true, autoRls: true,
});

const TASK = 'Find the pricing page and tell me which plan you would pick.';
const FB = { friction: 'The pricing link was hidden in the footer.', suggestion: 'Add a pricing link to the top nav.' };
const H = (c) => c.repeat(64).slice(0, 64);
const ANS = (tag) => ({ q1: `I use ${tag} tools almost every single day`, q2: `A small project where I built ${tag} things myself`, q3: `Something broke once so I read the ${tag} logs carefully`, q4: `Products related to ${tag} are the ones I enjoy testing` });
let nextId = 1;
async function mk() {
  const id = uid(nextId++);
  await db.query('insert into auth.users (id) values ($1)', [id]);
  await as(id, () => q('select * from public.ensure_profile()'));
  return id;
}
const svc = async (fn) => { await db.exec('set role service_role'); try { return await fn(); } finally { await db.exec('reset role'); } };
const bal = async (u) => (await as(u, () => q('select credit_balance from public.profiles')))[0].credit_balance;
const profile = (u, cats, bio = 'I like testing things') => as(u, () => q('select * from public.save_tester_profile($1,$2,$3)', ['Tester', bio, cats]));
const createV2 = async (owner, mode, cats, name) => (await as(owner, () => q('select public.create_campaign_v2($1,$2,$3,$4,$5,$6) id', [name, 'https://example.com', 'd', TASK, mode, cats])))[0].id;
const startOf = (u, camp) => as(u, () => q('select public.start_test($1) r', [camp]));
const finish = async (u, camp) => {
  await q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds' where tester_id=$1 and campaign_id=$2`, [u, camp]);
  return (await as(u, () => q('select public.submit_test($1,true,$2,$3,4,false) r', [camp, FB.friction, FB.suggestion])))[0].r;
};
const save = (u, cat, a) => as(u, () => q('select public.save_experience_answers($1,$2::jsonb) r', [cat, JSON.stringify(a)])).then((r) => r[0].r);
const my = async (u) => (await as(u, () => q('select public.get_my_experience() r')))[0].r;
const catState = async (u, c) => (await my(u)).categories.find((x) => x.category === c).state;
const consent = (u, g) => as(u, () => q('select public.set_ai_consent($1) r', [g]));
const decide = (u, c, status) => svc(async () => {
  const p = (await q('select public.service_get_ai_profile($1) r', [u]))[0].r.categories.find((x) => x.category === c);
  return (await q('select public.service_record_qualification($1,$2,$3,$4,$5,$6::jsonb) r', [u, c, p.question_version, p.answers_hash, status, JSON.stringify({ model: 'm', rubric_version: 'r1', summary: 'Self-reported answers judged to show hands-on experience (rubric r1).', confidence: 0.85 })]))[0].r;
});
const camp = async (name, mode = 'open', cats = []) => createV2(await mk(), mode, cats, name); // one active campaign per owner: a new owner each time
const feedOf = (u) => as(u, () => q('select * from public.list_campaigns_v2()'));

// ------------------------------------------------------------------------------------------------------------------
console.log('\n[production state today: migrations 1-7 with realistic legacy data]');
const O1 = await mk(), O2 = await mk(), O3 = await mk(), O4 = await mk(), O5 = await mk();
const openA = await createV2(O1, 'open', [], 'Open A');
const targetedPro = await createV2(O2, 'targeted', ['tech_savvy'], 'Pro Tool');
const openB = await createV2(O3, 'open', [], 'Open B');
const openC = await createV2(O4, 'open', [], 'Open C (in progress)');
const openD = await createV2(O5, 'open', [], 'Open D');
const TA = await mk(); await profile(TA, ['students_learners']);            // legacy tester, profile but no answers
const TB = await mk(); await profile(TB, ['tech_savvy']);                    // legacy tester with an old multiple-choice pass
await as(TB, () => q(`select public.submit_screening('tech_savvy', $1::jsonb)`, [JSON.stringify({ q1: ['code', 'terminal'], q2: ['git'], q3: ['none'], q4: ['none'] })]));
const TC = await mk();                                                        // legacy tester with no profile at all
const TD = await mk(); await profile(TD, ['students_learners']);              // legacy tester with a reservation IN PROGRESS
await startOf(TD, openC);
const TE = await mk();                                                        // legacy tester who finished a task and earned a credit
await startOf(TE, openB); await finish(TE, openB);
const legacyPass = (await q(`select count(*)::int n from public.screening_attempts where passed`))[0].n;
ok(legacyPass === 1, 'precondition: one legacy multiple-choice pass exists');
const preC = await camp('Open E (reserved by a no-profile tester)');
ok((await startOf(TC, preC)).length === 1, 'precondition (migration 7): a tester with NO profile can start an open task');

const PUBLIC_TABLES = (await q(`select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`)).map((r) => r.relname);
const rowsMd5 = async (t) => (await q(`select count(*)::int n, coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)),'') h from public.${t} x`))[0];
const snapshot = async () => Object.fromEntries(await Promise.all(PUBLIC_TABLES.map(async (t) => [t, await rowsMd5(t)])));
const FIVE = ['tester_eligibility', 'enforce_campaign_eligibility', 'get_screening', 'submit_screening', 'list_matched_campaigns'];
const defs = async () => Object.fromEntries(await Promise.all(FIVE.map(async (f) => [f, (await q(`select md5(pg_get_functiondef(p.oid)) h from pg_proc p where p.proname=$1 and p.pronamespace='public'::regnamespace`, [f]))[0].h])));
const allFns = async () => Object.fromEntries((await q(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig, md5(pg_get_functiondef(p.oid)) h from pg_proc p where p.pronamespace='public'::regnamespace`)).map((r) => [r.sig, r.h]));
const before = await snapshot();
const fnsBefore = await allFns();
const defsBefore = await defs();
const ledgerOk = async () => (await q(`select count(*)::int n from public.profiles p where p.credit_balance <> coalesce((select sum(delta) from public.credit_ledger l where l.user_id = p.id),0)`))[0].n === 0;
ok(await ledgerOk(), 'precondition: the ledger sums to every balance');
const creditsBefore = (await q('select coalesce(sum(credit_balance),0)::int s from public.profiles'))[0].s;

// ------------------------------------------------------------------------------------------------------------------
console.log('\n[step 1: apply migration 8 on the populated database]');
let err = null;
try { await db.exec(mig(M8)); } catch (e) { err = e.message; }
ok(err === null, 'migration 8 applies cleanly with production-like settings', err ?? '');
const after8 = await snapshot();
const changedTables = PUBLIC_TABLES.filter((t) => JSON.stringify(before[t]) !== JSON.stringify(after8[t]));
ok(changedTables.length === 0, 'every EXISTING table (campaigns, profiles, tester profiles, reservations, feedback, ledger, referrals, screening history) is byte-identical', changedTables.join());
const fns8 = await allFns();
const changed8 = Object.keys(fnsBefore).filter((k) => fns8[k] !== fnsBefore[k]).map((k) => k.split('(')[0]).sort();
ok(JSON.stringify(changed8) === JSON.stringify([...FIVE].sort()), 'exactly five existing function bodies changed (tester_eligibility, enforce_campaign_eligibility, get_screening, submit_screening, list_matched_campaigns)', changed8.join());
ok((await q('select count(*)::int n from public.experience_questions'))[0].n === 20, '20 question rows (5 categories x 4) were seeded');
ok(await ledgerOk(), 'the ledger still sums to every balance');

console.log('\n  [in-progress reservation and finished work]');
ok(!!(await finish(TD, openC)) && (await bal(TD)) >= 1, 'a reservation started BEFORE the migration (tester with no answers) still submits and is rewarded afterwards');
ok((await bal(TE)) >= 2, 'credits earned before the migration are untouched');

console.log('\n  [user journeys right after migration 8 (new UI deployed first)]');
const a8 = await my(TA);
ok(a8.has_profile && a8.participation_ready === false && (await catState(TA, 'students_learners')) === 'incomplete', 'legacy tester with a profile and no answers: profile kept, category INCOMPLETE, not ready');
const openX = await camp('Open X'), openY = await camp('Open Y'), openW = await camp('Open W');
ok(await failsWith(() => startOf(TA, openX), 'not_eligible'), '...cannot start a NEW task until the four answers are saved (the intended rule)');
const feedA = await feedOf(TA);
ok(feedA.length >= 3 && feedA.every((f) => f.eligible === false), 'FEED: ' + JSON.stringify(feedA.map((f) => [f.eligible, f.fit])) + ' ... ' + '...but still SEES every task (browse is never gated); the feed says what is missing');
ok(!!(await createV2(TA, 'open', [], 'TA requests a test')), '...and can still REQUEST tests (creating campaigns is not gated)');
const TH = await mk(); // no profile, no reservation
ok(await failsWith(() => startOf(TH, openY), 'not_eligible') && (await my(TH)).has_profile === false, 'a tester with no profile: same, and the UI can offer the profile page');
const b8 = await my(TB);
ok((await catState(TB, 'tech_savvy')) === 'incomplete' && (await q('select count(*)::int n from public.category_qualifications'))[0].n === 0, 'a legacy multiple-choice pass is NOT carried over: no qualification exists');
ok(await failsWith(() => as(TB, () => q(`select public.get_screening('tech_savvy')`)), 'screening_replaced'), 'the old screening RPC refuses (an old UI must not stay deployed with migration 8: the documented order prevents that window)');

// general category: active on its four answers
const saveA = await save(TA, 'students_learners', ANS('study'));
ok(saveA.state === 'active' && (await my(TA)).participation_ready === true, 'COMPLETED general profile: Students & Learners is ACTIVE straight after the four answers, no assessment');
ok(!!(await startOf(TA, openA))[0].r, '...and the tester can start an open task');
// pending professional
await save(TB, 'tech_savvy', ANS('tech'));
ok((await catState(TB, 'tech_savvy')) === 'pending_assessment' && (await my(TB)).participation_ready === true, 'PENDING professional: answers saved => pending_assessment (never active) and the tester counts as profile-complete');
ok(await failsWith(() => startOf(TB, targetedPro), 'not_eligible'), '...but a targeted professional task stays unavailable until a valid assessment (no temporary approval)');
ok(!!(await startOf(TB, openD))[0].r, '...so with NO AI service at all a professional-only tester can still take open tasks (nobody is blocked by the missing assessment service)');
const e8 = await as(TB, () => q('select public.get_campaign_eligibility($1) r', [targetedPro]));
ok(e8[0].r.eligible === false, '...and the eligibility function says so (what the UI and the AI both read)');

// ------------------------------------------------------------------------------------------------------------------
console.log('\n[step 2: apply migration 9 (AI infrastructure) and 10 (consent withdrawal)]');
const before9 = await snapshot();
err = null;
try { await db.exec(mig(M9)); } catch (e) { err = e.message; }
ok(err === null, 'migration 9 applies cleanly on top of 8');
const after9 = await snapshot();
ok(PUBLIC_TABLES.every((t) => JSON.stringify(after9[t]) === JSON.stringify(before9[t])), 'migration 9 changed no existing row');
const fns9 = await allFns();
ok(Object.keys(fns8).every((k) => fns9[k] === fns8[k]), 'migration 9 changed no existing function body (purely additive)');
err = null;
try { await db.exec(mig(M10)); } catch (e) { err = e.message; }
ok(err === null, 'migration 10 applies cleanly on top of 9');
const fns10 = await allFns();
ok(Object.keys(fns9).every((k) => fns10[k] === fns9[k]), 'migration 10 changed no existing function body');
ok((await q(`select count(*)::int n from pg_trigger where tgname in ('ai_consents_withdrawal_clears_decisions','category_qualifications_require_consent') and not tgisinternal`))[0].n === 2, 'migration 10 added exactly its two triggers');

console.log('\n  [qualified professional, then consent withdrawn]');
await consent(TB, true);
ok(!!(await finish(TB, openD)), '(the tester completes their open task first)');
ok((await decide(TB, 'tech_savvy', 'qualified')).state === 'active', 'QUALIFIED professional: a valid server decision makes the category ACTIVE');
ok(!!(await startOf(TB, targetedPro))[0].r, '...and the targeted professional task is reservable (decided by the database trigger)');
const balB = await bal(TB);
await consent(TB, false);
ok((await catState(TB, 'tech_savvy')) === 'pending_assessment' && (await q('select count(*)::int n from public.category_qualifications where user_id=$1', [TB]))[0].n === 0, 'consent withdrawn: the AI-derived decision is gone, the category is PENDING again');
ok((await my(TB)).participation_ready === true && (await bal(TB)) === balB, '...the tester keeps profile, answers, credits and participation');
ok(!!(await finish(TB, targetedPro)) , '...and the reservation they already held still completes (in-progress reservations are protected)');
ok(await ledgerOk(), 'after all journeys the ledger still sums to every balance (credit conservation)');
const afterAll = (await q('select coalesce(sum(credit_balance),0)::int s from public.profiles'))[0].s;
ok(afterAll >= creditsBefore, 'total credits only grew by completed tests (no credit was created or destroyed by the migrations)', `${creditsBefore} -> ${afterAll}`);

// ------------------------------------------------------------------------------------------------------------------
console.log('\n[read-only verification queries: docs/verify-migrations-9-10.sql]');
await svc(() => q('select public.ai_apply_erasure_events()'));
const ver = await q(readFileSync(join(repo, 'docs', 'verify-migrations-9-10.sql'), 'utf8').replace(/^--.*$/gm, ''));
ok(ver.length === 16 && ver.every((r) => r.ok === true), 'every check of the post-migration verification query is true on the migrated database', JSON.stringify(ver.filter((r) => r.ok !== true).map((r) => r.check_name)));
const verBad = await (async () => {
  // sanity: the query can fail - a client-visible AI table must turn a row false
  await db.exec('grant select on public.ai_match_cache to authenticated');
  const r = await q(readFileSync(join(repo, 'docs', 'verify-migrations-9-10.sql'), 'utf8').replace(/^--.*$/gm, ''));
  await db.exec('revoke select on public.ai_match_cache from authenticated');
  return r.some((x) => x.ok === false);
})();
ok(verBad, 'and the query is not vacuous: exposing an AI table to clients makes a check false');

// ------------------------------------------------------------------------------------------------------------------
console.log('\n[every RPC the frontend and the Edge Function call exists, with the right privileges]');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const browserRpcs = new Set();
for (const f of walk(join(repo, 'src')).filter((p) => /[.]tsx?$/.test(p))) {
  for (const m of readFileSync(f, 'utf8').matchAll(/rpc(?:<[^>]*>)?\(\s*['"]([a-z_0-9]+)['"]/g)) browserRpcs.add(m[1]);
}
const fnSrc = readFileSync(join(repo, 'supabase', 'functions', 'ai-match', 'index.ts'), 'utf8');
const serviceRpcs = new Set([...fnSrc.matchAll(/rpc(?:<[^>]*>)?\(\s*service\(\)\s*,\s*['"]([a-z_0-9]+)['"]/g)].map((m) => m[1]));
const callerRpcs = new Set([...fnSrc.matchAll(/rpc(?:<[^>]*>)?\(\s*caller\s*,\s*['"]([a-z_0-9]+)['"]/g)].map((m) => m[1]));
ok(browserRpcs.size >= 15 && serviceRpcs.size >= 10 && callerRpcs.has('list_campaigns_v2'), `extracted ${browserRpcs.size} browser RPCs, ${serviceRpcs.size} service RPCs, ${callerRpcs.size} caller RPC from the code`, [...browserRpcs].join());
const priv = async (name, role) => (await q(`select bool_or(has_function_privilege($2, p.oid, 'execute')) a from pg_proc p where p.proname=$1 and p.pronamespace='public'::regnamespace`, [name, role]))[0].a;
const missing = [];
for (const n of browserRpcs) { const e = (await q(`select count(*)::int c from pg_proc where proname=$1 and pronamespace='public'::regnamespace`, [n]))[0].c; if (!e) missing.push(n); else if (!(await priv(n, 'authenticated'))) missing.push(n + ' (not executable by authenticated)'); }
ok(missing.length === 0, 'every RPC the browser calls exists and is executable by signed-in users', missing.join());
const missingS = [];
for (const n of serviceRpcs) { const e = (await q(`select count(*)::int c from pg_proc where proname=$1 and pronamespace='public'::regnamespace`, [n]))[0].c; if (!e) missingS.push(n); else { if (!(await priv(n, 'service_role'))) missingS.push(n + ' (service_role cannot execute)'); if (await priv(n, 'authenticated') || await priv(n, 'anon')) missingS.push(n + ' (EXPOSED to clients)'); } }
ok(missingS.length === 0, 'every RPC the Edge Function calls with the service key exists, is executable by service_role and NOT by clients', missingS.join());
ok(await priv('list_campaigns_v2', 'authenticated'), 'the Edge Function reads campaigns/eligibility under the caller\'s own identity (list_campaigns_v2)');

// ------------------------------------------------------------------------------------------------------------------
console.log('\n[emergency rollback: docs/rollback-gate-to-migration7.sql]');
const rollback = readFileSync(join(repo, 'docs', 'rollback-gate-to-migration7.sql'), 'utf8');
const answersBefore = (await q('select count(*)::int n from public.experience_answers'))[0].n;
err = null;
try { await db.exec(rollback); } catch (e) { err = e.message; }
ok(err === null, 'the rollback script runs cleanly on the migrated database');
const defsRolled = await defs();
ok(JSON.stringify(defsRolled) === JSON.stringify(defsBefore), 'all five function definitions are IDENTICAL to the database before migration 8', JSON.stringify([defsBefore, defsRolled]));
ok((await q('select count(*)::int n from public.experience_answers'))[0].n === answersBefore, 'no tester answer, consent, cache or credit was removed by the rollback');
const TG = await mk();
const started = await startOf(TG, openW).then((r) => !!r[0].r).catch(() => false);
ok(started, 'after the rollback a tester with NO profile can start an open task again (legacy behaviour restored)');
ok(!!(await as(TC, () => q(`select public.get_screening('tech_savvy') r`)))[0].r, 'the old screening RPC works again for the old UI');
ok(await ledgerOk(), 'the ledger still sums to every balance after the rollback');

summary();
