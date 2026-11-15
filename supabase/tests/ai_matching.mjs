// AI layer (migration 20261115000500) running TOGETHER WITH the profile/qualification migration (20261115000300): caches of
// AI-DERIVED data bound to subject_ref, the erasure-event mechanism, immediate user erasure, per-kind usage caps, privileges,
// user isolation - and the end-to-end professional-assessment flow through the contract's real service functions
// (service_get_ai_profile -> service_record_qualification), the consent-withdrawal policy, and credit/reservation regressions.
// Real Postgres (PGlite) + the REAL migration files; the contract JSON fed to the TypeScript adapter is the database's own output.
// The OpenAI call itself is NOT here (tests/unit/ai-engine.test.mjs and ai-assess.test.mjs mock the model).

import { readdirSync } from 'node:fs';
import { createHarness, uid } from './harness.mjs';
import { mapAssessmentInput, mapContractProfile } from '../functions/_shared/aiMatching/contract.ts';

const h = await createHarness({ quiet: true });
const { db, as, q, ok, failsWith, counts } = h;

async function svc(fn) {
  await db.exec('set role service_role');
  try { return await fn(); } finally { await db.exec('reset role'); }
}

const TASK = 'Find the pricing page and tell me which plan you would pick.';
const FB = { friction: 'The pricing link was hidden in the footer.', suggestion: 'Add a pricing link to the top nav.' };
const H = (c) => c.repeat(64).slice(0, 64);
const ANS = (tag = 'x') => ({
  q1: `I use ${tag} tools almost every single day`,
  q2: `A small project where I built ${tag} things myself`,
  q3: `Something broke once so I read the ${tag} logs carefully`,
  q4: `Products related to ${tag} are the ones I enjoy testing`,
});

let nextId = 1;
async function mk() {
  const id = uid(nextId++);
  await db.query('insert into auth.users (id) values ($1)', [id]);
  await as(id, () => q('select * from public.ensure_profile()'));
  return id;
}
const profile = (u, cats, bio = 'I like testing things', nick = 'Tester') => as(u, () => q('select * from public.save_tester_profile($1,$2,$3)', [nick, bio, cats]));
const save = (u, cat, a) => as(u, () => q('select public.save_experience_answers($1,$2::jsonb) r', [cat, JSON.stringify(a)])).then((r) => r[0].r);
const consent = (u, g) => as(u, () => q('select public.set_ai_consent($1) r', [g])).then((r) => r[0].r);
const delExp = (u, c) => as(u, () => q('select public.delete_my_experience($1) r', [c ?? null])).then((r) => r[0].r);
const my = async (u) => (await as(u, () => q('select public.get_my_experience() r')))[0].r;
const state = async (u, c) => (await my(u)).categories.find((x) => x.category === c).state;
const aiProfile = (u) => svc(() => q('select public.service_get_ai_profile($1) r', [u])).then((r) => r[0].r);
const subjectOf = async (u) => (await aiProfile(u)).subject_ref;
const decide = (u, c, status, over = {}) => svc(async () => {
  const p = (await q('select public.service_get_ai_profile($1) r', [u]))[0].r.categories.find((x) => x.category === c);
  const a = { version: p.question_version, hash: p.answers_hash, assessment: { model: 'm', rubric_version: 'r1', summary: 'Self-reported answers judged to show hands-on experience (rubric r1).', confidence: 0.85 }, ...over };
  return (await q('select public.service_record_qualification($1,$2,$3,$4,$5,$6::jsonb) r', [u, c, a.version, a.hash, status, a.assessment ? JSON.stringify(a.assessment) : null]))[0].r;
});
const cache = (u, s) => svc(() => q('select public.ai_get_cache($1,$2) r', [u, s])).then((r) => r[0].r);
const putAn = (u, s, hash, an = { x: 1 }, model = 'm') => svc(() => q('select public.ai_put_analysis($1,$2,$3,$4::jsonb,$5)', [u, s, hash, JSON.stringify(an), model]));
const putMatches = (u, s, arr) => svc(() => q('select public.ai_put_matches($1,$2,$3::jsonb) n', [u, s, JSON.stringify(arr)])).then((r) => r[0].n);
const notes = (u, s) => svc(() => q('select public.ai_get_assessment_notes($1,$2) r', [u, s])).then((r) => r[0].r);
const putNote = (u, s, cat, hash, payload = { clarification_questions: ['What did you do yourself?'] }) => svc(() => q('select public.ai_put_assessment_note($1,$2,$3,$4,$5::jsonb,$6)', [u, s, cat, hash, JSON.stringify(payload), 'm']));
const purge = (u) => svc(() => q('select public.ai_purge_user($1)', [u]));
const sweep = () => svc(() => q('select public.ai_apply_erasure_events() n')).then((r) => r[0].n);
const delMine = (u) => as(u, () => q('select public.delete_my_ai_data() r')).then((r) => r[0].r);
const reserve = (u, kind = 'match', calls = 1, uCap = 10, gCap = 100, tCap = 1_000_000, gap = 0) =>
  svc(() => q('select public.ai_reserve_run($1,$2,$3,$4,$5,$6,$7) r', [u, kind, calls, uCap, gCap, tCap, gap])).then((r) => r[0].r);
