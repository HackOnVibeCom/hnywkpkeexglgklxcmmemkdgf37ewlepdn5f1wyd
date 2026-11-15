// AI matching storage layer (migration 20261115000500): per-user caches of AI-DERIVED data, erase RPCs, usage caps,
// privileges and user isolation. Real Postgres (PGlite) + the real migration files.
// Consent and the free-text answers belong to the profile workstream (service_get_ai_profile) and are NOT tested here;
// the OpenAI call itself is NOT here either (see tests/unit/ai-engine.test.mjs, which mocks the model).

import { readdirSync } from 'node:fs';
import { createHarness, uid } from './harness.mjs';

const h = await createHarness({ quiet: true });
const { db, as, q, ok, failsWith, counts } = h;

// The harness only grants schema usage to anon/authenticated; real Supabase also grants it to service_role.
await db.exec('grant usage on schema public to service_role');
async function svc(fn) {
  await db.exec('set role service_role');
  try { return await fn(); } finally { await db.exec('reset role'); }
}

const TASK = 'Find the pricing page and tell me which plan you would pick.';
let nextId = 1;
async function mk() {
  const id = uid(nextId++);
  await db.query('insert into auth.users (id) values ($1)', [id]);
  await as(id, () => q('select * from public.ensure_profile()'));
  return id;
}
const profile = (u, cats, bio = 'I like small tools', nick = 'Tester') => as(u, () => q('select * from public.save_tester_profile($1,$2,$3)', [nick, bio, cats]));
const cache = (u) => svc(() => q('select public.ai_get_cache($1) r', [u])).then((r) => r[0].r);
const putAn = (u, hash, an = { x: 1 }, model = 'm') => svc(() => q('select public.ai_put_analysis($1,$2,$3::jsonb,$4)', [u, hash, JSON.stringify(an), model]));
const putMatches = (u, arr) => svc(() => q('select public.ai_put_matches($1,$2::jsonb) n', [u, JSON.stringify(arr)])).then((r) => r[0].n);
const purge = (u) => svc(() => q('select public.ai_purge_user($1)', [u]));
const delMine = (u) => as(u, () => q('select public.delete_my_ai_data() r')).then((r) => r[0].r);
const reserve = (u, calls = 1, uCap = 10, gCap = 100, tCap = 1_000_000, gap = 0) =>
  svc(() => q('select public.ai_reserve_run($1,$2,$3,$4,$5,$6) r', [u, calls, uCap, gCap, tCap, gap])).then((r) => r[0].r);
const H = (c) => c.repeat(64).slice(0, 64);
const createV2 = async (owner, mode, cats, name = 'AI task') => (await as(owner, () => q('select public.create_campaign_v2($1,$2,$3,$4,$5,$6) id', [name, 'https://example.com', 'd', TASK, mode, cats])))[0].id;

const A = await mk();
const B = await mk();
await profile(A, ['tech_savvy', 'students_learners'], 'CS student, I build web apps');
await profile(B, ['everyday_nontechnical']);

console.log('\n[privileges: nothing here is a back door]');
for (const call of ['select public.delete_my_ai_data()']) {
  ok(await failsWith(() => as(null, () => q(call)), 'permission denied'), `anon denied: ${call}`);
}
const SERVICE = [
  `select public.ai_get_cache('${A}')`, `select public.ai_put_analysis('${A}','${H('a')}','{}','m')`, `select public.ai_put_matches('${A}','[]')`,
  `select public.ai_purge_user('${A}')`, `select public.ai_reserve_run('${A}',1,10,100,1000000,0)`, `select public.ai_record_tokens('${A}',1,1)`,
];
for (const call of SERVICE) {
  ok(await failsWith(() => as(A, () => q(call)), 'permission denied'), `authenticated cannot call service RPC: ${call.slice(0, 48)}`);
  ok(await failsWith(() => as(null, () => q(call)), 'permission denied'), `anon cannot call service RPC: ${call.slice(0, 48)}`);
}
for (const sig of ['public.ai_get_cache(uuid)', 'public.ai_put_analysis(uuid,text,jsonb,text)', 'public.ai_put_matches(uuid,jsonb)', 'public.ai_purge_user(uuid)', 'public.ai_reserve_run(uuid,integer,integer,integer,bigint,integer)', 'public.ai_record_tokens(uuid,bigint,bigint)']) {
  const r = (await q(`select has_function_privilege('anon','${sig}','execute') a, has_function_privilege('authenticated','${sig}','execute') u, has_function_privilege('public','${sig}','execute') p, has_function_privilege('service_role','${sig}','execute') s`))[0];
  ok(!r.a && !r.u && !r.p && r.s, `${sig}: EXECUTE only for service_role (catalog check)`);
}
for (const t of ['ai_profile_analyses', 'ai_match_cache', 'ai_usage', 'ai_usage_global']) {
  ok(await failsWith(() => as(A, () => q(`select * from public.${t}`)), 'permission denied'), `authenticated cannot read ${t}`);
  ok(await failsWith(() => as(A, () => q(`delete from public.${t}`)), 'permission denied'), `authenticated cannot delete from ${t}`);
  ok(await failsWith(() => as(A, () => q(`insert into public.${t} select * from public.${t} limit 0`)), 'permission denied'), `authenticated cannot insert into ${t}`);
  ok((await q(`select relrowsecurity r from pg_class where oid='public.${t}'::regclass`))[0].r === true, `RLS is on for ${t}`);
}
ok((await q(`select count(*)::int n from information_schema.tables where table_schema='public' and table_name in ('tester_ai_consent','tester_experience_answers')`))[0].n === 0,
  'this migration creates NO consent table and NO answers table (those belong to the profile workstream: no duplicate storage)');

