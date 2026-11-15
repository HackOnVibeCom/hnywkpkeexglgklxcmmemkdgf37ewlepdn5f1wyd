// Experience profile (migration 20261115000300): four open-ended answers per category for ALL five categories, owner-only
// storage, AI consent, server-only qualification decisions, the participation rule, question versions, deletion.
// Real Postgres (PGlite) + the real migration files. NO test fixture: every identity starts without a profile.

import { createHarness, uid } from './harness.mjs';

const { db, as, q, ok, failsWith, fails, summary } = await createHarness({ quiet: true });

const TASK = 'Find the pricing page and tell me which plan you would pick.';
const FB = { friction: 'The pricing link was hidden in the footer.', suggestion: 'Add a pricing link to the top nav.' };
const ALL = ['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical'];
const PRO = ['tech_savvy', 'founders_builders', 'business_office'];
const GENERAL = ['students_learners', 'everyday_nontechnical'];
const J = JSON.stringify;

/** Four valid, distinct answers; `tag` makes them unique per call. */
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
const bal = async (u) => (await as(u, () => q('select credit_balance from public.profiles')))[0].credit_balance;
const profile = (u, cats, nick = 'Tester', bio = 'I like testing things') => as(u, () => q('select * from public.save_tester_profile($1,$2,$3)', [nick, bio, cats]));
const save = (u, cat, a) => as(u, () => q('select public.save_experience_answers($1,$2::jsonb) r', [cat, JSON.stringify(a)])).then((r) => r[0].r);
const my = async (u) => (await as(u, () => q('select public.get_my_experience() r')))[0].r;
const st = async (u) => Object.fromEntries((await my(u)).categories.map((c) => [c.category, c.state]));
const cat = async (u, c) => (await my(u)).categories.find((x) => x.category === c);
const consent = (u, g) => as(u, () => q('select public.set_ai_consent($1) r', [g])).then((r) => r[0].r);
const del = (u, c) => as(u, () => q('select public.delete_my_experience($1) r', [c ?? null])).then((r) => r[0].r);
const svc = async (fn) => { await db.exec('set role service_role'); try { return await fn(); } finally { await db.exec('reset role'); } };
const aiProfile = (u) => svc(() => q('select public.service_get_ai_profile($1) r', [u])).then((r) => r[0].r);
const decide = (u, c, status, over = {}) => svc(async () => {
  const p = (await q('select public.service_get_ai_profile($1) r', [u]))[0].r.categories.find((x) => x.category === c);
  const a = { version: p.question_version, hash: p.answers_hash, assessment: null, ...over };
  return (await q('select public.service_record_qualification($1,$2,$3,$4,$5,$6::jsonb) r', [u, c, a.version, a.hash, status, a.assessment ? JSON.stringify(a.assessment) : null]))[0].r;
});
const createV2 = async (owner, mode, cats, name = 'V2 task') => (await as(owner, () => q('select public.create_campaign_v2($1,$2,$3,$4,$5,$6) id', [name, 'https://example.com', 'd', TASK, mode, cats])))[0].id;
const fresh = async (mode, cats, name) => { const o = await mk(); return { owner: o, id: await createV2(o, mode, cats, name) }; };
const feed = (u) => as(u, () => q('select * from public.list_campaigns_v2()'));
const elig = async (u, camp) => (await as(u, () => q('select public.get_campaign_eligibility($1) r', [camp])))[0].r;
const startOf = (u, camp) => as(u, () => q('select public.start_test($1) r', [camp]));
const finish = async (u, camp) => {
  await q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds' where tester_id=$1 and campaign_id=$2`, [u, camp]);
  return (await as(u, () => q('select public.submit_test($1,true,$2,$3,4,false) r', [camp, FB.friction, FB.suggestion])))[0].r;
};
async function detail(fn) { try { await fn(); return null; } catch (e) { return e.detail ?? String(e.message); } }
/** A tester who can participate: profile + four answers for the given categories. */
async function ready(cats = ['students_learners'], nick = 'Tester') {
  const u = await mk();
  await profile(u, cats, nick);
  for (const c of cats) await save(u, c, ANS(c));
  return u;
}