const createV2 = async (owner, mode, cats, name = 'AI task') => (await as(owner, () => q('select public.create_campaign_v2($1,$2,$3,$4,$5,$6) id', [name, 'https://example.com', 'd', TASK, mode, cats])))[0].id;
const feed = (u) => as(u, () => q('select * from public.list_campaigns_v2()'));
const bal = async (u) => (await as(u, () => q('select credit_balance from public.profiles')))[0].credit_balance;
/** Everything the AI layer holds for this subject_ref, across the three derived-data tables. */
const heldFor = async (s) => {
  const a = (await q('select count(*)::int n from public.ai_profile_analyses where subject_ref=$1', [s]))[0].n;
  const m = (await q('select count(*)::int n from public.ai_match_cache where subject_ref=$1', [s]))[0].n;
  const t = (await q('select count(*)::int n from public.ai_assessment_notes where subject_ref=$1', [s]))[0].n;
  return a + m + t;
};
/** A consented tester with derived data stored under their CURRENT subject_ref. */
async function withDerived(cats = ['students_learners']) {
  const u = await mk();
  await profile(u, cats);
  for (const c of cats) await save(u, c, ANS(c));
  await consent(u, true);
  const s = await subjectOf(u);
  const camp = await createV2(await mk(), 'open', []);
  await putAn(u, s, H('a'));
  await putMatches(u, s, [{ campaign_id: camp, profile_hash: H('a'), campaign_hash: H('1'), result: { verdict: 'good' } }]);
  return { u, s, camp };
}

console.log('\n[privileges: nothing here is a back door]');
{
  const A = await mk();
  const SERVICE = [
    `select public.ai_get_cache('${A}','${A}')`, `select public.ai_put_analysis('${A}','${A}','${H('a')}','{}','m')`, `select public.ai_put_matches('${A}','${A}','[]')`,
    `select public.ai_get_assessment_notes('${A}','${A}')`, `select public.ai_put_assessment_note('${A}','${A}','tech_savvy','${H('a')}','{}','m')`,
    `select public.ai_purge_user('${A}')`, `select public.ai_apply_erasure_events(10)`, `select public.ai_reserve_run('${A}','match',1,10,100,1000000,0)`, `select public.ai_record_tokens('${A}','match',1,1)`,
  ];
  for (const call of SERVICE) {
    ok(await failsWith(() => as(A, () => q(call)), 'permission denied'), `authenticated cannot call service RPC: ${call.slice(0, 46)}`);
    ok(await failsWith(() => as(null, () => q(call)), 'permission denied'), `anon cannot call service RPC: ${call.slice(0, 46)}`);
  }
  ok(await failsWith(() => as(null, () => q('select public.delete_my_ai_data()')), 'permission denied'), 'anon cannot call delete_my_ai_data');
  for (const sig of ['public.ai_get_cache(uuid,uuid)', 'public.ai_put_analysis(uuid,uuid,text,jsonb,text)', 'public.ai_put_matches(uuid,uuid,jsonb)', 'public.ai_get_assessment_notes(uuid,uuid)', 'public.ai_put_assessment_note(uuid,uuid,text,text,jsonb,text)', 'public.ai_purge_user(uuid)', 'public.ai_apply_erasure_events(integer)', 'public.ai_reserve_run(uuid,text,integer,integer,integer,bigint,integer)', 'public.ai_record_tokens(uuid,text,bigint,bigint)']) {
    const r = (await q(`select has_function_privilege('anon','${sig}','execute') a, has_function_privilege('authenticated','${sig}','execute') u, has_function_privilege('public','${sig}','execute') p, has_function_privilege('service_role','${sig}','execute') s`))[0];
    ok(!r.a && !r.u && !r.p && r.s, `${sig}: EXECUTE only for service_role (catalog check)`);
  }
  for (const t of ['ai_profile_analyses', 'ai_match_cache', 'ai_assessment_notes', 'ai_usage', 'ai_usage_global', 'ai_erasure_cursor']) {
    ok(await failsWith(() => as(A, () => q(`select * from public.${t}`)), 'permission denied'), `authenticated cannot read ${t}`);
    ok(await failsWith(() => as(A, () => q(`delete from public.${t}`)), 'permission denied'), `authenticated cannot delete from ${t}`);
    ok((await q(`select relrowsecurity r from pg_class where oid='public.${t}'::regclass`))[0].r === true, `RLS is on for ${t}`);
  }
  ok((await q(`select count(*)::int n from information_schema.tables where table_schema='public' and table_name in ('tester_ai_consent','tester_experience_answers')`))[0].n === 0,
    'this migration creates NO consent table and NO answers table (those belong to the profile workstream: no duplicate storage)');
  ok(await failsWith(() => as(A, () => q(`select public.service_record_qualification('${A}','tech_savvy',1,'${H('a')}','qualified',null)`)), 'permission denied'), 'the browser role cannot call service_record_qualification (it cannot forge a qualification)');
  ok(await failsWith(() => as(A, () => q(`insert into public.category_qualifications (user_id, category, status, source, question_version, answers_hash) values ('${A}','tech_savvy','qualified','ai_assessment',1,'${H('a')}')`)), 'permission denied'), 'nor write category_qualifications directly');
}