console.log('\n[caches: per-user, hash-keyed]');
await putAn(A, H('a'), { summary: 'A analysis' }, 'gpt-x');
ok((await cache(A)).analysis.input_hash === H('a'), 'analysis stored');
await putAn(A, H('b'), { summary: 'A analysis v2' }, 'gpt-x');
ok((await cache(A)).analysis.input_hash === H('b') && (await q('select count(*)::int n from public.ai_profile_analyses where user_id=$1', [A]))[0].n === 1, 'a changed profile replaces the single analysis row');
ok((await cache(B)).analysis === null && (await cache(B)).matches.length === 0, "B's cache is empty and never shows A's data");
ok(await failsWith(() => putAn(null, H('c')), 'invalid_arguments'), 'null user rejected');

const C1 = await createV2(await mk(), 'open', []);
const C2 = await createV2(await mk(), 'targeted', ['tech_savvy']);
const GHOST = '00000000-0000-0000-0000-00000000dead';
const n = await putMatches(A, [
  { campaign_id: C1, profile_hash: H('a'), campaign_hash: H('1'), result: { verdict: 'good' } },
  { campaign_id: C2, profile_hash: H('a'), campaign_hash: H('2'), result: { verdict: 'none' } },
  { campaign_id: GHOST, profile_hash: H('a'), campaign_hash: H('3'), result: { verdict: 'strong' } },
]);
ok(n === 2, 'verdicts for campaigns that do not exist are skipped, others stored');
ok((await cache(A)).matches.length === 2 && (await cache(B)).matches.length === 0, 'verdicts are per user');
await putMatches(A, [{ campaign_id: C1, profile_hash: H('b'), campaign_hash: H('1'), result: { verdict: 'strong' } }]);
const m1 = (await cache(A)).matches.find((m) => m.campaign_id === C1);
ok(m1.profile_hash === H('b') && m1.result.verdict === 'strong' && (await cache(A)).matches.length === 2, 'upsert replaces the verdict for the same campaign');
ok(await failsWith(() => putMatches(A, Array.from({ length: 101 }, () => ({ campaign_id: C1, profile_hash: H('a'), campaign_hash: H('1'), result: {} }))), 'too_many_matches'), 'batch bounded at 100');
ok(await failsWith(() => putMatches(A, { not: 'an array' }), 'invalid_arguments'), 'non-array payload rejected');
ok(await failsWith(() => putMatches(A, [{ campaign_id: C1, profile_hash: 'short', campaign_hash: H('1'), result: {} }]), 'violates check constraint'), 'malformed hash rejected by the table constraint');

console.log('\n[erasure: what the AI derived about me can be deleted]');
await putAn(B, H('d'), { summary: 'B analysis' });
await putMatches(B, [{ campaign_id: C1, profile_hash: H('d'), campaign_hash: H('1'), result: { verdict: 'good' } }]);
const del = await delMine(A);
ok(del.deleted_analyses === 1 && del.deleted_verdicts === 2, 'delete_my_ai_data removes MY analysis and verdicts and reports the counts');
ok((await cache(A)).analysis === null && (await cache(A)).matches.length === 0, 'A has nothing left');
ok((await cache(B)).analysis !== null && (await cache(B)).matches.length === 1, "and B's data is untouched (a user can only erase their own)");
ok((await delMine(A)).deleted_analyses === 0, 'deleting twice is harmless');
await purge(B);
ok((await cache(B)).analysis === null && (await cache(B)).matches.length === 0, 'ai_purge_user (used by the Edge Function when consent is not granted) erases the same data');
await putAn(A, H('e'));
await q('delete from public.profiles where id=$1', [A]).catch(() => undefined);
ok((await q('select count(*)::int n from public.ai_profile_analyses where user_id=$1', [A]))[0].n === 0, 'deleting the profile row cascades to the AI caches');