console.log('\n[1. the questions: four open-ended questions in all five categories]');
{
  const rows = await q('select category, version, position, qid, prompt, hint from public.experience_questions order by category, version, position');
  ok(rows.length === 20, 'twenty questions: five categories x four');
  for (const c of ALL) {
    const r = rows.filter((x) => x.category === c);
    ok(r.length === 4 && r.every((x) => x.version === 1) && J(r.map((x) => x.qid)) === '["q1","q2","q3","q4"]' && J(r.map((x) => x.position)) === '[1,2,3,4]', `${c}: exactly four questions q1..q4 at version 1`);
    ok(r.every((x) => x.prompt.length >= 20 && /[?.]$/.test(x.prompt)), `${c}: every question is a real sentence`);
  }
  const cols = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='experience_questions' order by ordinal_position`)).map((r) => r.column_name);
  ok(!cols.includes('options') && !cols.includes('choices') && !cols.includes('correct'), 'the question table has no options / choices / answer key: nothing is multiple choice or trivia');
  ok(rows.find((x) => x.category === 'tech_savvy' && x.qid === 'q1').prompt === 'What technologies, tools or software do you have experience using?' && rows.find((x) => x.category === 'tech_savvy' && x.qid === 'q4').prompt === 'What kinds of software or technology products are you most comfortable testing, and why?', 'Tech-Savvy questions use the requested wording');
  ok(J(rows.filter((x) => x.category === 'students_learners').map((x) => x.prompt)) === J([
    'What subjects or fields are you currently studying or learning?',
    'What tools, applications or technologies do you regularly use?',
    'Describe a project, activity or skill you have developed through studying or independent learning.',
    'What types of digital products do you feel familiar with or interested in testing?']), 'Students & Learners questions use the requested wording');
  ok(!rows.some((x) => /\b(age|gender|salary|religion|ethnic)/i.test(x.prompt)) && !rows.some((x) => /(multiple|choose one|which of the following)/i.test(x.prompt)), 'no demographic or multiple-choice phrasing');
  ok(/skill level/.test(rows.find((x) => x.category === 'students_learners' && x.qid === 'q1').hint) && rows.every((x) => !/beginner|novice|low skill/i.test(x.prompt + (x.hint ?? ''))), 'a student is never assumed to be low-skilled');
  ok(new Set(rows.map((x) => x.prompt)).size === 20, 'all twenty prompts are different (category specific)');
  const u = await mk();
  const gq = (await as(u, () => q("select public.get_experience_questions('business_office') r")))[0].r;
  ok(gq.version === 1 && gq.questions.length === 4 && gq.questions[0].id === 'q1' && gq.answers === null && gq.requires_assessment === true && gq.saves_left === 5, 'get_experience_questions serves the current version in order, no answers yet');
  ok(!!(await as(u, () => q("select public.get_experience_questions('students_learners') r")))[0].r && (await as(u, () => q("select public.get_experience_questions('students_learners') r")))[0].r.requires_assessment === false, 'general categories are flagged as needing no assessment');
  ok(await failsWith(() => as(u, () => q("select public.get_experience_questions('wizards')")), 'invalid_category'), 'an unknown category is refused');
}

console.log('\n[2. privileges and ownership: nothing is a back door]');
{
  const U = await mk(), V = await mk();
  const CLIENT = [
    "select public.get_experience_questions('tech_savvy')",
    "select public.save_experience_answers('tech_savvy','{}')",
    'select public.get_my_experience()',
    'select public.set_ai_consent(true)',
    'select public.delete_my_experience()',
  ];
  for (const call of CLIENT) ok(await failsWith(() => as(null, () => q(call)), 'permission denied'), `anon denied: ${call.slice(0, 50)}`);
  for (const t of ['experience_questions', 'experience_answers', 'ai_consents', 'category_qualifications', 'experience_save_limits', 'ai_erasure_events']) {
    ok(await failsWith(() => as(U, () => q(`select * from public.${t}`)), 'permission denied'), `authenticated cannot read ${t}`);
    ok(await failsWith(() => as(U, () => q(`delete from public.${t}`)), 'permission denied'), `authenticated cannot delete from ${t}`);
    ok(await failsWith(() => as(null, () => q(`select * from public.${t}`)), 'permission denied'), `anon cannot read ${t}`);
    const r = (await q(`select relrowsecurity r, (select count(*)::int from pg_policies where tablename='${t}') p from pg_class where oid='public.${t}'::regclass`))[0];
    ok(r.r === true && r.p === 0, `RLS is on for ${t} and there is no policy at all (default deny)`);
    ok((await q(`select count(*)::int n from information_schema.column_privileges where table_schema='public' and table_name='${t}' and grantee in ('anon','authenticated','PUBLIC')`))[0].n === 0, `no column privilege on ${t} for any client role`);
  }
  ok(await failsWith(() => as(U, () => q(`insert into public.category_qualifications (user_id, category, status, source, question_version, answers_hash) values ('${U}','tech_savvy','qualified','ai_assessment',1,'${'a'.repeat(64)}')`)), 'permission denied'), 'a qualification cannot be forged with a direct INSERT');
  ok(await failsWith(() => as(U, () => q(`insert into public.experience_answers (user_id, category, version, answers, answers_hash) values ('${U}','tech_savvy',1,'{}','${'a'.repeat(64)}')`)), 'permission denied'), 'answers cannot be written with a direct INSERT (validation is in the RPC)');
  const SVC = ['public.service_get_ai_profile(uuid)', 'public.service_list_pending_assessments(integer)', 'public.service_record_qualification(uuid,text,integer,text,text,jsonb)', 'public.service_list_eligible_campaigns(uuid)', 'public.service_list_erasure_events(bigint,integer)'];
  for (const sig of SVC) {
    const r = (await q(`select has_function_privilege('anon','${sig}','execute') a, has_function_privilege('authenticated','${sig}','execute') u, has_function_privilege('public','${sig}','execute') p, has_function_privilege('service_role','${sig}','execute') s, (select prosecdef from pg_proc where oid='${sig}'::regprocedure) d`))[0];
    ok(!r.a && !r.u && !r.p && r.s && r.d, `${sig}: service_role only, SECURITY DEFINER (catalog check)`);
  }
  ok(await failsWith(() => as(U, () => q(`select public.service_get_ai_profile('${V}')`)), 'permission denied'), 'a signed-in browser cannot call the AI interface for ANY user id');
  ok(await failsWith(() => as(U, () => q(`select * from public.service_list_eligible_campaigns('${V}')`)), 'permission denied'), '... including the eligibility listing');
  ok(await failsWith(() => as(null, () => q(`select public.service_get_ai_profile('${V}')`)), 'permission denied'), 'anon cannot either');
  for (const sig of ['public.experience_current_version(text)', 'public.experience_complete(uuid,text)', 'public.is_qualified(uuid,text)', 'public.category_state(uuid,text)', 'public.active_tester_categories(uuid)', 'public.tester_participation_ready(uuid)', 'public.normalize_experience_answers(text,jsonb)', 'public.experience_hash(integer,jsonb)', 'public.experience_category_json(uuid,text)', 'public.tester_eligibility(uuid,text,text[])', 'public.enforce_campaign_eligibility()']) {
    const r = (await q(`select has_function_privilege('anon','${sig}','execute') a, has_function_privilege('authenticated','${sig}','execute') u, has_function_privilege('public','${sig}','execute') p, has_function_privilege('service_role','${sig}','execute') s`))[0];
    ok(!r.a && !r.u && !r.p, `internal ${sig}: not executable by clients (catalog check)`);
  }
  for (const sig of ['public.get_experience_questions(text)', 'public.save_experience_answers(text,jsonb)', 'public.get_my_experience()', 'public.set_ai_consent(boolean)', 'public.delete_my_experience(text)']) {
    const r = (await q(`select has_function_privilege('anon','${sig}','execute') a, has_function_privilege('authenticated','${sig}','execute') u, has_function_privilege('public','${sig}','execute') p, (select prosecdef and coalesce(proconfig::text,'') like '%search_path%' from pg_proc where oid='${sig}'::regprocedure) d`))[0];
    ok(!r.a && !r.p && r.u && r.d, `${sig}: authenticated only, SECURITY DEFINER, search_path pinned`);
  }
  await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub', '', false)");
  ok(await failsWith(() => q('select public.get_my_experience()'), 'not_authenticated'), 'no identity -> not_authenticated');
  await db.exec('reset role');
  // old multiple-choice screening can no longer create a pass
  ok(await failsWith(() => as(U, () => q("select public.submit_screening('tech_savvy', '{}')")), 'screening_replaced'), 'the retired multiple-choice submit_screening refuses');
  ok(await failsWith(() => as(U, () => q("select public.get_screening('tech_savvy')")), 'screening_replaced'), 'and get_screening too');
  const before = (await q('select count(*)::int n from public.screening_attempts'))[0].n;
  ok(before === 0 && (await q('select count(*)::int n from public.category_qualifications'))[0].n === 0, 'no legacy attempts and no qualification exists anywhere (nothing was fabricated by the migration)');
}

console.log('\n[3. validation: required answers and basic input checks]');
{
  const u = await mk();
  ok(await failsWith(() => save(u, 'tech_savvy', ANS()), 'profile_required'), 'answers need a tester profile first');
  await profile(u, ['tech_savvy', 'students_learners']);
  const bad = async (name, a, code) => ok((await detail(() => save(u, 'students_learners', a))) === code, name, code);
  await bad('missing an answer', { q1: ANS().q1, q2: ANS().q2, q3: ANS().q3 }, 'shape');
  await bad('an extra key', { ...ANS(), q5: 'one more answer here please' }, 'shape');
  await bad('a wrong key', { q1: ANS().q1, q2: ANS().q2, q3: ANS().q3, x4: 'this key does not exist at all' }, 'q4:missing');
  await bad('a non-string answer', { ...ANS(), q2: 42 }, 'q2:missing');
  await bad('an array answer', { ...ANS(), q2: ['multiple', 'choice', 'style'] }, 'q2:missing');
  await bad('an empty answer', { ...ANS(), q3: '' }, 'q3:too_short');
  await bad('whitespace only', { ...ANS(), q3: '   \n\t   ' }, 'q3:too_short');
  await bad('14 characters is too short', { ...ANS(), q1: 'a b c d e f g' }, 'q1:too_short');
  await bad('one long word', { ...ANS(), q1: 'x'.repeat(60) }, 'q1:too_few_words');
  await bad('two words only', { ...ANS(), q1: 'Python programming' }, 'q1:too_few_words');
  await bad('three words but only two distinct', { ...ANS(), q4: 'yes yes yes yes yes yes yes' }, 'q4:too_few_words');
  await bad('801 characters is too long', { ...ANS(), q4: ('word ').repeat(160) + 'z' }, 'q4:too_long');
  await bad('control characters', { ...ANS(), q2: 'valid looking text \u0007 with a bell char' }, 'q2:control_chars');
  await bad('four copies of the same text', { q1: 'the exact same words here', q2: 'the exact same words here', q3: 'The Exact Same Words Here', q4: 'the exact same words here' }, 'duplicate_answers');
  ok((await q('select count(*)::int n from public.experience_answers where user_id=$1', [u]))[0].n === 0, 'not a single rejected submission wrote anything');
  ok((await cat(u, 'students_learners')).state === 'incomplete', 'and the category stays incomplete');
  ok(await failsWith(() => as(u, () => q("select public.save_experience_answers('students_learners', null)")), 'invalid_answers'), 'null answers are refused');
  ok(await failsWith(() => as(u, () => q("select public.save_experience_answers('students_learners', '[1,2,3,4]')")), 'invalid_answers'), 'an array instead of an object is refused');
  ok(await failsWith(() => save(u, 'wizards', ANS()), 'invalid_category'), 'an unknown category is refused');
  // accepted boundaries and normalisation
  const a = { q1: 'one two three x', q2: ' lots   of\n\nspaces  and\tline   breaks here ', q3: 'Привет я изучаю программирование и дизайн', q4: ('word' + 'x ').repeat(1).repeat(0) + Array.from({ length: 133 }, (_, i) => 'w' + i).join(' ').slice(0, 800) };
  const r = await save(u, 'students_learners', a);
  const row = (await q('select answers, version from public.experience_answers where user_id=$1', [u]))[0];
  ok(r.state === 'active' && row.version === 1, 'valid answers (15 chars, 800 chars, Cyrillic, odd whitespace) are accepted');
  ok(row.answers.q2 === 'lots of spaces and line breaks here' && row.answers.q4.length <= 800, 'whitespace is collapsed and trimmed');
  ok(row.answers.q3 === a.q3, 'non-ASCII text is stored unchanged');
  ok(J(Object.keys(row.answers)) === '["q1","q2","q3","q4"]' && Object.values(row.answers).every((v) => typeof v === 'string'), 'stored as four strings under q1..q4');
}

console.log('\n[4. general categories: complete the four answers -> active, no professional qualification]');
{
  for (const c of GENERAL) {
    const u = await mk();
    await profile(u, [c]);
    ok((await cat(u, c)).state === 'incomplete' && (await cat(u, c)).reason === 'answers_needed' && (await my(u)).participation_ready === false, `${c}: selected but with no answers -> incomplete, not ready`);
    ok(J((await my(u)).active_categories) === '[]', `${c}: not active yet`);
    const { id: open } = await fresh('open', [], 'Any open');
    ok((await detail(() => startOf(u, open))) === 'profile_incomplete', `${c}: cannot reserve even an OPEN task before completing the answers`);
    const res = await save(u, c, ANS(c));
    ok(res.state === 'active' && res.reason === 'active' && res.qualification === null && res.requires_assessment === false, `${c}: four valid answers -> ACTIVE at once, no assessment, no qualification record`);
    ok((await my(u)).participation_ready === true && J((await my(u)).active_categories) === J([c]), `${c}: participation ready, listed as active`);
    ok((await q('select count(*)::int n from public.category_qualifications where user_id=$1', [u]))[0].n === 0, `${c}: nothing was written to category_qualifications`);
    ok(!!(await startOf(u, open))[0].r.reservation_expires_at, `${c}: can now reserve an open task`);
    const b0 = await bal(u);
    ok((await finish(u, open)).credits_awarded === 1 && (await bal(u)) === b0 + 1, `${c}: and earns the normal credit`);
    const { id: tgt } = await fresh('targeted', [c], 'Targeted ' + c);
    ok((await elig(u, tgt)).eligible === true && (await feed(u)).find((r) => r.campaign_id === tgt).fit === 'recommended', `${c}: eligible for a targeted task of its category and it matches`);
  }
}

console.log('\n[5. professional categories: answers alone are never a qualification]');
{
  for (const c of PRO) {
    const u = await mk();
    await profile(u, [c]);
    ok((await cat(u, c)).state === 'incomplete', `${c}: starts incomplete (pending)`);
    const r = await save(u, c, ANS(c));
    ok(r.state === 'pending_assessment' && r.reason === 'consent_required' && r.qualification === null, `${c}: four valid answers -> PENDING assessment (consent needed), NOT active`, J(r));
    ok(J((await my(u)).active_categories) === '[]' && (await my(u)).participation_ready === true, `${c}: no active category, but profile completion (participation) is satisfied`);
    const { id: tgt } = await fresh('targeted', [c], 'Targeted ' + c);
    const e = await elig(u, tgt);
    ok(e.eligible === false && e.reason === 'qualification_required' && J(e.missing_screening) === J([c]) && J(e.overlap) === '[]', `${c}: not eligible for the targeted task (qualification_required)`, J(e));
    ok((await detail(() => startOf(u, tgt))) === 'qualification_required', `${c}: the server refuses the targeted reservation`);
    ok((await feed(u)).find((x) => x.campaign_id === tgt).fit === 'not_eligible', `${c}: Discover shows it as not eligible`);
    const { id: open } = await fresh('open', [c], 'Open preferring ' + c);
    const fo = (await feed(u)).find((x) => x.campaign_id === open);
    ok(fo.eligible === true && fo.fit === 'eligible' && J(fo.match_categories) === '[]', `${c}: an OPEN task that prefers it is available but not "recommended" through a pending category`);
    ok(!!(await startOf(u, open))[0].r.reservation_expires_at, `${c}: open testing works (profile completion is enough)`);
    ok((await finish(u, open)).credits_awarded === 1, `${c}: and the credit is earned`);
    await consent(u, true);
    ok((await cat(u, c)).reason === 'awaiting_assessment' && (await cat(u, c)).state === 'pending_assessment', `${c}: with consent it waits for the assessment (still pending)`);
  }
  // time does not qualify anybody: no timeout, no auto-accept when the service is unavailable
  const t = await mk();
  await profile(t, ['tech_savvy']); await save(t, 'tech_savvy', ANS('t')); await consent(t, true);
  await q(`update public.experience_answers set created_at = now() - interval '90 days', updated_at = now() - interval '90 days' where user_id=$1`, [t]);
  ok((await cat(t, 'tech_savvy')).state === 'pending_assessment', 'service unavailable for 90 days: the category is still PENDING (no timeout, no automatic acceptance)');
  ok((await q('select count(*)::int n from public.category_qualifications where user_id=$1', [t]))[0].n === 0, 'and no qualification record was invented');
}

console.log('\n[6. qualification decisions: server-only, bound to the exact answers]');
{
  const u = await ready(['tech_savvy', 'students_learners']);
  const other = await ready(['tech_savvy']);
  const { id: tgt } = await fresh('targeted', ['tech_savvy'], 'Tech targeted');
  const { id: open } = await fresh('open', ['tech_savvy'], 'Tech open');
  // no consent -> not queued, cannot be decided
  const queued = async (lim = 200) => (await svc(() => q('select * from public.service_list_pending_assessments($1)', [lim]))).filter((x) => x.user_id === u || x.user_id === other);
  ok((await queued()).length === 0, 'without consent nothing is queued for assessment');
  ok(await failsWith(() => decide(u, 'tech_savvy', 'qualified'), 'consent_required'), 'a decision for a tester who did not consent is refused');
  await consent(u, true); await consent(other, true);
  const queue = await queued();
  ok(queue.length === 2 && queue.every((x) => x.category === 'tech_savvy' && /^[0-9a-f]{64}$/.test(x.answers_hash) && x.question_version === 1) && !('answers' in queue[0]), 'with consent the professional categories are queued (hash + version, no answers in the queue)');
  ok((await svc(() => q('select * from public.service_list_pending_assessments(1)'))).length === 1 && (await svc(() => q('select * from public.service_list_pending_assessments(null)'))).length >= 2, 'the queue honours its limit');
  // validation of the decision
  const cur = (await aiProfile(u)).categories.find((x) => x.category === 'tech_savvy');
  const rec = (args) => svc(() => q('select public.service_record_qualification($1,$2,$3,$4,$5,$6::jsonb) r', args));
  ok(await failsWith(() => rec([u, 'tech_savvy', 1, cur.answers_hash, 'maybe', null]), 'invalid_status'), 'status must be qualified or not_qualified');
  ok(await failsWith(() => rec([u, 'students_learners', 1, cur.answers_hash, 'qualified', null]), 'category_not_assessable'), 'general categories cannot be "qualified" (they need no assessment)');
  ok(await failsWith(() => rec([u, 'tech_savvy', 1, 'f'.repeat(64), 'qualified', null]), 'stale_assessment'), 'a decision for different answers (wrong hash) is refused');
  ok(await failsWith(() => rec([u, 'tech_savvy', 2, cur.answers_hash, 'qualified', null]), 'stale_assessment'), 'a decision for another question version is refused');
  ok(await failsWith(() => rec([other, 'founders_builders', 1, cur.answers_hash, 'qualified', null]), 'stale_assessment'), 'a decision for a category without answers is refused');
  ok(await failsWith(() => rec([u, 'tech_savvy', 1, cur.answers_hash, 'qualified', J({ raw_answers: 'x' })]), 'invalid_assessment'), 'an assessment payload may only carry model / rubric_version / summary / confidence');
  ok(await failsWith(() => rec([u, 'tech_savvy', 1, cur.answers_hash, 'qualified', J({ summary: 'x'.repeat(501) })]), 'invalid_assessment'), 'summary is length limited');
  ok(await failsWith(() => rec([u, 'tech_savvy', 1, cur.answers_hash, 'qualified', '[1]']), 'invalid_assessment'), 'payload must be an object');
  ok((await cat(u, 'tech_savvy')).state === 'pending_assessment', 'after all those refusals the category is still pending');
  // not qualified
  const nq = await decide(u, 'tech_savvy', 'not_qualified', { assessment: { model: 'm', rubric_version: 'r1', summary: 'not enough detail', confidence: 0.4 } });
  ok(nq.state === 'not_qualified' && nq.reason === 'not_qualified' && nq.qualification.status === 'not_qualified' && nq.qualification.source === 'ai_assessment', 'a not_qualified decision is reported as such');
  ok((await elig(u, tgt)).reason === 'qualification_required' && J((await my(u)).active_categories) === '["students_learners"]', 'not_qualified: still no targeted access, the other category is untouched');
  ok((await queued()).every((x) => x.user_id !== u), 'a decided category leaves the queue');
  // qualified
  const qd = await decide(u, 'tech_savvy', 'qualified', { assessment: { model: 'm', rubric_version: 'r1' } });
  ok(qd.state === 'active' && qd.qualification.status === 'qualified', 'a qualified decision for the CURRENT answers activates the category');
  ok((await elig(u, tgt)).eligible === true && (await feed(u)).find((r) => r.campaign_id === tgt).fit === 'recommended' && (await feed(u)).find((r) => r.campaign_id === open).fit === 'recommended', 'eligible for the targeted task and matched for the open one');
  ok(!!(await startOf(u, tgt))[0].r.reservation_expires_at, 'the server lets the qualified tester reserve the targeted task');
  const b0 = await bal(u);
  ok((await finish(u, tgt)).credits_awarded === 1 && (await bal(u)) === b0 + 1, 'and the credit is earned as before');
  ok((await q(`select count(*)::int n from public.category_qualifications where user_id=$1 and category='tech_savvy' and source='ai_assessment'`, [u]))[0].n === 1, 'one decision row per (identity, category): re-deciding replaces it');
  // somebody else's decision does not help me
  const { id: tgt2 } = await fresh('targeted', ['tech_savvy'], 'Tech targeted 2');
  ok((await elig(other, tgt2)).eligible === false && await failsWith(() => startOf(other, tgt2), 'not_eligible'), "another identity's decision never activates my category");
  // editing the answers makes the decision stale
  await save(u, 'tech_savvy', ANS('edited'));
  ok((await cat(u, 'tech_savvy')).state === 'pending_assessment', 'editing the answers invalidates the decision: back to pending assessment');
  const activeNow = async (x) => (await q('select public.active_tester_categories($1) a', [x]))[0].a;
  ok(J(await activeNow(u)) === '["students_learners"]', 'the optimised active-category query agrees: a decision for OLD answers does not activate the category');
  ok((await q('select public.active_tester_categories($1) a', [other]))[0].a.includes('tech_savvy') === false, '... and nobody else is affected');
  ok((await q(`select count(*)::int n from public.category_qualifications where user_id=$1 and category='tech_savvy'`, [u]))[0].n === 1, '(the stale row is kept but no longer counts)');
  ok(await failsWith(() => rec([u, 'tech_savvy', 1, cur.answers_hash, 'qualified', null]), 'stale_assessment'), 'and a late decision for the OLD answers is refused');
  await decide(u, 'tech_savvy', 'qualified');
  ok((await cat(u, 'tech_savvy')).state === 'active', 're-assessment of the new answers re-activates it');
  // consent withdrawal stops further decisions but does not erase history
  await consent(u, false);
  await save(u, 'tech_savvy', ANS('after-withdrawal'));
  ok(await failsWith(() => decide(u, 'tech_savvy', 'qualified'), 'consent_required'), 'after consent is withdrawn no decision can be recorded');
  ok((await queued()).every((x) => x.user_id !== u), 'and the tester is not queued');
}

console.log('\n[7. categories complete independently]');
{
  const u = await mk();
  await profile(u, ['tech_savvy', 'founders_builders', 'students_learners', 'everyday_nontechnical']);
  ok(J(await st(u)) === J({ tech_savvy: 'incomplete', founders_builders: 'incomplete', business_office: 'inactive', students_learners: 'incomplete', everyday_nontechnical: 'incomplete' }), 'four selected categories start incomplete, the fifth is inactive');
  await save(u, 'students_learners', ANS('s'));
  ok(J(await st(u)) === J({ tech_savvy: 'incomplete', founders_builders: 'incomplete', business_office: 'inactive', students_learners: 'active', everyday_nontechnical: 'incomplete' }), 'completing one category activates only that one');
  await save(u, 'tech_savvy', ANS('t'));
  ok((await st(u)).tech_savvy === 'pending_assessment' && (await st(u)).students_learners === 'active' && (await st(u)).founders_builders === 'incomplete', 'a professional category with answers is pending; the general one stays active; the third stays incomplete');
  await consent(u, true);
  await decide(u, 'tech_savvy', 'qualified');
  ok(J(await st(u)) === J({ tech_savvy: 'active', founders_builders: 'incomplete', business_office: 'inactive', students_learners: 'active', everyday_nontechnical: 'incomplete' }), 'qualifying one professional category leaves the incomplete ones incomplete (nothing is silently activated)');
  ok(J((await my(u)).active_categories) === '["tech_savvy","students_learners"]', 'active_categories lists exactly the active ones in canonical order');
  const { id: mixed } = await fresh('targeted', ['founders_builders', 'tech_savvy'], 'Founders or tech');
  const { id: fOnly } = await fresh('targeted', ['founders_builders'], 'Founders only');
  const { id: eOnly } = await fresh('targeted', ['everyday_nontechnical'], 'Everyday only');
  ok((await elig(u, mixed)).eligible === true && J((await elig(u, mixed)).overlap) === '["tech_savvy"]', 'a mixed targeted task is eligible through the ACTIVE category only');
  ok((await elig(u, fOnly)).reason === 'qualification_required' && J((await elig(u, fOnly)).missing_screening) === '["founders_builders"]', 'the incomplete professional category does not qualify and is named');
  ok((await elig(u, eOnly)).reason === 'qualification_required' && J((await elig(u, eOnly)).missing_screening) === '["everyday_nontechnical"]', 'an INCOMPLETE general category does not qualify either (answers are required for every category)');
  // leaving a category incomplete never revokes the finished one; editing one never touches another
  const before = J(await st(u));
  await profile(u, ['tech_savvy', 'founders_builders', 'students_learners', 'everyday_nontechnical', 'business_office']);
  ok(J(await st(u)) === J({ ...JSON.parse(before), business_office: 'incomplete' }), 'adding another category changes only that category');
  await profile(u, ['students_learners']);
  ok(J(await st(u)) === J({ tech_savvy: 'inactive', founders_builders: 'inactive', business_office: 'inactive', students_learners: 'active', everyday_nontechnical: 'inactive' }), 'removing categories deactivates only those');
  await profile(u, ['tech_savvy', 'students_learners']);
  ok((await st(u)).tech_savvy === 'active', 're-adding a qualified category reactivates it (answers and decision are kept)');
  // ticking all five does not unlock anything
  const w = await mk();
  await profile(w, ALL);
  ok(J(Object.values(await st(w))) === J(Array(5).fill('incomplete')) && (await my(w)).participation_ready === false, 'ticking all five categories with no answers activates nothing');
}

console.log('\n[8. the participation rule: no tester work without a completed category]');
{
  const { id: open } = await fresh('open', [], 'Open for all');
  const { id: legacy } = await (async () => { const o = await mk(); return { id: (await as(o, () => q('select public.create_project_with_campaign($1,$2,$3,$4) id', ['Legacy', 'https://example.com', 'd', TASK])))[0].id }; })();
  const { id: v1pref } = await (async () => { const o = await mk(); return { id: (await as(o, () => q('select public.create_targeted_campaign($1,$2,$3,$4,$5) id', ['V1 preferred', 'https://example.com', 'd', TASK, ['tech_savvy']])))[0].id }; })();
  ok((await q('select testing_mode m from public.campaigns where id=$1', [v1pref]))[0].m === 'open', 'a Matching-v1 campaign with preferred categories is open');
  const u = await mk();
  ok((await detail(() => startOf(u, open))) === 'profile_incomplete', 'no profile: an open task cannot be reserved (profile_incomplete)');
  ok((await elig(u, open)).reason === 'profile_incomplete' && (await elig(u, open)).eligible === false, 'get_campaign_eligibility says why');
  ok((await feed(u)).every((r) => r.eligible === false && r.ineligible_reason === 'profile_incomplete'), 'Discover still LISTS tasks, all flagged profile_incomplete (nothing is hidden)');
  await profile(u, ['everyday_nontechnical']);
  ok((await detail(() => startOf(u, open))) === 'profile_incomplete', 'a profile with a category but no answers: still refused');
  const priv = await fails(() => q(`insert into public.test_reservations (campaign_id, tester_id, expires_at) values ('${open}','${u}', now() + interval '1 hour')`));
  ok(priv !== null && /not_eligible/.test(priv), 'even a privileged INSERT that bypasses start_test is refused by the trigger');
  await save(u, 'everyday_nontechnical', ANS('e'));
  ok(!!(await startOf(u, open))[0].r.reservation_expires_at, 'four answers for one selected category: the reservation works');
  ok((await finish(u, open)).credits_awarded === 1, 'and the reward is paid');
  const rd = await ready(['students_learners']);
  ok(!!(await startOf(rd, legacy))[0].r.reservation_expires_at, 'a legacy campaign is reservable by a ready tester');
  await finish(rd, legacy);
  ok(!!(await startOf(rd, v1pref))[0].r.reservation_expires_at, 'and so is a Matching-v1 campaign with preferred categories (it stays open)');
  // creating a campaign never needs the profile
  const founder = await mk();
  ok(!!(await createV2(founder, 'open', [], 'Founder without a profile')), 'a user with NO tester profile can still request a test (create a campaign)');
  ok((await as(founder, () => q('select credit_balance from public.profiles')))[0].credit_balance === 0, '... and it costs the usual single credit');
  // in-progress protection
  const t = await ready(['students_learners']);
  const { id: camp } = await fresh('open', [], 'In progress');
  await startOf(t, camp);
  await del(t); // delete ALL answers mid-test
  ok((await my(t)).participation_ready === false, 'after deleting every answer the tester is no longer ready');
  ok((await elig(t, camp)).eligible === true && (await elig(t, camp)).reason === 'in_progress', 'but the live reservation stays valid');
  ok(!!(await startOf(t, camp))[0].r.reservation_expires_at, 'start_test still returns it');
  const bb = await bal(t);
  ok((await finish(t, camp)).credits_awarded === 1 && (await bal(t)) === bb + 1, 'and the test can be submitted and rewarded');
  // a lapsed reservation is re-checked
  const t2 = await ready(['students_learners']);
  const { id: camp2 } = await fresh('open', [], 'Lapsed');
  await startOf(t2, camp2);
  await q(`update public.test_reservations set first_started_at = now() - interval '30 minutes', started_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where tester_id=$1 and campaign_id=$2`, [t2, camp2]);
  await del(t2);
  ok(await failsWith(() => startOf(t2, camp2), 'not_eligible'), 'a LAPSED reservation cannot be revived without a completed profile');
  const r = (await q('select coalesce((select sum(delta) from public.credit_ledger),0)::int l, coalesce((select sum(credit_balance) from public.profiles),0)::int b'))[0];
  ok(r.l === r.b, `credit conservation holds (ledger ${r.l} = balances ${r.b})`);
}

console.log('\n[9. editing, rate limit and deletion]');
{
  const u = await ready(['students_learners', 'tech_savvy']);
  const first = (await q('select created_at, updated_at from public.experience_answers where user_id=$1 and category=$2', [u, 'students_learners']))[0];
  await save(u, 'students_learners', ANS('second'));
  const r1 = (await q('select answers, updated_at from public.experience_answers where user_id=$1 and category=$2', [u, 'students_learners']))[0];
  ok(r1.answers.q1.includes('second') && new Date(r1.updated_at) >= new Date(first.updated_at), 'answers can be edited in place (one row per category)');
  ok((await cat(u, 'students_learners')).state === 'active', 'editing a general category keeps it active');
  const gq = (await as(u, () => q("select public.get_experience_questions('students_learners') r")))[0].r;
  ok(gq.answers.q1.includes('second') && gq.answers_version === 1 && gq.outdated === false && gq.saves_left === 3, 'get_experience_questions returns MY answers for editing and the saves left');
  const same = await save(u, 'students_learners', ANS('second'));
  ok(same.state === 'active' && (await as(u, () => q("select public.get_experience_questions('students_learners') r")))[0].r.saves_left === 3, 'saving identical answers is a no-op and is not counted');
  await save(u, 'students_learners', ANS('third'));
  await save(u, 'students_learners', ANS('fourth'));
  await save(u, 'students_learners', ANS('fifth'));
  const err = await detail(() => save(u, 'students_learners', ANS('sixth')));
  ok(err !== null && /^\d{4}-\d{2}-\d{2}/.test(err), 'the 6th change within 24 h is rate limited (experience_rate_limited, with the time it reopens)', String(err));
  ok(await failsWith(() => save(u, 'students_learners', ANS('sixth')), 'experience_rate_limited'), 'error code is experience_rate_limited');
  ok((await q('select answers->>\'q1\' a from public.experience_answers where user_id=$1 and category=$2', [u, 'students_learners']))[0].a.includes('fifth'), 'a rate-limited save changes nothing');
  ok(await failsWith(() => save(u, 'students_learners', { q1: 'x' }), 'invalid_answers'), 'malformed input is refused before the limit is even consulted');
  ok((await save(u, 'tech_savvy', ANS('other-category'))).state === 'pending_assessment', 'the limit is per category');
  await q(`update public.experience_save_limits set window_started_at = now() - interval '25 hours' where user_id=$1`, [u]);
  ok((await save(u, 'students_learners', ANS('seventh'))).state === 'active', 'after the 24 h window the next edit works');
  // deletion
  await consent(u, true);
  await decide(u, 'tech_savvy', 'qualified').catch(() => null);
  const v = await ready(['students_learners', 'tech_savvy']);
  await consent(v, true);
  await decide(v, 'tech_savvy', 'qualified');
  const d1 = await del(u, 'students_learners');
  ok(d1.deleted_answers === 1 && (await cat(u, 'students_learners')).state === 'incomplete', 'delete_my_experience(category) removes that category answers');
  ok((await cat(u, 'tech_savvy')).answers_complete === true && (await cat(v, 'students_learners')).state === 'active' && (await cat(v, 'tech_savvy')).state === 'active', 'and only those: the other category and other users are untouched');
  ok((await my(u)).participation_ready === true, 'readiness follows the remaining answers');
  const d2 = await del(v, 'tech_savvy');
  ok(d2.deleted_answers === 1 && d2.deleted_decisions === 1 && (await cat(v, 'tech_savvy')).state === 'incomplete', 'deleting a professional category removes its answers AND the assessment decision about them');
  await save(v, 'tech_savvy', ANS('again'));
  ok((await cat(v, 'tech_savvy')).state === 'pending_assessment', 're-answering after deletion starts over as pending assessment (the old decision is gone)');
  const d3 = await del(v);
  ok(d3.deleted_answers === 2 && (await my(v)).participation_ready === false, 'delete_my_experience() with no category removes everything');
  ok((await my(v)).ai_consent.granted === true, 'deleting answers does not silently change the consent');
  ok((await q('select count(*)::int n from public.experience_answers where user_id=$1', [v]))[0].n === 0, 'nothing of mine is left in the answers table');
  ok(J(await del(v)) === J({ deleted_answers: 0, deleted_decisions: 0 }), 'deleting twice is harmless');
  ok(await failsWith(() => del(v, 'wizards'), 'invalid_category'), 'an unknown category is refused');
  // my profile removal does not leak answers to anybody else
  const w = await ready(['students_learners']);
  await as(w, () => q('select public.delete_my_tester_profile()'));
  ok((await my(w)).participation_ready === false && (await st(w)).students_learners === 'inactive', 'removing the tester profile deactivates the categories (the answers stay mine until I delete them)');
  // account deletion cascades
  const x = await ready(['students_learners']);
  await consent(x, true);
  await db.query('delete from auth.users where id = $1', [x]);
  ok((await q('select (select count(*)::int from public.experience_answers where user_id=$1) a, (select count(*)::int from public.ai_consents where user_id=$1) c', [x]))[0].a === 0, 'deleting the anonymous account cascades to answers and consent');
}

console.log('\n[10. question version changes]');
{
  const u = await ready(['students_learners', 'tech_savvy']);
  await consent(u, true);
  await decide(u, 'tech_savvy', 'qualified');
  const { id: tgt } = await fresh('targeted', ['tech_savvy'], 'Tech only');
  await startOf(u, tgt);
  const old = (await aiProfile(u)).categories.find((c) => c.category === 'tech_savvy');
  // publish version 2 of the students questions and of the tech questions
  for (const c of ['students_learners', 'tech_savvy']) {
    await q(`insert into public.experience_questions (category, version, position, qid, prompt, hint) select category, 2, position, qid, prompt || ' (v2)', hint from public.experience_questions where category=$1 and version=1`, [c]);
  }
  const s = await cat(u, 'students_learners');
  ok(s.state === 'incomplete' && s.reason === 'questions_changed' && s.answers_version === 1 && s.question_version === 2, 'a new question version makes older answers outdated: the category is incomplete (questions_changed)');
  ok((await my(u)).participation_ready === false, 'and participation readiness is lost until the answers are updated');
  const gq = (await as(u, () => q("select public.get_experience_questions('students_learners') r")))[0].r;
  ok(gq.version === 2 && gq.outdated === true && gq.answers.q1 && gq.questions[0].prompt.endsWith('(v2)'), 'the UI gets the new questions plus the previous answers to review (prefill)');
  ok((await cat(u, 'tech_savvy')).state === 'incomplete', 'a professional category with outdated answers is incomplete as well: the old decision no longer counts');
  ok((await elig(u, tgt)).eligible === true && (await elig(u, tgt)).reason === 'in_progress', 'but the in-progress reservation is untouched');
  ok(await failsWith(() => svc(() => q('select public.service_record_qualification($1,$2,$3,$4,$5,null)', [u, 'tech_savvy', 1, old.answers_hash, 'qualified'])), 'stale_assessment'), 'a decision for the old question version is refused');
  const r = await save(u, 'students_learners', ANS('v2'));
  ok(r.state === 'active' && r.answers_version === 2, 'answering the new version re-activates the general category');
  const rt = await save(u, 'tech_savvy', ANS('v2'));
  ok(rt.state === 'pending_assessment' && rt.answers_version === 2, 'and puts the professional one into assessment again (a new decision is needed)');
  const p = (await aiProfile(u)).categories.find((c) => c.category === 'tech_savvy');
  ok(p.question_version === 2 && p.answers_version === 2 && p.answers_hash !== old.answers_hash && p.answers[0].question.endsWith('(v2)'), 'the AI contract carries the question version and the question text that was actually answered');
  await decide(u, 'tech_savvy', 'qualified');
  ok((await cat(u, 'tech_savvy')).state === 'active', 'a decision for the new version activates it');
}

console.log('\n[11. consent and the AI data contract]');
{
  const u = await mk();
  await profile(u, ['tech_savvy', 'students_learners'], 'Rita', 'I am a QA engineer who also studies design');
  await save(u, 'students_learners', ANS('design'));
  await save(u, 'tech_savvy', ANS('qa'));
  ok((await my(u)).ai_consent.granted === false && (await my(u)).ai_consent.updated_at === null, 'consent defaults to NOT granted');
  const none = await aiProfile(u);
  ok(none.consent.ai_processing === false && none.profile.bio === null && none.subject_ref === null && none.categories.every((c) => c.answers === null), 'without consent the AI interface returns NO bio, NO answers and NO subject_ref');
  ok(none.categories.find((c) => c.category === 'tech_savvy').state === 'pending_assessment' && none.participation_ready === true, 'only non-sensitive status fields are present');
  const c1 = await consent(u, true);
  ok(c1.granted === true && c1.policy_version === 1, 'consent can be granted');
  const p1 = await aiProfile(u);
  ok(/^[0-9a-f-]{36}$/.test(p1.subject_ref) && p1.subject_ref !== u, 'subject_ref is an opaque identifier, not the account id');
  ok(p1.profile.bio === 'I am a QA engineer who also studies design' && J(p1.profile.categories) === '["tech_savvy","students_learners"]', 'with consent the bio and the selected categories are included');
  const ts = p1.categories.find((c) => c.category === 'tech_savvy');
  ok(ts.answers.length === 4 && ts.answers[0].question_id === 'q1' && ts.answers[0].question.startsWith('What technologies, tools or software do you have experience using?') && ts.answers[0].question.endsWith('(v2)') && ts.answers_version === 2 && ts.answers[0].answer.includes('qa'), 'answers come with their question id and the exact question text of the version that was answered');
  ok(J(Object.keys(p1)) === J(['contract_version', 'subject_ref', 'consent', 'profile', 'categories', 'active_categories', 'participation_ready', 'updated_at', 'etag']) || J(Object.keys(p1).sort()) === J(['active_categories', 'categories', 'consent', 'contract_version', 'etag', 'participation_ready', 'profile', 'subject_ref', 'updated_at'].sort()), 'top-level contract keys are exactly the documented ones');
  ok(J(p1.categories.map((c) => c.category)) === J(ALL) && p1.categories.every((c) => J(Object.keys(c).sort()) === J(['answers', 'answers_complete', 'answers_hash', 'answers_updated_at', 'answers_version', 'category', 'kind', 'qualification', 'question_version', 'selected', 'state'].sort())), 'five categories in canonical order, each with exactly the documented keys');
  ok(p1.categories.find((c) => c.category === 'tech_savvy').kind === 'professional' && p1.categories.find((c) => c.category === 'students_learners').kind === 'general' && p1.contract_version === 1, 'kind and contract_version are present');
  ok(/^[0-9a-f]{64}$/.test(p1.etag) && (await aiProfile(u)).etag === p1.etag, 'etag is a stable sha256 cache key');
  // etag changes for everything an AI result can depend on
  const e0 = p1.etag;
  await save(u, 'students_learners', ANS('design2'));
  const e1 = (await aiProfile(u)).etag;
  await profile(u, ['tech_savvy', 'students_learners'], 'Rita', 'A changed bio');
  const e2 = (await aiProfile(u)).etag;
  await profile(u, ['tech_savvy'], 'Rita', 'A changed bio');
  const e3 = (await aiProfile(u)).etag;
  await decide(u, 'tech_savvy', 'qualified');
  const e4 = (await aiProfile(u)).etag;
  await consent(u, false);
  const e5 = (await aiProfile(u)).etag;
  ok(new Set([e0, e1, e2, e3, e4, e5]).size === 6, 'etag changes when answers, bio, categories, a decision or consent change');
  await profile(u, ['tech_savvy'], 'Renamed', 'A changed bio');
  ok((await aiProfile(u)).etag === e5, 'but not for a nickname change (the nickname is not part of the contract)');
  ok(!JSON.stringify(await aiProfile(u)).includes('Renamed') && !JSON.stringify(p1).includes('Rita'), 'the nickname never appears in the AI contract');
  // subject_ref rotation
  const ref1 = p1.subject_ref;
  await consent(u, true);
  const ref2 = (await aiProfile(u)).subject_ref;
  ok(ref2 !== ref1, 'granting consent again after a withdrawal issues a NEW subject_ref');
  await consent(u, true);
  ok((await aiProfile(u)).subject_ref === ref2, 'but repeating a grant does not rotate it');
  ok((await aiProfile(u)).consent.updated_at !== null && (await svc(() => q('select public.service_get_ai_profile($1) r', ['00000000-0000-0000-0000-00000000ffff'])))[0].r === null, 'an unknown user id returns null');
  ok(await failsWith(() => as(u, () => q('select public.set_ai_consent(null)')), 'invalid_consent'), 'null consent is refused');
  // other users never see my answers
  const spy = await ready(['students_learners']);
  const sq = (await as(spy, () => q("select public.get_experience_questions('tech_savvy') r")))[0].r;
  ok(sq.answers === null && !JSON.stringify(await my(spy)).includes('qa'), 'another tester only ever sees their own answers');
  ok(!JSON.stringify(await my(u)).includes(ANS('qa').q1), 'get_my_experience never contains answer text');
  ok(JSON.stringify(await feed(spy)).includes('qa') === false, 'public listings never contain tester answers');
}

console.log('\n[12. the eligibility listing for the recommendation service]');
{
  const u = await ready(['students_learners', 'tech_savvy']);
  await consent(u, true);
  const camps = [];
  camps.push((await fresh('open', [], 'Open A')).id);
  camps.push((await fresh('open', ['tech_savvy'], 'Open prefers tech')).id);
  camps.push((await fresh('targeted', ['students_learners'], 'Targeted students')).id);
  camps.push((await fresh('targeted', ['tech_savvy'], 'Targeted tech (pending)')).id);
  camps.push((await fresh('targeted', ['business_office'], 'Targeted business (no category)')).id);
  const own = await createV2(u, 'open', [], 'Mine'); // u has 1 credit
  const rows = await svc(() => q('select * from public.service_list_eligible_campaigns($1)', [u]));
  const ids = rows.map((r) => r.campaign_id);
  ok(ids.includes(camps[0]) && ids.includes(camps[1]) && ids.includes(camps[2]), 'eligible open and targeted campaigns are listed');
  ok(!ids.includes(camps[3]) && !ids.includes(camps[4]), 'a targeted campaign the tester cannot reserve (pending / missing category) is NEVER listed');
  ok(!ids.includes(own), 'nor their own campaign');
  const mine = await feed(u);
  ok(J([...ids].sort()) === J(mine.filter((r) => r.eligible).map((r) => r.campaign_id).sort()), 'PARITY: the service list equals the eligible rows of list_campaigns_v2');
  ok(Object.keys(rows[0]).includes('task_description') && !Object.keys(rows[0]).includes('project_url') && !JSON.stringify(rows).includes('https://example.com'), 'campaign descriptions are included, the project URL never is');
  ok(rows.find((r) => r.campaign_id === camps[2]).testing_mode === 'targeted' && J(rows.find((r) => r.campaign_id === camps[2]).match_categories) === '["students_learners"]', 'testing_mode and the ACTIVE-category match are included');
  const newbie = await mk();
  ok((await svc(() => q('select * from public.service_list_eligible_campaigns($1)', [newbie]))).length === 0, 'a tester without a completed profile gets an empty list');
  await decide(u, 'tech_savvy', 'qualified');
  ok((await svc(() => q('select * from public.service_list_eligible_campaigns($1)', [u]))).some((r) => r.campaign_id === camps[3]), 'after qualification the tech campaign appears');
}

console.log('\n[13. hardening found by the security review]');
{
  // MEDIUM-1: deleting answers must not reset the save limit (otherwise assessments could be re-rolled without bound)
  const u = await ready(['tech_savvy']);
  await consent(u, true);
  for (let i = 2; i <= 5; i++) { await del(u, 'tech_savvy'); await save(u, 'tech_savvy', ANS('reroll' + i)); }
  await del(u, 'tech_savvy');
  ok(await failsWith(() => save(u, 'tech_savvy', ANS('reroll6')), 'experience_rate_limited'), 'delete + save cannot reset the limit: the 6th save within 24 h is refused even after deleting the answers');
  ok((await as(u, () => q("select public.get_experience_questions('tech_savvy') r")))[0].r.saves_left === 0, 'and the remaining saves are reported correctly after a deletion');
  ok((await q('select count(*)::int n from public.experience_answers where user_id=$1 and category=$2', [u, 'tech_savvy']))[0].n === 0, 'a refused save writes nothing');
  ok((await q('select window_saves w from public.experience_save_limits where user_id=$1 and category=$2', [u, 'tech_savvy']))[0].w === 5, 'the counter lives in its own table, untouched by delete_my_experience');
  ok(await failsWith(() => as(u, () => q('select * from public.experience_save_limits')), 'permission denied'), 'and that table is locked like the others');
  await q(`update public.experience_save_limits set window_started_at = now() - interval '25 hours' where user_id=$1`, [u]);
  ok((await save(u, 'tech_savvy', ANS('later'))).state === 'pending_assessment', 'after the 24 h window saving works again');

  // MEDIUM-2: answers of categories that are not (or no longer) in the profile are never handed to the AI service
  const w = await ready(['students_learners', 'tech_savvy']);
  await consent(w, true);
  ok((await aiProfile(w)).categories.filter((c) => c.answers !== null).length === 2, 'both selected categories expose their answers (consented)');
  await profile(w, ['students_learners']);
  const p1 = await aiProfile(w);
  ok(p1.categories.find((c) => c.category === 'tech_savvy').answers === null && p1.categories.find((c) => c.category === 'tech_savvy').selected === false && p1.categories.find((c) => c.category === 'students_learners').answers !== null, 'deselecting a category stops its answers from being exposed');
  await as(w, () => q('select public.delete_my_tester_profile()'));
  const p2 = await aiProfile(w);
  ok(p2.profile === null && p2.categories.every((c) => c.answers === null) && p2.participation_ready === false, 'after removing the tester profile NO answers and no bio are exposed');
  ok(!JSON.stringify(p2).includes('students_learners tools') && !JSON.stringify(p2).includes(ANS('students_learners').q1), 'and the answer text is nowhere in the payload');
  await profile(w, ['students_learners']);
  ok((await aiProfile(w)).categories.find((c) => c.category === 'students_learners').answers !== null, 're-adding the category exposes the stored answers again (the owner can delete them at any time)');

  // LOW-4: the hash is injective over the field boundaries
  const h = (a) => q('select public.experience_hash(1, $1::jsonb) h', [JSON.stringify(a)]).then((r) => r[0].h);
  ok((await h({ q1: 'a|b', q2: 'c', q3: 'd', q4: 'e' })) !== (await h({ q1: 'a', q2: 'b|c', q3: 'd', q4: 'e' })), 'moving text across field boundaries changes the hash');
  ok((await h({ q1: 'ab', q2: 'c', q3: 'd', q4: 'e' })) !== (await h({ q1: 'a', q2: 'bc', q3: 'd', q4: 'e' })), '... also without a separator character');
  ok((await h({ q1: 'a', q2: 'b', q3: 'c', q4: 'd' })) === (await h({ q1: 'a', q2: 'b', q3: 'c', q4: 'd' })), 'and it is deterministic');

  // LOW-5: an oversized answer is refused before any expensive processing
  const t0 = Date.now();
  const big = await detail(() => save(u, 'students_learners', { ...ANS('x'), q1: 'word '.repeat(60000) }));
  ok(big === 'q1:too_long' && Date.now() - t0 < 5000, 'a 300 kB answer is refused immediately (q1:too_long)');

  // LOW-7: the eligibility listing for the AI service only works for testers who consented
  const c = await ready(['students_learners']);
  await fresh('open', [], 'Some open task');
  ok((await svc(() => q('select * from public.service_list_eligible_campaigns($1)', [c]))).length === 0, 'without consent the eligibility listing is empty');
  await consent(c, true);
  ok((await svc(() => q('select * from public.service_list_eligible_campaigns($1)', [c]))).length >= 1, 'with consent it lists the eligible campaigns');

  // etag covers subject_ref rotation
  const r = await ready(['students_learners']);
  await consent(r, true);
  const e1 = (await aiProfile(r)).etag;
  await consent(r, false); await consent(r, true);
  ok((await aiProfile(r)).etag !== e1 && (await aiProfile(r)).subject_ref !== null, 'a withdraw-then-regrant rotates subject_ref AND changes the etag (no stale cache of the old reference)');

  // a half-published question version must not lock everybody out
  const k = await ready(['everyday_nontechnical']);
  await q(`insert into public.experience_questions (category, version, position, qid, prompt, hint) select category, 2, position, qid, prompt || ' (v2)', null from public.experience_questions where category='everyday_nontechnical' and version=1 and position <= 2`);
  ok((await q("select public.experience_current_version('everyday_nontechnical') v"))[0].v === 1 && (await my(k)).participation_ready === true, 'a new version with fewer than four questions is ignored: nobody loses access');
  await q(`insert into public.experience_questions (category, version, position, qid, prompt, hint) select category, 2, position, qid, prompt || ' (v2)', null from public.experience_questions where category='everyday_nontechnical' and version=1 and position > 2`);
  ok((await q("select public.experience_current_version('everyday_nontechnical') v"))[0].v === 2 && (await my(k)).participation_ready === false, 'once all four exist it becomes current (and answers must be reviewed)');

  // the fast set-based active-category query must equal the per-category state for EVERY identity in this suite
  const bad = (await q(`select t.user_id from public.tester_profiles t
    where public.active_tester_categories(t.user_id) is distinct from
      array(select c.id from unnest(array['tech_savvy','founders_builders','business_office','students_learners','everyday_nontechnical']) with ordinality as c(id, ord) where public.category_state(t.user_id, c.id) = 'active' order by c.ord)`)).length;
  ok(bad === 0, 'active_tester_categories equals category_state = active for every identity created by this suite (equivalence of the optimised query)');
}

console.log('\n[14. contract check: legacy passes are inert, consent withdrawal stops every AI path, erasure is signalled]');
{
  // --- legacy multiple-choice passes can never activate a professional category or bypass the assessment ---
  const L = await mk();
  await profile(L, ['tech_savvy']);
  // a REAL earlier pass, as migration 7 would have recorded it (inserted as the table owner)
  await q(`insert into public.screening_attempts (user_id, category, version, passed, areas) values ($1,'tech_savvy',1,true,4)`, [L]);
  ok((await cat(L, 'tech_savvy')).state === 'incomplete', 'an earlier multiple-choice pass does not activate or even complete anything');
  await save(L, 'tech_savvy', ANS('legacy'));
  ok((await cat(L, 'tech_savvy')).state === 'pending_assessment' && J((await my(L)).active_categories) === '[]', 'with four answers the category is PENDING assessment: the old pass gives no shortcut');
  ok((await q('select count(*)::int n from public.category_qualifications where user_id=$1', [L]))[0].n === 0, 'and no qualification row was created for it');
  const { id: lt } = await fresh('targeted', ['tech_savvy'], 'Tech only (legacy tester)');
  ok((await elig(L, lt)).reason === 'qualification_required' && await failsWith(() => startOf(L, lt), 'not_eligible'), 'the server still refuses the targeted task');
  ok(await failsWith(() => as(L, () => q("select public.submit_screening('tech_savvy', '{}')")), 'screening_replaced'), 'the old submit cannot create a new pass either');
  ok((await q(`select count(*)::int n from pg_constraint where conrelid='public.category_qualifications'::regclass and pg_get_constraintdef(oid) like '%legacy%'`))[0].n === 0, 'the qualification table cannot even represent a legacy source');
  ok(await failsWith(() => q(`insert into public.category_qualifications (user_id, category, status, source, question_version, answers_hash) values ('${L}','tech_savvy','qualified','legacy_screening',0,null)`), 'violates'), 'a legacy-sourced decision is rejected by the table constraints');

  // --- consent withdrawal stops every AI path ---
  const W = await ready(['tech_savvy', 'students_learners'], 'Wanda');
  await consent(W, true);
  await fresh('open', [], 'Open for the AI listing');
  const before = await aiProfile(W);
  ok(before.subject_ref !== null && before.profile.bio !== null && before.categories.some((c) => c.answers !== null), 'with consent the AI interface hands out the bio, answers and subject_ref');
  ok((await svc(() => q('select * from public.service_list_pending_assessments(200)'))).some((x) => x.user_id === W) && (await svc(() => q('select * from public.service_list_eligible_campaigns($1)', [W]))).length >= 1, 'and the tester is in the assessment queue and gets an eligibility listing');
  await consent(W, false);
  const after = await aiProfile(W);
  ok(after.consent.ai_processing === false && after.subject_ref === null && after.profile.bio === null && after.categories.every((c) => c.answers === null), 'after withdrawal the profile contains NO bio, NO answers and NO subject_ref');
  ok(!(await svc(() => q('select * from public.service_list_pending_assessments(200)'))).some((x) => x.user_id === W), 'the tester leaves the assessment queue');
  ok((await svc(() => q('select * from public.service_list_eligible_campaigns($1)', [W]))).length === 0, 'the recommendation listing is empty (no recommendations without consent)');
  ok(await failsWith(() => decide(W, 'tech_savvy', 'qualified'), 'consent_required'), 'no assessment decision can be recorded');
  ok((await my(W)).ai_consent.granted === false, 'and the browser sees consent as OFF (Discover then asks for permission instead of calling the AI service)');

  // --- erasure signals ---
  const ev = (since = 0) => svc(() => q('select * from public.service_list_erasure_events($1, 1000)', [since]));
  const base = (await ev()).reduce((m, e) => Math.max(m, Number(e.id)), 0);
  const R = await ready(['students_learners', 'tech_savvy'], 'Rae');
  ok((await ev(base)).length === 0, 'no consent ever given: nothing was processed, so nothing to erase and no event');
  await consent(R, true);
  const refR = (await aiProfile(R)).subject_ref;
  await consent(R, false);
  let e1 = await ev(base);
  ok(e1.length === 1 && e1[0].reason === 'consent_withdrawn' && e1[0].subject_ref === refR && e1[0].category === null, 'withdrawing consent logs ONE event for the subject_ref that was in use');
  await consent(R, false);
  ok((await ev(base)).length === 1, 'repeating the withdrawal logs nothing new');
  await consent(R, true);
  const refR2 = (await aiProfile(R)).subject_ref;
  await del(R, 'tech_savvy');
  e1 = await ev(base);
  ok(e1.length === 2 && e1[1].reason === 'answers_deleted' && e1[1].subject_ref === refR2 && e1[1].category === 'tech_savvy', 'deleting a category answers logs an event with the category for the CURRENT subject_ref');
  await del(R);
  ok((await ev(base)).length === 3 && (await ev(base))[2].category === null, 'deleting everything logs an all-categories event');
  await del(R);
  ok((await ev(base)).length === 3, 'deleting nothing logs nothing');
  await as(R, () => q('select public.delete_my_tester_profile()'));
  e1 = await ev(base);
  ok(e1.length === 4 && e1[3].reason === 'profile_removed' && e1[3].subject_ref === refR2, 'removing the tester profile (bio gone) logs an event');
  await db.query('delete from auth.users where id = $1', [R]);
  e1 = await ev(base);
  ok(e1.length === 5 && e1[4].reason === 'account_deleted' && e1[4].subject_ref === refR2, 'deleting the account logs an event');
  ok(Object.keys(e1[0]).sort().join() === 'category,created_at,id,reason,subject_ref', 'events carry only opaque references, never an account id or text');
  ok(JSON.stringify(e1).includes(R) === false, 'the account id appears nowhere in the events');
  const page = await svc(() => q('select * from public.service_list_erasure_events($1, 2)', [base]));
  ok(page.length === 2 && Number(page[0].id) < Number(page[1].id), 'events are paged by an increasing cursor with a limit');
  ok(await failsWith(() => as(R === null ? L : L, () => q('select * from public.service_list_erasure_events(0, 10)')), 'permission denied') && await failsWith(() => as(null, () => q('select * from public.service_list_erasure_events(0, 10)')), 'permission denied'), 'clients cannot read the erasure log');
  ok(await failsWith(() => as(L, () => q('select * from public.ai_erasure_events')), 'permission denied'), 'and the table is locked like the others');
  for (const sig of ['public.log_erasure_on_profile_removed()', 'public.log_erasure_on_consent_row_deleted()']) {
    const r = (await q(`select has_function_privilege('anon','${sig}','execute') a, has_function_privilege('authenticated','${sig}','execute') u, has_function_privilege('public','${sig}','execute') p`))[0];
    ok(!r.a && !r.u && !r.p, `${sig}: not executable by clients`);
  }
  const rs = (await q(`select has_function_privilege('anon','public.service_list_erasure_events(bigint,integer)','execute') a, has_function_privilege('authenticated','public.service_list_erasure_events(bigint,integer)','execute') u, has_function_privilege('public','public.service_list_erasure_events(bigint,integer)','execute') p, has_function_privilege('service_role','public.service_list_erasure_events(bigint,integer)','execute') s`))[0];
  ok(!rs.a && !rs.u && !rs.p && rs.s, 'service_list_erasure_events: service_role only');
}

summary();