console.log('\n[caches are bound to the CURRENT subject_ref]');
{
  const { u, s, camp } = await withDerived();
  ok((await cache(u, s)).analysis.input_hash === H('a') && (await cache(u, s)).matches.length === 1, 'derived data is served under the subject_ref it was written under');
  ok((await cache(u, '00000000-0000-4000-8000-00000000beef')).analysis === null && (await cache(u, '00000000-0000-4000-8000-00000000beef')).matches.length === 0, 'and never under another subject_ref');
  ok(await failsWith(() => putAn(u, null, H('b')), 'invalid_arguments') && await failsWith(() => putMatches(u, null, []), 'invalid_arguments'), 'writes require a subject_ref');
  const GHOST = '00000000-0000-0000-0000-00000000dead';
  ok(await putMatches(u, s, [{ campaign_id: camp, profile_hash: H('b'), campaign_hash: H('1'), result: { verdict: 'strong' } }, { campaign_id: GHOST, profile_hash: H('b'), campaign_hash: H('2'), result: {} }]) === 1, 'verdicts for campaigns that no longer exist are skipped');
  ok(await failsWith(() => putMatches(u, s, Array.from({ length: 101 }, () => ({ campaign_id: camp, profile_hash: H('a'), campaign_hash: H('1'), result: {} }))), 'too_many_matches'), 'batch bounded at 100');
  ok(await failsWith(() => putMatches(u, s, [{ campaign_id: camp, profile_hash: 'short', campaign_hash: H('1'), result: {} }]), 'violates check constraint'), 'malformed hash rejected by the table constraint');
  // consent withdrawn then granted again => the contract rotates subject_ref => old rows are dead
  await consent(u, false);
  await consent(u, true);
  const s2 = await subjectOf(u);
  ok(s2 !== s, 're-consent issues a NEW subject_ref (contract behaviour)');
  ok((await cache(u, s2)).analysis === null && (await cache(u, s2)).matches.length === 0, 'rows derived under the OLD subject_ref are not served under the new one');
  await sweep();
  ok((await heldFor(s)) === 0, 'and the erasure sweep removed them');
}

console.log('\n[erasure events: every withdrawal path erases what the AI holds]');
{
  ok((await q('select last_id from public.ai_erasure_cursor'))[0].last_id !== undefined, 'the erasure cursor exists');
  // consent withdrawn
  const a = await withDerived();
  await putNote(a.u, a.s, 'tech_savvy', H('c'));
  ok((await heldFor(a.s)) === 3, 'precondition: analysis, verdict and clarification note are held');
  await consent(a.u, false);
  const n1 = await sweep();
  ok(n1 >= 1 && (await heldFor(a.s)) === 0, 'consent_withdrawn: the sweep erases analysis, verdicts and notes for that subject_ref');
  ok((await sweep()) === 0, 'a second sweep finds nothing new (cursor advanced after the delete)');
  // other tester untouched
  const b = await withDerived();
  const c = await withDerived();
  await consent(c.u, false);
  await sweep();
  ok((await heldFor(b.s)) === 3 - 1 && (await heldFor(c.s)) === 0, "withdrawing consent erases ONLY that tester's data (the other tester keeps theirs)");
  // answers deleted (one category and all)
  const d = await withDerived(['students_learners', 'everyday_nontechnical']);
  await delExp(d.u, 'everyday_nontechnical');
  await sweep();
  ok((await heldFor(d.s)) === 0, 'answers_deleted (one category): everything derived from the answers is erased');
  const e = await withDerived();
  await delExp(e.u, null);
  await sweep();
  ok((await heldFor(e.s)) === 0, 'answers_deleted (all): erased');
  // tester profile removed
  const f = await withDerived();
  await as(f.u, () => q('select public.delete_my_tester_profile()'));
  await sweep();
  ok((await heldFor(f.s)) === 0, 'profile_removed: erased');
  // account deleted: the FK cascade removes the rows; the event still processes without error
  const g = await withDerived();
  await db.query('delete from auth.users where id=$1', [g.u]);
  ok((await heldFor(g.s)) === 0, 'account_deleted: the cascade removes everything immediately');
  ok((await sweep()) >= 1, 'and its erasure event is processed without error');
  // cursor is persisted and only moves forward
  const last = (await q('select last_id from public.ai_erasure_cursor'))[0].last_id;
  const maxEv = (await q('select max(id) m from public.ai_erasure_events'))[0].m;
  ok(Number(last) === Number(maxEv), 'the cursor sits on the last processed event');
  // immediate user erasure
  const i = await withDerived();
  await putNote(i.u, i.s, 'tech_savvy', H('c'));
  const other = await withDerived();
  const del = await delMine(i.u);
  ok(del.deleted_analyses === 1 && del.deleted_verdicts === 1 && del.deleted_notes === 1 && (await heldFor(i.s)) === 0, 'delete_my_ai_data erases MY analysis, verdicts and notes immediately and reports counts');
  ok((await heldFor(other.s)) === 3 - 1, "and cannot touch anyone else's data");
  ok((await delMine(i.u)).deleted_analyses === 0, 'deleting twice is harmless');
  await purge(other.u);
  ok((await heldFor(other.s)) === 0, 'ai_purge_user (used when the function sees no consent) erases the same data');
  // delete_my_ai_data never touches decisions
  const j = await mk();
  await profile(j, ['tech_savvy']);
  await save(j, 'tech_savvy', ANS('tech'));
  await consent(j, true);
  await decide(j, 'tech_savvy', 'qualified');
  await delMine(j);
  ok((await state(j, 'tech_savvy')) === 'active', 'delete_my_ai_data does not touch qualification decisions');
}