console.log('\n[cost control: atomic reservation of a run]');
const R = await mk();
ok(await reserve(R, 2, 5, 100, 1e6, 0) === 'ok', 'first run admitted');
ok(await reserve(R, 2, 5, 100, 1e6, 0) === 'ok', 'second run admitted (4/5 calls)');
ok(await reserve(R, 2, 5, 100, 1e6, 0) === 'user_daily_cap', 'a run that would exceed the per-user daily call cap is refused');
ok(await reserve(R, 1, 5, 100, 1e6, 0) === 'ok', 'but a smaller run that still fits is admitted (5/5)');
ok(await reserve(R, 1, 5, 100, 1e6, 0) === 'user_daily_cap', 'cap reached');
const R2 = await mk();
ok(await reserve(R2, 1, 5, 100, 1e6, 0) === 'ok', "another identity is not affected by R's cap");
ok(await reserve(R2, 1, 5, 100, 1e6, 30) === 'too_fast', 'a second run inside the minimum interval is refused');
ok((await q('select openai_calls c, runs r from public.ai_usage where user_id=$1', [R2]))[0].c === 1, 'refused runs are not counted');
const R3 = await mk();
const g0 = (await q('select openai_calls c from public.ai_usage_global'))[0].c;
ok(await reserve(R3, 1, 5, g0 + 0, 1e6, 0) === 'global_cap', 'global daily call cap enforced');
ok(await reserve(R3, 1, 5, g0 + 1, 1e6, 0) === 'ok', 'global cap allows up to its limit');
await svc(() => q('select public.ai_record_tokens($1, 900, 200)', [R3]));
ok(await reserve(R3, 1, 50, 1000, 1000, 0) === 'global_cap', 'global token budget enforced (1100 >= 1000)');
const u = (await q('select input_tokens i, output_tokens o from public.ai_usage where user_id=$1', [R3]))[0];
const gl = (await q('select input_tokens i, output_tokens o from public.ai_usage_global'))[0];
ok(Number(u.i) === 900, 'per-user token counters recorded');
ok(Number(gl.i) === 900 && Number(gl.o) === 200, 'global token counters recorded');
for (const bad of [[0, 5, 5, 5, 0], [5, 5, 5, 5, 0], [1, null, 5, 5, 0], [1, 5, 5, 5, -1]]) {
  ok(await failsWith(() => svc(() => q('select public.ai_reserve_run($1,$2,$3,$4,$5,$6)', [R3, bad[0], bad[1], bad[2], bad[3], bad[4]])), 'invalid_arguments'), `invalid reserve arguments rejected: ${JSON.stringify(bad)}`);
}
ok(await failsWith(() => svc(() => q('select public.ai_record_tokens($1,-1,0)', [R3])), 'invalid_arguments'), 'negative token counts rejected');

console.log('\n[existing protections intact: the AI tables never grant access]');
{
  const T = await mk();
  const O = await mk();
  await profile(T, ['tech_savvy'], 'Backend dev with 8 years of experience');
  await putAn(T, H('f'), { summary: 'very experienced' });
  const tc = await createV2(O, 'targeted', ['tech_savvy'], 'Targeted pro');
  const e = (await as(T, () => q('select public.get_campaign_eligibility($1) r', [tc])))[0].r;
  ok(e.eligible === false && e.reason === 'screening_required', 'a rich profile and a cached analysis do NOT make an unscreened tester eligible');
  ok(await failsWith(() => as(T, () => q('select public.start_test($1)', [tc])), 'not_eligible'), 'reserving the targeted campaign is still refused server-side');
  const feed = await as(T, () => q('select campaign_id, eligible, fit from public.list_campaigns_v2()'));
  ok(feed.find((f) => f.campaign_id === tc)?.eligible === false && feed.find((f) => f.campaign_id === tc)?.fit === 'not_eligible', 'the Discover feed still flags it not_eligible (this is what the AI function filters on)');
}

console.log('\n[additive only: nothing that existed before is altered, and no dependency on unmerged work]');
{
  const files = readdirSync(new URL('../migrations', import.meta.url)).filter((f) => f.endsWith('.sql') && !f.includes('ai_matching') && !f.includes('active_categories') && !f.includes('experience_profile'));
  const baseline = await createHarness({ quiet: true, migrations: files });
  const defs = (x) => x.q("select p.oid::regprocedure::text sig, md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1");
  const cols = (x) => x.q("select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2");
  const pol = (x) => x.q("select tablename, policyname, cmd, qual from pg_policies where schemaname='public' order by 1,2");
  const before = await defs(baseline);
  const afterMap = new Map((await defs(h)).map((r) => [r.sig, r.h]));
  ok(before.length > 20 && before.every((r) => afterMap.get(r.sig) === r.h), `all ${before.length} pre-existing public functions are byte-identical after the AI migration`);
  const cb = await cols(baseline);
  const ca = new Set((await cols(h)).map((r) => JSON.stringify(r)));
  ok(cb.length > 50 && cb.every((r) => ca.has(JSON.stringify(r))), `all ${cb.length} pre-existing columns are unchanged`);
  ok(JSON.stringify(await pol(baseline)) === JSON.stringify(await pol(h)), 'no RLS policy was added, changed or removed');
}

const c = counts();
console.log(`\n${c.passed} passed, ${c.failed} failed`);
process.exit(c.failed ? 1 : 0);