console.log('\n[review hardening: no writes after withdrawal, reconciliation, events behind the cursor]');
{
  const FAKE = '00000000-0000-4000-8000-0000000000aa';
  // 1. derived data is never stored for a consent that is gone / re-issued while the model was still thinking
  const a = await withDerived();
  await consent(a.u, false);
  await sweep();
  await putAn(a.u, a.s, H('n'));
  await putMatches(a.u, a.s, [{ campaign_id: a.camp, profile_hash: H('n'), campaign_hash: H('1'), result: { verdict: 'good' } }]);
  await putNote(a.u, a.s, 'tech_savvy', H('n'));
  ok((await heldFor(a.s)) === 0, 'a run that finishes AFTER consent was withdrawn stores nothing (analysis, verdicts and notes are all no-ops)');
  await consent(a.u, true);
  await putAn(a.u, a.s, H('o'));
  ok((await heldFor(a.s)) === 0, 'and a write under the OLD subject_ref after re-consent (new subject_ref) is a no-op too');
  const s2 = await subjectOf(a.u);
  await putAn(a.u, s2, H('p'));
  ok((await heldFor(s2)) === 1, 'while a write under the CURRENT subject_ref works');
  // 2. reconciliation removes rows without an active consent, independent of any event
  const orphanUser = await mk();
  await q(`insert into public.ai_profile_analyses (user_id, subject_ref, input_hash, analysis, model) values ($1, $2, $3, '{}', 'm')`, [orphanUser, FAKE, H('z')]);
  ok((await heldFor(FAKE)) === 1, 'precondition: an orphan row exists (no consent row for it)');
  await q('update public.ai_erasure_cursor set last_reconciled_at = null');
  await sweep();
  ok((await heldFor(FAKE)) === 0, 'the reconciliation in the sweep deletes it');
  ok((await heldFor(s2)) === 1, 'and keeps rows that DO have an active consent for their subject_ref');
  // 3. an event that committed BEHIND the cursor (identity ids are not commit-ordered) is still erased
  const b = await withDerived();
  await consent(b.u, false);
  const maxEv = (await q('select max(id) m from public.ai_erasure_events'))[0].m;
  await q('update public.ai_erasure_cursor set last_id = $1, last_reconciled_at = null', [Number(maxEv) + 5]);
  ok((await heldFor(b.s)) === 2, 'precondition: the withdrawn tester still has derived data and the cursor is already PAST their event');
  await sweep();
  ok((await heldFor(b.s)) === 0, 'the reconciliation erases it anyway: a lost/late event cannot leave data behind');
  // restore the cursor to the real last event so later sections see normal event processing
  await q('update public.ai_erasure_cursor set last_id = coalesce((select max(id) from public.ai_erasure_events), 0), last_reconciled_at = null');
  // 4. no hot-row write when nothing happened
  await sweep();
  const t1 = (await q('select last_reconciled_at t, last_id i from public.ai_erasure_cursor'))[0];
  await sweep();
  const t2 = (await q('select last_reconciled_at t, last_id i from public.ai_erasure_cursor'))[0];
  ok(String(t1.t) === String(t2.t) && t1.i === t2.i, 'a sweep with nothing to do within the reconciliation interval does not write the cursor row');
}

console.log('\n[assessment notes]');
{
  const { u, s } = await withDerived(['tech_savvy']);
  await putNote(u, s, 'tech_savvy', H('c'));
  await putNote(u, s, 'tech_savvy', H('d'), { clarification_questions: ['Which tools did you use?'] });
  const n = await notes(u, s);
  ok(n.length === 1 && n[0].answers_hash === H('d') && n[0].outcome === 'needs_clarification', 'one note per (user, category); a new answers_hash replaces it');
  ok((await notes(u, '00000000-0000-4000-8000-00000000beef')).length === 0, 'notes are only served under the current subject_ref');
  ok(await failsWith(() => putNote(u, s, 'students_learners', H('c')), 'violates check constraint'), 'only the three professional categories can have notes (general categories are never assessed)');
  ok(await failsWith(() => (() => q(`insert into public.ai_assessment_notes (user_id, category, subject_ref, answers_hash, outcome, payload) values ($1,'tech_savvy',$2,$3,'qualified','{}')`, [u, s, H('e')]))(), 'violates check constraint'), 'a note can only ever say needs_clarification: a "qualified" outcome cannot be smuggled in here');
}

console.log('\n[cost control: atomic reservation of a run, throttle per kind]');
{
  const R = await mk();
  ok(await reserve(R, 'match', 2, 5, 100, 1e6, 0) === 'ok' && await reserve(R, 'match', 2, 5, 100, 1e6, 0) === 'ok', 'two runs admitted (4/5 calls)');
  ok(await reserve(R, 'match', 2, 5, 100, 1e6, 0) === 'user_daily_cap', 'a run that would exceed the per-user daily call cap is refused');
  ok(await reserve(R, 'assess', 2, 5, 100, 1e6, 0) === 'user_daily_cap', 'the per-user cap is shared by both kinds (4 used, 2 more would exceed 5)');
  ok(await reserve(R, 'assess', 1, 5, 100, 1e6, 0) === 'ok', 'but a smaller assessment run that still fits is admitted (5/5)');
  const R2 = await mk();
  ok(await reserve(R2, 'match', 1, 5, 100, 1e6, 30) === 'ok', 'first matching run admitted with a 30 s interval');
  ok(await reserve(R2, 'match', 1, 5, 100, 1e6, 30) === 'too_fast', 'a second MATCH run inside the interval is refused');
  ok(await reserve(R2, 'assess', 1, 5, 100, 1e6, 30) === 'ok', 'but an ASSESS run right after is admitted: the throttle is per kind');
  ok((await q(`select runs from public.ai_usage where user_id=$1 and kind='match'`, [R2]))[0].runs === 1, 'refused runs are not counted');
  const R3 = await mk();
  const g0 = (await q('select openai_calls c from public.ai_usage_global'))[0].c;
  ok(await reserve(R3, 'match', 1, 5, g0, 1e6, 0) === 'global_cap', 'global daily call cap enforced');
  ok(await reserve(R3, 'match', 1, 5, g0 + 1, 1e6, 0) === 'ok', 'global cap allows up to its limit');
  await svc(() => q(`select public.ai_record_tokens($1,'assess', 900, 200)`, [R3]));
  ok(await reserve(R3, 'match', 1, 50, 1000, 1000, 0) === 'global_cap', 'global token budget enforced (1100 >= 1000)');
  const gl = (await q('select input_tokens i, output_tokens o from public.ai_usage_global'))[0];
  ok(Number(gl.i) === 900 && Number(gl.o) === 200 && Number((await q(`select input_tokens i from public.ai_usage where user_id=$1 and kind='assess'`, [R3]))[0].i) === 900, 'token counters recorded per kind and globally');
  for (const bad of [[R3, 'other', 1, 5, 5, 5, 0], [R3, 'match', 0, 5, 5, 5, 0], [R3, 'match', 5, 5, 5, 5, 0], [R3, 'match', 1, null, 5, 5, 0], [R3, 'match', 1, 5, 5, 5, -1]]) {
    ok(await failsWith(() => svc(() => q('select public.ai_reserve_run($1,$2,$3,$4,$5,$6,$7)', bad)), 'invalid_arguments'), `invalid reserve arguments rejected: ${JSON.stringify(bad.slice(1))}`);
  }
  ok(await failsWith(() => svc(() => q(`select public.ai_record_tokens($1,'match',-1,0)`, [R3])), 'invalid_arguments') && await failsWith(() => svc(() => q(`select public.ai_record_tokens($1,'x',1,0)`, [R3])), 'invalid_arguments'), 'negative token counts and unknown kinds rejected');
}

console.log('\n[professional qualification end to end: contract -> adapter -> service_record_qualification]');
{
  const T = await mk();
  const O = await mk();
  await profile(T, ['tech_savvy', 'students_learners'], 'I tinker with computers');
  await save(T, 'tech_savvy', ANS('tech'));
  await save(T, 'students_learners', ANS('study'));
  const targeted = await createV2(O, 'targeted', ['tech_savvy'], 'Pro tool');
  ok((await state(T, 'tech_savvy')) === 'incomplete' || (await state(T, 'tech_savvy')) === 'pending_assessment', 'professional category is not active after saving answers');
  // without consent nothing is readable and nothing can be recorded
  const none = mapAssessmentInput(await aiProfile(T));
  ok(none.consent === false && none.targets.length === 0, 'without consent the adapter sees no assessment targets (the database withholds the answers)');
  ok(await failsWith(() => decide(T, 'tech_savvy', 'qualified'), 'consent_required'), 'and the database refuses to record a decision without consent');
  await consent(T, true);
  ok((await state(T, 'tech_savvy')) === 'pending_assessment', 'with consent the category waits for the assessment: pending_assessment');
  const pending = await svc(() => q('select * from public.service_list_pending_assessments(10)'));
  ok(pending.some((p) => p.user_id === T && p.category === 'tech_savvy'), 'it appears in the contract work queue');
  const raw = await aiProfile(T);
  const target = mapAssessmentInput(raw);
  ok(target.targets.length === 1 && target.targets[0].category === 'tech_savvy' && target.targets[0].answers.length === 4 && /^[0-9a-f]{64}$/.test(target.targets[0].answers_hash) && target.targets[0].question_version === 1, "the adapter maps the database's REAL contract output into exactly one assessment target with version + hash + four answers");
  ok(target.targets[0].answers[0].question === 'What technologies, tools or software do you have experience using?', 'including the exact question text');
  const m = mapContractProfile(raw);
  ok(m.consent && m.participation_ready && m.subject_ref === raw.subject_ref && m.etag === raw.etag, 'the matching adapter carries subject_ref, etag and participation_ready from the real contract');
  ok(m.answers.every((a) => a.category === 'students_learners') && m.answers.length === 4, 'real data: matching sees only the ACTIVE general category; the pending professional answers are excluded');
  // not eligible for the targeted campaign until a decision exists
  ok((await feed(T)).find((f) => f.campaign_id === targeted).eligible === false, 'the targeted professional campaign is NOT eligible while pending');
  // not_qualified is recorded: still not eligible, kind of final until answers change
  await decide(T, 'tech_savvy', 'not_qualified');
  ok((await state(T, 'tech_savvy')) === 'not_qualified' && (await feed(T)).find((f) => f.campaign_id === targeted).eligible === false, 'a not_qualified decision keeps the category inactive for targeting');
  ok(mapAssessmentInput(await aiProfile(T)).targets.length === 0, 'and it leaves the work queue');
  // qualified: becomes active and eligible; the stored decision carries no answer text
  await decide(T, 'tech_savvy', 'qualified');
  ok((await state(T, 'tech_savvy')) === 'active' && (await my(T)).active_categories.includes('tech_savvy'), 'a recorded qualified decision makes the category ACTIVE');
  ok((await feed(T)).find((f) => f.campaign_id === targeted).eligible === true, 'and the targeted campaign becomes reservable (decided by the database trigger, not the AI)');
  const row = (await q('select * from public.category_qualifications where user_id=$1 and category=$2', [T, 'tech_savvy']))[0];
  ok(row.source === 'ai_assessment' && !/tech tools|logs carefully/.test(JSON.stringify(row)), 'the stored decision has the contract source and contains no answer text');
  const r1 = await as(T, () => q('select public.start_test($1) r', [targeted]));
  ok(!!r1[0].r, 'the qualified tester can reserve the targeted campaign');
  // editing an answer invalidates the decision automatically
  await save(T, 'tech_savvy', ANS('changed'));
  ok((await state(T, 'tech_savvy')) === 'pending_assessment', 'editing an answer changes answers_hash: the decision stops counting and the category is pending again');
  ok(await failsWith(() => decide(T, 'tech_savvy', 'qualified', { hash: H('f') }), 'stale_assessment'), 'a late decision for the OLD answers is refused as stale');
  ok(await failsWith(() => decide(T, 'students_learners', 'qualified'), 'category_not_assessable'), 'general categories can never be assessed or qualified');
  ok((await state(T, 'students_learners')) === 'active', 'general-category participation needs no assessment: students_learners is active as soon as the answers are saved');
  ok(await failsWith(() => decide(T, 'tech_savvy', 'qualified', { assessment: { model: 'm', answers: 'my raw answer text' } }), 'invalid_assessment'), 'an assessment payload with any key other than model/rubric_version/summary/confidence (e.g. answer text) is refused');
}

console.log('\n[consent withdrawal removes AI-derived decisions, recommendations and cached analysis (migration 10)]');
{
  const T = await mk();
  const O = await mk();
  await profile(T, ['tech_savvy', 'founders_builders', 'students_learners'], 'I build things');
  await save(T, 'tech_savvy', ANS('tech'));
  await save(T, 'founders_builders', ANS('founder'));
  await save(T, 'students_learners', ANS('study'));
  await consent(T, true);
  const targeted = await createV2(O, 'targeted', ['tech_savvy'], 'Pro tool 2');
  const open = await createV2(await mk(), 'open', [], 'Open task');
  const s1 = await subjectOf(T);
  ok(await svc(() => q('select public.ai_consent_active($1,$2) r', [T, s1])).then((r) => r[0].r) === true, 'ai_consent_active: true for the current consent and subject_ref');
  ok(await svc(() => q('select public.ai_consent_active($1,$2) r', [T, '00000000-0000-4000-8000-000000000000'])).then((r) => r[0].r) === false, 'ai_consent_active: false for any other subject_ref');
  await decide(T, 'tech_savvy', 'qualified');
  await decide(T, 'founders_builders', 'not_qualified');
  ok((await state(T, 'tech_savvy')) === 'active' && (await state(T, 'founders_builders')) === 'not_qualified', 'precondition: one qualified and one not_qualified decision are recorded');
  ok((await feed(T)).find((f) => f.campaign_id === targeted).eligible === true, 'precondition: the targeted campaign is reservable');
  await putAn(T, s1, H('a'));
  await putMatches(T, s1, [{ campaign_id: open, profile_hash: H('a'), campaign_hash: H('1'), result: { verdict: 'strong', recommended: true } }]);
  await putNote(T, s1, 'business_office', H('c'));
  const creditsBefore = await bal(T);

  await consent(T, false);
  ok((await q('select count(*)::int n from public.category_qualifications where user_id=$1', [T]))[0].n === 0, '1. withdrawal deletes EVERY recorded decision of that tester (qualified and not_qualified), in the same transaction');
  ok((await state(T, 'tech_savvy')) === 'pending_assessment' && (await state(T, 'founders_builders')) === 'pending_assessment', '2. the previously decided professional categories return to PENDING');
  ok((await state(T, 'students_learners')) === 'active', '3. a general category is unaffected (it never needed a decision)');
  const mine = await my(T);
  ok(mine.participation_ready === true && mine.has_profile === true, '4. the anonymous account, the profile and participation_ready are preserved');
  ok(!mine.active_categories.includes('tech_savvy') && mine.active_categories.includes('students_learners'), '5. only the general category is still active');
  const f1 = await feed(T);
  ok(f1.find((f) => f.campaign_id === targeted).eligible === false && f1.find((f) => f.campaign_id === open).eligible === true, '6. the targeted campaign is no longer reservable (server-side) while Open Testing stays available');
  ok(await failsWith(() => as(T, () => q('select public.start_test($1)', [targeted])), 'not_eligible'), '7. and the database trigger refuses a reservation of it');
  ok(!!(await as(T, () => q('select public.start_test($1) r', [open])))[0].r, '8. the tester can still start an Open task after withdrawing');
  ok((await bal(T)) === creditsBefore, '9. credits are untouched by a withdrawal');
  await sweep();
  ok((await heldFor(s1)) === 0, '10. the erasure sweep erases the cached analysis, the cached recommendations and the clarification notes');
  const after = await aiProfile(T);
  ok(after.subject_ref === null && after.profile.bio === null && after.categories.every((c) => c.answers === null), '11. the contract hands out no bio, no answers and no subject_ref any more');
  ok(await svc(() => q('select public.ai_consent_active($1,$2) r', [T, s1])).then((r) => r[0].r) === false, '12. ai_consent_active is false the moment consent is withdrawn (so no further model request is made)');
  ok(await failsWith(() => decide(T, 'tech_savvy', 'qualified'), 'consent_required'), '13. nothing new can be recorded while consent is off');
  ok(mapAssessmentInput(after).targets.length === 0 && mapContractProfile(after).consent === false, '14. the AI sees no consent and no targets, so it neither assesses nor recommends');
  ok(await failsWith(() => q(`insert into public.category_qualifications (user_id, category, status, source, question_version, answers_hash) values ($1,'business_office','qualified','ai_assessment',1,$2)`, [T, H('d')]), 'consent_required'), '15. even a direct insert by the table owner is refused by the trigger without active consent');
  await putAn(T, s1, H('z'));
  ok((await putMatches(T, s1, [{ campaign_id: open, profile_hash: H('a'), campaign_hash: H('1'), result: {} }])) === 0 && (await heldFor(s1)) === 0, '16. a model run that finishes after the withdrawal stores nothing');

  // withdrawing twice and re-granting
  await consent(T, false);
  ok((await state(T, 'tech_savvy')) === 'pending_assessment', '17. withdrawing again is harmless');
  await consent(T, true);
  const s2 = await subjectOf(T);
  ok(s2 !== s1 && (await state(T, 'tech_savvy')) === 'pending_assessment' && mapAssessmentInput(await aiProfile(T)).targets.map((t) => t.category).sort().join() === 'founders_builders,tech_savvy', '18. re-consent issues a NEW subject_ref and both professional categories are queued for assessment again');
  await decide(T, 'tech_savvy', 'qualified');
  ok((await state(T, 'tech_savvy')) === 'active' && (await feed(T)).find((f) => f.campaign_id === targeted).eligible === true, '19. a fresh decision after re-consent works normally');

  // editing answers while consent is off
  await consent(T, false);
  await save(T, 'tech_savvy', ANS('edited while off'));
  ok((await state(T, 'tech_savvy')) === 'pending_assessment', '20. editing answers while AI is off keeps the category pending');
  // deleting answers
  await consent(T, true);
  await decide(T, 'tech_savvy', 'qualified');
  await delExp(T, 'tech_savvy');
  ok((await state(T, 'tech_savvy')) !== 'active' && (await q('select count(*)::int n from public.category_qualifications where user_id=$1 and category=$2', [T, 'tech_savvy']))[0].n === 0, '21. deleting the answers still deletes the decision made about them');

  // other testers are unaffected by someone else's withdrawal
  const U = await mk();
  await profile(U, ['tech_savvy']);
  await save(U, 'tech_savvy', ANS('tech'));
  await consent(U, true);
  await decide(U, 'tech_savvy', 'qualified');
  const V = await mk();
  await profile(V, ['tech_savvy']);
  await save(V, 'tech_savvy', ANS('tech'));
  await consent(V, true);
  await consent(V, false);
  ok((await state(U, 'tech_savvy')) === 'active', "22. one tester's withdrawal never touches another tester's decision");
  // the privilege surface of the new objects
  ok(await failsWith(() => as(U, () => q('select public.ai_consent_active($1,$2)', [U, s2])), 'permission denied'), '23. ai_consent_active is not callable by a signed-in user');
  const trg = await q(`select count(*)::int n from pg_trigger where tgname in ('ai_consents_withdrawal_clears_decisions','category_qualifications_require_consent') and not tgisinternal`);
  ok(trg[0].n === 2, '24. migration 10 adds exactly its two triggers');
}

console.log('\n[existing protections intact: credits, reservations, referrals]');
{
  const T = await mk();
  const O = await mk();
  const U = await mk();
  await profile(T, ['tech_savvy', 'students_learners']);
  await save(T, 'tech_savvy', ANS('tech'));
  await save(T, 'students_learners', ANS('study'));
  await consent(T, true);
  const s = await subjectOf(T);
  const open = await createV2(O, 'open', []);
  const targeted = await createV2(await mk(), 'targeted', ['tech_savvy'], 'Pro only');
  // lots of derived AI data and a cached "perfect" analysis must change nothing about access
  await putAn(T, s, H('a'), { summary: 'extremely experienced' });
  await putMatches(T, s, [{ campaign_id: targeted, profile_hash: H('a'), campaign_hash: H('1'), result: { verdict: 'strong', recommended: true } }]);
  ok(await failsWith(() => as(T, () => q('select public.start_test($1)', [targeted])), 'not_eligible'), 'a "strong" cached AI verdict does NOT let an unassessed tester reserve a targeted professional campaign (database trigger)');
  const e = (await as(T, () => q('select public.get_campaign_eligibility($1) r', [targeted])))[0].r;
  ok(e.eligible === false, 'and eligibility still says so');
  // a normal open test: credits conserved, reward once
  const b0 = await bal(T);
  await as(T, () => q('select public.start_test($1)', [open]));
  await q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds' where tester_id=$1 and campaign_id=$2`, [T, open]);
  const sub = (await as(T, () => q('select public.submit_test($1,true,$2,$3,4,false) r', [open, FB.friction, FB.suggestion])))[0].r;
  ok((await bal(T)) === b0 + 1 && !!sub, 'completing an open test still earns exactly one credit for a tester with AI data');
  let again = null;
  try { await as(T, () => q('select public.start_test($1)', [open])); } catch (e) { again = String(e.message); }
  ok(again !== null, 'a second reservation of the same (already tested) campaign is still refused: ' + again);
  const refs = await as(T, () => q('select public.get_my_referrals() r'));
  ok(refs[0].r && typeof refs[0].r.cap === 'number', 'referral accounting still answers (untouched)');
  ok((await q(`select coalesce(sum(delta),0)::int n from public.credit_ledger where user_id=$1`, [T]))[0].n === await bal(T), 'the credit ledger still sums to the balance (conservation)');
  // an identity with NO AI data behaves identically
  await profile(U, ['students_learners']);
  await save(U, 'students_learners', ANS('study'));
  const ub0 = await bal(U);
  await as(U, () => q('select public.start_test($1)', [open])).catch(() => null);
  ok((await bal(U)) === ub0, 'no credit moves on a mere reservation attempt');
}

console.log('\n[additive only, and no migration-time dependency on unmerged work]');
{
  const all = readdirSync(new URL('../migrations', import.meta.url)).filter((f) => f.endsWith('.sql'));
  const baselineFiles = all.filter((f) => !f.includes('ai_matching'));
  const baseline = await createHarness({ quiet: true, migrations: baselineFiles });
  const defs = (x) => x.q("select p.oid::regprocedure::text sig, md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1");
  const cols = (x) => x.q("select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2");
  const pol = (x) => x.q("select tablename, policyname, cmd, qual from pg_policies where schemaname='public' order by 1,2");
  const before = await defs(baseline);
  const afterMap = new Map((await defs(h)).map((r) => [r.sig, r.h]));
  ok(before.length > 40 && before.every((r) => afterMap.get(r.sig) === r.h), `all ${before.length} pre-existing public functions (incl. migration 8's contract) are byte-identical after the AI migration`);
  const cb = await cols(baseline);
  const ca = new Set((await cols(h)).map((r) => JSON.stringify(r)));
  ok(cb.length > 80 && cb.every((r) => ca.has(JSON.stringify(r))), `all ${cb.length} pre-existing columns are unchanged`);
  ok(JSON.stringify(await pol(baseline)) === JSON.stringify(await pol(h)), 'no RLS policy was added, changed or removed');
  // applies with migration 8 ABSENT (late-bound plpgsql): no hard dependency at migration time
  const pre8 = all.filter((f) => f <= '20261115000200_matching_v2.sql' || f.includes('ai_matching'));
  let applied = true;
  try { await createHarness({ quiet: true, migrations: pre8 }); } catch { applied = false; }
  ok(applied, 'the AI migration applies on top of migrations 1-7 alone (it needs migration 8 only at runtime, for the erasure sweep)');
}

const c = counts();
console.log(`\n${c.passed} passed, ${c.failed} failed`);
process.exit(c.failed ? 1 : 0);
