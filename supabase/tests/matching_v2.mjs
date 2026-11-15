// Matching v2 (migration 20261115000200): Open vs Targeted testing, server-side eligibility, category screening.
// Real Postgres (PGlite) + the real migration files. Same limits as the other suites (single connection: no true
// parallel races; the advisory lock / row locks are covered by the real-project scripts).

import { createHarness, uid } from './harness.mjs';

const { db, as, q, ok, failsWith, fails, counts } = await createHarness({ quiet: true });

const TASK = 'Find the pricing page and tell me which plan you would pick.';
const FB = { friction: 'The pricing link was hidden in the footer.', suggestion: 'Add a pricing link to the top nav.' };
const ALL = ['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical'];
const PRO = ['tech_savvy', 'founders_builders', 'business_office'];
const GENERAL = ['students_learners', 'everyday_nontechnical'];
// Answers that clear the screening (2 of 4 areas) / fall one area short.
const PASS = {
  tech_savvy: { q1: ['code', 'terminal'], q2: ['git'], q3: ['none'], q4: ['none'] },
  founders_builders: { q1: ['launch'], q2: ['spec', 'metrics'], q3: ['none'], q4: ['none'] },
  business_office: { q1: ['finance', 'sales'], q2: ['sheets'], q3: ['none'], q4: ['none'] },
};
const FAIL = (c) => ({ q1: [{ tech_savvy: 'code', founders_builders: 'launch', business_office: 'finance' }[c]], q2: ['none'], q3: ['none'], q4: ['none'] });

let nextId = 1;
async function mk() {
  const id = uid(nextId++);
  await db.query('insert into auth.users (id) values ($1)', [id]);
  await as(id, () => q('select * from public.ensure_profile()'));
  return id;
}
const bal = async (u) => (await as(u, () => q('select credit_balance from public.profiles')))[0].credit_balance;
const profile = (u, cats, nick = 'Tester') => as(u, () => q('select * from public.save_tester_profile($1,$2,$3)', [nick, 'bio', cats]));
const screen = (u, cat, answers) => as(u, () => q('select public.submit_screening($1,$2::jsonb) r', [cat, JSON.stringify(answers)])).then((r) => r[0].r);
const pass = (u, cat) => screen(u, cat, PASS[cat]);
const elig = async (u, camp) => (await as(u, () => q('select public.get_campaign_eligibility($1) r', [camp])))[0].r;
const startOf = (u, camp) => as(u, () => q('select public.start_test($1) r', [camp]));
const reservations = (camp, u) => q('select * from public.test_reservations where campaign_id=$1 and tester_id=$2', [camp, u]);
const createV2 = async (owner, mode, cats, name = 'V2 task') => (await as(owner, () => q('select public.create_campaign_v2($1,$2,$3,$4,$5,$6) id', [name, 'https://example.com', 'd', TASK, mode, cats])))[0].id;
const fresh = async (mode, cats, name) => { const f = await mk(); return { owner: f, id: await createV2(f, mode, cats, name) }; };
const mode = async (camp) => (await q('select testing_mode m, target_categories t from public.campaigns where id=$1', [camp]))[0];
async function failDetail(fn) { try { await fn(); return null; } catch (e) { return { message: String(e.message), detail: e.detail ?? null }; } }
const age = (u, cat, hours) => q(`update public.screening_attempts set created_at = created_at - make_interval(hours => $3) where user_id=$1 and category=$2`, [u, cat, hours]);
const finish = async (u, camp) => {
  // only first_started_at moves (the 60 s minimum is measured from it): rewriting started_at would legitimately re-run the eligibility trigger
  await q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds' where tester_id=$1 and campaign_id=$2`, [u, camp]);
  return (await as(u, () => q('select public.submit_test($1,true,$2,$3,4,false) r', [camp, FB.friction, FB.suggestion])))[0].r;
};

console.log('\n[privileges: nothing here is a back door]');
const U = await mk();
const V = await mk();
const NEWRPC = [
  "select public.create_campaign_v2('Nm','https://example.com','d','" + TASK + "','open','{}')",
  'select * from public.list_campaigns_v2()',
  "select public.get_campaign_eligibility('00000000-0000-0000-0000-00000000ffff')",
  "select public.get_screening('tech_savvy')",
  "select public.submit_screening('tech_savvy','{}')",
  'select public.get_my_screening_status()',
];
for (const call of NEWRPC) ok(await failsWith(() => as(null, () => q(call)), 'permission denied'), `anon denied: ${call.slice(0, 52)}`);
for (const call of ["select public.category_requires_screening('tech_savvy')", "select public.screening_current_version('tech_savvy')", `select public.is_screened('${U}','tech_savvy')`, `select * from public.tester_eligibility('${U}','targeted','{tech_savvy}')`]) {
  ok(await failsWith(() => as(U, () => q(call)), 'permission denied'), `internal helper not callable by clients: ${call.slice(0, 50)}`);
}
for (const t of ['screening_versions', 'screening_questions', 'screening_attempts']) {
  ok(await failsWith(() => as(U, () => q(`select * from public.${t}`)), 'permission denied'), `authenticated cannot read ${t}`);
  ok(await failsWith(() => as(U, () => q(`delete from public.${t}`)), 'permission denied'), `authenticated cannot delete from ${t}`);
  ok((await q(`select relrowsecurity r, (select count(*)::int from pg_policies where tablename='${t}') p from pg_class where oid='public.${t}'::regclass`))[0].r === true, `RLS is on for ${t}`);
}
ok(await failsWith(() => as(U, () => q(`insert into public.screening_attempts (user_id, category, version, passed, areas) values ('${U}','tech_savvy',1,true,4)`)), 'permission denied'), 'a screening pass cannot be forged with a direct INSERT');
const oc = await createV2(U, 'open', []);
ok(await failsWith(() => as(U, () => q(`update public.campaigns set testing_mode='targeted' where id='${oc}'`)), 'permission denied'), 'an owner cannot flip a campaign mode with a plain UPDATE');
ok(await failsWith(() => as(V, () => q(`insert into public.test_reservations (campaign_id, tester_id, expires_at) values ('${oc}','${V}', now() + interval '1 hour')`)), 'permission denied'), 'reservations cannot be inserted directly by clients');
ok((await q(`select count(*)::int n from pg_trigger where tgname='test_reservations_eligibility' and not tgisinternal`))[0].n === 1, 'the eligibility trigger is installed on test_reservations');

console.log('\n[backward compatibility: nothing existing becomes restricted]');
{
  const legacyOwner = await mk();
  const legacy = (await as(legacyOwner, () => q('select public.create_project_with_campaign($1,$2,$3,$4) id', ['Legacy', 'https://example.com', 'd', TASK])))[0].id;
  ok((await mode(legacy)).m === 'open', 'a campaign created with the original RPC is OPEN');
  const v1Owner = await mk();
  const v1 = (await as(v1Owner, () => q('select public.create_targeted_campaign($1,$2,$3,$4,$5) id', ['V1 preferred', 'https://example.com', 'd', TASK, ['tech_savvy', 'founders_builders']])))[0].id;
  const m1 = await mode(v1);
  ok(m1.m === 'open' && m1.t.join() === 'tech_savvy,founders_builders', 'a Matching-v1 campaign (preferred categories) stays OPEN and keeps its preferred categories');
  const nobody = await mk(); // no profile at all
  const r1 = await startOf(nobody, v1);
  ok(!!r1[0].r.reservation_expires_at, 'an unprofiled, unscreened tester can still start the v1 "preferred categories" campaign (nothing is silently restricted)');
  const r2 = await startOf(await mk(), legacy);
  ok(!!r2[0].r.reservation_expires_at, 'and the legacy campaign');
  ok((await as(await mk(), () => q('select public.get_campaign_eligibility($1) r', [v1])))[0].r.eligible === true, 'get_campaign_eligibility says eligible / open for the v1 campaign');
  ok((await q(`select count(*)::int n from public.campaigns where testing_mode <> 'open'`))[0].n === 0, 'no campaign is targeted unless create_campaign_v2 made it so');
}

console.log('\n[create_campaign_v2]');
{
  const a = await mk();
  const open1 = await createV2(a, 'open', ['students_learners', 'tech_savvy', 'tech_savvy']);
  const m = await mode(open1);
  ok(m.m === 'open' && m.t.join() === 'tech_savvy,students_learners', 'open mode stores the PREFERRED categories (canonical, de-duplicated) and stays open');
  ok((await bal(a)) === 0 && (await q(`select count(*)::int n from public.credit_ledger where campaign_id=$1 and reason='campaign_spend'`, [open1]))[0].n === 1, 'one credit spent, one ledger row');
  const b = await mk();
  ok((await mode(await createV2(b, 'open', []))).t.length === 0, 'open mode with no categories is plain open testing');
  const c = await mk();
  const tgt = await createV2(c, 'targeted', ['business_office', 'students_learners']);
  const mt = await mode(tgt);
  ok(mt.m === 'targeted' && mt.t.join() === 'business_office,students_learners', 'targeted mode stores the REQUIRED categories');
  const e = await mk();
  const cBefore = (await q('select count(*)::int n from public.campaigns'))[0].n;
  for (const [label, args, code] of [
    ['targeted without categories', ['targeted', []], 'targeted_requires_categories'],
    ['targeted with NULL categories', ['targeted', null], 'targeted_requires_categories'],
    ['unknown mode', ['restricted', ['tech_savvy']], 'invalid_mode'],
    ['NULL mode', [null, ['tech_savvy']], 'invalid_mode'],
    ['unknown category', ['targeted', ['wizards']], 'invalid_categories'],
    ['wrong-case mode', ['Targeted', ['tech_savvy']], 'invalid_mode'],
  ]) {
    ok(await failsWith(() => createV2(e, ...args), code), `rejected: ${label} -> ${code}`);
  }
  ok((await bal(e)) === 1 && (await q('select count(*)::int n from public.campaigns'))[0].n === cBefore, 'rejected requests spend nothing and create nothing (validated before any credit moves)');
  ok(await failsWith(() => as(e, () => q("select public.create_campaign_v2('x','https://example.com','d',$1,'open','{}')", [TASK])), 'invalid_name'), 'the underlying validation still applies');
  ok((await bal(e)) === 1, 'and still spends nothing');
  const broke = await mk();
  await createV2(broke, 'open', []);
  ok(await failsWith(() => createV2(broke, 'targeted', ['tech_savvy']), 'insufficient_credits'), 'insufficient credits is still enforced');
  ok(await failsWith(() => q(`update public.campaigns set testing_mode='targeted', target_categories='{}' where id=$1`, [open1]), 'campaigns_targeted_requires_categories'), 'the table CHECK independently forbids a targeted campaign with no categories');
  ok(await failsWith(() => q(`update public.campaigns set testing_mode='private' where id=$1`, [open1]), 'campaigns_testing_mode_check'), 'and unknown modes');
}

console.log('\n[eligibility matrix: all five categories, four kinds of tester each]');
for (const C of ALL) {
  const isPro = PRO.includes(C);
  const otherCat = C === 'students_learners' ? 'everyday_nontechnical' : 'students_learners';

  const none = await mk();
  const mism = await mk();
  const match = await mk();
  const screened = await mk();
  await profile(mism, [otherCat]);
  await profile(match, [C]);
  await profile(screened, [C]);
  if (isPro) await pass(screened, C);

  const cases = [
    ['no profile', none, false, 'no_profile'],
    ['profile without the category', mism, false, 'category_mismatch'],
    [isPro ? 'category chosen, NOT screened' : 'category chosen (no screening needed)', match, !isPro, isPro ? 'screening_required' : 'eligible'],
    [isPro ? 'category chosen AND screened' : 'category chosen (second tester)', screened, true, 'eligible'],
  ];
  for (const [label, tester, expectOk, reason] of cases) {
    const { id: camp, owner } = await fresh('targeted', [C], `T ${C}`);
    const e = await elig(tester, camp);
    ok(e.eligible === expectOk && e.reason === reason, `[${C}] ${label}: eligibility = ${expectOk} / ${reason}`, JSON.stringify(e));
    const balBefore = await bal(tester);
    if (expectOk) {
      const r = await startOf(tester, camp);
      ok(!!r[0].r.reservation_expires_at && (await reservations(camp, tester)).length === 1, `[${C}] ${label}: start_test reserves`);
    } else {
      const f = await failDetail(() => startOf(tester, camp));
      ok(f && /not_eligible/.test(f.message) && f.detail === reason, `[${C}] ${label}: start_test REFUSED by the server (not_eligible / ${reason})`, JSON.stringify(f));
      ok((await reservations(camp, tester)).length === 0 && (await bal(tester)) === balBefore, `[${C}] ${label}: no reservation row, credits untouched`);
      if (reason === 'screening_required') ok(JSON.stringify(e.missing_screening) === JSON.stringify([C]), `[${C}] the response says which screening unlocks it`);
    }
  }
}

console.log('\n[several required categories = "at least one"]');
{
  const { id: camp } = await fresh('targeted', ['tech_savvy', 'students_learners'], 'Two required');
  const techOnly = await mk(); await profile(techOnly, ['tech_savvy']);
  const studentsOnly = await mk(); await profile(studentsOnly, ['students_learners']);
  const both = await mk(); await profile(both, ['tech_savvy', 'students_learners']);
  const techScreened = await mk(); await profile(techScreened, ['tech_savvy']); await pass(techScreened, 'tech_savvy');
  const e1 = await elig(techOnly, camp);
  ok(e1.eligible === false && e1.reason === 'screening_required' && e1.missing_screening.join() === 'tech_savvy', 'only an UNSCREENED professional category matches: not eligible, tech screening required');
  ok((await elig(studentsOnly, camp)).eligible === true, 'a general category match alone is enough');
  const eb = await elig(both, camp);
  ok(eb.eligible === true && eb.reason === 'eligible', 'a tester with both is eligible via the general category even without screening');
  ok((await elig(techScreened, camp)).eligible === true, 'a screened professional match is enough');
  const fm = await mk(); await profile(fm, ['founders_builders', 'business_office']);
  const e2 = await elig(fm, (await fresh('targeted', ['founders_builders', 'business_office'], 'Two pro')).id);
  ok(e2.eligible === false && e2.missing_screening.join() === 'founders_builders,business_office', 'two unscreened professional matches: both screenings are listed');
  await pass(fm, 'business_office');
  ok((await elig(fm, (await fresh('targeted', ['founders_builders', 'business_office'], 'Two pro b')).id)).eligible === true, 'passing ONE of the matching screenings is enough');
}

console.log('\n[screening content and rules]');
{
  const t = await mk();
  for (const cat of PRO) {
    const s = (await as(t, () => q('select public.get_screening($1) r', [cat])))[0].r;
    ok(s.category === cat && s.version === 1 && s.min_areas === 2 && s.max_attempts === 3 && s.attempts_left === 3 && s.qualified === false, `[${cat}] get_screening: version, threshold, attempts, not qualified`);
    ok(s.questions.length === 4 && s.questions.every((x) => /^q[1-4]$/.test(x.id) && x.prompt.length >= 10 && x.options.length >= 4 && x.options.at(-1).id === 'none'), `[${cat}] 4 questions, each with options ending in "None of these"`);
    ok(s.questions.every((x) => x.options.every((o) => typeof o.id === 'string' && typeof o.label === 'string' && o.label.length > 3)), `[${cat}] options are id + label only (no scoring data leaks to the client)`);
  }
  for (const cat of [...GENERAL, 'nope', null]) {
    ok(await failsWith(() => as(t, () => q('select public.get_screening($1)', [cat])), 'screening_not_required'), `get_screening(${cat}) -> screening_not_required`);
    ok(await failsWith(() => as(t, () => q('select public.submit_screening($1,$2::jsonb)', [cat, '{}'])), 'screening_not_required'), `submit_screening(${cat}) -> screening_not_required`);
  }
  // malformed answers never consume an attempt
  const base = PASS.tech_savvy;
  const bad = [
    ['missing question', { q1: ['code'], q2: ['git'], q3: ['docs'] }],
    ['extra question', { ...base, q5: ['x'] }],
    ['unknown option', { ...base, q1: ['telepathy'] }],
    ['"none" mixed with another', { ...base, q1: ['none', 'code'] }],
    ['duplicate option', { ...base, q1: ['code', 'code'] }],
    ['empty answer', { ...base, q1: [] }],
    ['answer is not an array', { ...base, q1: 'code' }],
    ['non-string element', { ...base, q1: [1] }],
    ['wrong question ids', { a: ['code'], b: ['git'], c: ['docs'], d: ['qa'] }],
    ['an array instead of an object', []],
    ['JSON null', null],
  ];
  for (const [label, ans] of bad) {
    ok(await failsWith(() => as(t, () => q('select public.submit_screening($1,$2::jsonb)', ['tech_savvy', ans === null ? null : JSON.stringify(ans)])), 'invalid_answers'), `invalid_answers: ${label}`);
  }
  const st0 = (await as(t, () => q('select public.get_my_screening_status() r')))[0].r.find((x) => x.category === 'tech_savvy');
  ok(st0.attempts_left === 3 && st0.qualified === false, 'malformed submissions consumed no attempt');

  // fail, fail, fail -> rate limited; time passes -> allowed again
  const f1 = await screen(t, 'tech_savvy', FAIL('tech_savvy'));
  ok(f1.passed === false && f1.areas === 1 && f1.min_areas === 2 && f1.attempts_left === 2, 'a 1-area answer set does not pass (1 of 2 needed), 2 attempts left');
  const f2 = await screen(t, 'tech_savvy', { q1: ['none'], q2: ['none'], q3: ['none'], q4: ['none'] });
  ok(f2.passed === false && f2.areas === 0 && f2.attempts_left === 1, 'all "none" -> not passed');
  const f3 = await screen(t, 'tech_savvy', FAIL('tech_savvy'));
  ok(f3.attempts_left === 0, 'third attempt uses the last slot');
  const lim = await failDetail(() => screen(t, 'tech_savvy', PASS.tech_savvy));
  ok(lim && /screening_rate_limited/.test(lim.message) && !!lim.detail, 'a 4th attempt inside 24 h is refused with the time the next slot opens', JSON.stringify(lim));
  ok((await as(t, () => q('select public.get_my_screening_status() r')))[0].r.find((x) => x.category === 'tech_savvy').next_attempt_at !== null, 'the status shows when the next attempt opens');
  ok(await failsWith(() => screen(t, 'tech_savvy', FAIL('tech_savvy')), 'screening_rate_limited'), 'even a wrong answer set is refused while limited');
  ok((await q(`select count(*)::int n from public.screening_attempts where user_id=$1 and category='tech_savvy'`, [t]))[0].n === 3, 'rate-limited calls are not recorded as attempts');
  await age(t, 'tech_savvy', 25);
  const retry = await screen(t, 'tech_savvy', PASS.tech_savvy);
  ok(retry.passed === true && retry.areas >= 2, 'after 24 h the tester can retake and pass');
  ok(await failsWith(() => screen(t, 'tech_savvy', PASS.tech_savvy), 'already_screened'), 'a screened tester cannot re-submit at the same version');
  const stat = (await as(t, () => q('select public.get_my_screening_status() r')))[0].r;
  const byCat = Object.fromEntries(stat.map((x) => [x.category, x]));
  ok(byCat.tech_savvy.qualified === true && byCat.tech_savvy.qualified_at && byCat.founders_builders.qualified === false && byCat.business_office.qualified === false, 'status: only the screened category is marked qualified');
  const cols = (await q(`select column_name from information_schema.columns where table_name='screening_attempts' order by ordinal_position`)).map((r) => r.column_name).join();
  ok(cols === 'id,user_id,category,version,passed,areas,created_at', 'only the OUTCOME is stored: no answers column exists', cols);
  const stranger = await mk();
  ok((await q('select count(*)::int n from public.screening_attempts where user_id = $1', [stranger]))[0].n === 0, 'an identity that never screened has no attempt rows');
  ok((await as(stranger, () => q('select public.get_my_screening_status() r')))[0].r.every((x) => x.qualified === false && x.attempts_left === 3), "another identity's status is independent (nothing of mine is visible)");
  // category isolation
  await profile(t, ['founders_builders']);
  const { id: foundersCamp } = await fresh('targeted', ['founders_builders'], 'Founders only');
  ok((await elig(t, foundersCamp)).reason === 'screening_required', 'a tech screening does NOT unlock a founders campaign');
  ok(await failsWith(() => screen(t, 'founders_builders', { ...PASS.founders_builders, q1: ['code'] }), 'invalid_answers'), "answers are validated against THAT category's own options (tech ids are not founders ids)");
}

console.log('\n[screening versions]');
{
  const t = await mk();
  await profile(t, ['business_office']);
  await pass(t, 'business_office');
  const { id: camp } = await fresh('targeted', ['business_office'], 'Business only');
  ok((await elig(t, camp)).eligible === true, 'screened at version 1 -> eligible');
  // publish version 2 of the business screening (same questions, new version row)
  await q(`insert into public.screening_versions (category, version, min_areas) values ('business_office', 2, 2)`);
  await q(`insert into public.screening_questions (category, version, qid, position, prompt, options) select category, 2, qid, position, prompt, options from public.screening_questions where category='business_office' and version=1`);
  ok((await elig(t, camp)).reason === 'screening_required', 'a new screening VERSION requires a fresh screening: eligibility is lost until re-screened');
  const s2 = (await as(t, () => q('select public.get_screening($1) r', ['business_office'])))[0].r;
  ok(s2.version === 2 && s2.qualified === false, 'get_screening serves the current version and shows not qualified');
  const r2 = await pass(t, 'business_office');
  ok(r2.passed === true && r2.version === 2, 'passing the new version restores eligibility');
  ok((await elig(t, camp)).eligible === true, 'eligible again');
  ok((await q(`select count(*)::int n from public.screening_attempts where user_id=$1 and category='business_office'`, [t]))[0].n === 2 && (await q(`select array_agg(distinct version order by version) v from public.screening_attempts where user_id=$1`, [t]))[0].v.join() === '1,2', 'attempts are recorded per version');
}

console.log('\n[profile changes cannot bypass eligibility]');
{
  const { id: techCamp } = await fresh('targeted', ['tech_savvy'], 'Tech only');
  const t = await mk();
  await profile(t, ['tech_savvy']);
  ok((await elig(t, techCamp)).eligible === false, 'adding a professional category to the profile does not make a tester eligible');
  ok(await failsWith(() => startOf(t, techCamp), 'not_eligible'), 'and the server refuses the reservation');
  await profile(t, ['tech_savvy', 'students_learners', 'everyday_nontechnical', 'founders_builders', 'business_office']);
  ok((await elig(t, techCamp)).eligible === false, 'ticking ALL five categories still does not unlock a professional-only campaign');
  ok(await failsWith(() => startOf(t, techCamp), 'not_eligible'), 'reservation still refused');
  await pass(t, 'tech_savvy');
  ok((await elig(t, techCamp)).eligible === true, 'only the screening unlocks it');
  await profile(t, ['students_learners']);
  const e = await elig(t, techCamp);
  ok(e.eligible === false && e.reason === 'category_mismatch', 'removing the category from the profile removes eligibility (screening alone is not enough)');
  ok(await failsWith(() => startOf(t, techCamp), 'not_eligible'), 'reservation refused');
  await profile(t, ['tech_savvy']);
  ok((await elig(t, techCamp)).eligible === true, 're-adding the category restores it (the screening persists)');
  await as(t, () => q('select public.delete_my_tester_profile()'));
  ok((await elig(t, techCamp)).reason === 'no_profile', 'deleting the profile removes eligibility');
  // general categories are self-declared by design
  const { id: stuCamp } = await fresh('targeted', ['students_learners'], 'Students only');
  const s = await mk();
  ok((await elig(s, stuCamp)).reason === 'no_profile', 'a general-category campaign still needs the category in the profile');
  await profile(s, ['students_learners']);
  ok((await elig(s, stuCamp)).eligible === true, 'a general category needs no screening (by product design)');
  ok((await q(`select count(*)::int n from public.screening_attempts where user_id=$1`, [s]))[0].n === 0, 'and no screening rows were involved');
}

console.log('\n[in-progress tests survive profile edits; the database trigger is the last line of defence]');
{
  const { id: camp, owner } = await fresh('targeted', ['tech_savvy'], 'In progress');
  const t = await mk();
  await profile(t, ['tech_savvy']);
  await pass(t, 'tech_savvy');
  const r1 = (await startOf(t, camp))[0].r;
  ok(!!r1.reservation_expires_at, 'eligible tester reserves');
  await profile(t, ['everyday_nontechnical']); // profile edited mid-session: no longer matches
  const r2 = (await startOf(t, camp))[0].r;
  ok(r2.reservation_expires_at === r1.reservation_expires_at, 'start_test (page reload / Continue) still returns the SAME live reservation after the profile edit');
  ok((await elig(t, camp)).eligible === true && (await elig(t, camp)).reason === 'in_progress', 'the eligibility endpoint reports in_progress for the holder');
  const balBefore = await bal(t);
  const sub = await finish(t, camp);
  ok(sub.credits_awarded === 1 && (await bal(t)) === balBefore + 1, 'the in-progress test completes and awards exactly 1 credit');
  ok((await q('select status from public.campaigns where id=$1', [camp]))[0].status === 'completed', 'the campaign completes normally');

  // a reservation that LAPSED: re-reserving is a new window -> eligibility is checked again
  const { id: camp2 } = await fresh('targeted', ['tech_savvy'], 'Lapse');
  await profile(t, ['tech_savvy']);
  await startOf(t, camp2);
  await q(`update public.test_reservations set expires_at = now() - interval '1 minute', started_at = now() - interval '16 minutes', first_started_at = now() - interval '16 minutes' where tester_id=$1 and campaign_id=$2`, [t, camp2]);
  await profile(t, ['students_learners']);
  ok(await failsWith(() => startOf(t, camp2), 'not_eligible'), 'a LAPSED reservation cannot be re-reserved after the tester stopped matching');
  await profile(t, ['tech_savvy']);
  const re = (await startOf(t, camp2))[0].r;
  ok(!!re.reservation_expires_at && (await reservations(camp2, t))[0].starts === 2, 'but can be re-reserved while still eligible (starts = 2)');

  // ineligible tester: no reservation -> cannot submit
  const { id: camp3 } = await fresh('targeted', ['business_office'], 'No bypass');
  const x = await mk();
  await profile(x, ['business_office']);
  ok(await failsWith(() => as(x, () => q('select public.submit_test($1,true,$2,$3,4,false)', [camp3, FB.friction, FB.suggestion])), 'reservation_required'), 'submit_test without a reservation is refused (no way around start_test)');
  ok((await bal(x)) === 1 && (await q('select count(*)::int n from public.test_submissions where campaign_id=$1', [camp3]))[0].n === 0, 'no feedback recorded, no reward');
  // defence in depth: even a direct write by the owner role is stopped by the trigger
  const f = await failDetail(() => q(`insert into public.test_reservations (campaign_id, tester_id, expires_at) values ($1,$2, now() + interval '15 minutes')`, [camp3, x]));
  ok(f && /not_eligible/.test(f.message) && f.detail === 'screening_required', 'a reservation row cannot be created for an ineligible tester by ANY code path (trigger)', JSON.stringify(f));
  // consuming / settling reservations never re-checks
  ok((await q(`select count(*)::int n from public.test_reservations where campaign_id=$1`, [camp3]))[0].n === 0, 'sanity: nothing was inserted');
}

console.log('\n[Discover v2: Recommended / Eligible / Not Eligible]');
const h2 = await createHarness({ quiet: true });
{
  const { db: d2, as: as2, q: q2, ok: ok2 } = h2;
  let n2 = 1;
  const mk2 = async () => { const id = uid(n2++); await d2.query('insert into auth.users (id) values ($1)', [id]); await as2(id, () => q2('select * from public.ensure_profile()')); return id; };
  const camp2 = async (mode2, cats, minutesOld, name) => {
    const owner = await mk2();
    const id = (await as2(owner, () => q2('select public.create_campaign_v2($1,$2,$3,$4,$5,$6) id', [name, 'https://example.com', 'd', TASK, mode2, cats])))[0].id;
    await q2(`update public.campaigns set created_at = now() - make_interval(mins => $2), expires_at = now() - make_interval(mins => $2) + interval '7 days' where id = $1`, [id, minutesOld]);
    return id;
  };
  const feed2 = (u) => as2(u, () => q2('select * from public.list_campaigns_v2()'));
  const names = (rows) => rows.map((r) => r.project_name);

  const T = await mk2();
  await as2(T, () => q2("select * from public.save_tester_profile('Tess','b','{students_learners}')"));
  const A = await camp2('open', [], 60, 'A open plain');
  const B = await camp2('open', ['students_learners'], 50, 'B open prefers students');
  const C = await camp2('targeted', ['students_learners'], 40, 'C targeted students');
  const D = await camp2('targeted', ['tech_savvy'], 30, 'D targeted tech');
  const E = await camp2('targeted', ['tech_savvy', 'students_learners'], 20, 'E targeted tech+students');
  const F = await camp2('open', ['tech_savvy'], 10, 'F open prefers tech');

  let f = await feed2(T);
  const fit = Object.fromEntries(f.map((r) => [r.project_name[0], r.fit]));
  ok2((fit.B === 'recommended' && fit.C === 'recommended' && fit.E === 'recommended' && fit.A === 'eligible' && fit.F === 'eligible' && fit.D === 'not_eligible'), 'fit: recommended / eligible / not_eligible as specified', JSON.stringify(fit));
  ok2(JSON.stringify(names(f)) === JSON.stringify(['B open prefers students', 'C targeted students', 'E targeted tech+students', 'A open plain', 'F open prefers tech', 'D targeted tech']), 'order: recommended first (oldest first among equals), then eligible, then not eligible last', JSON.stringify(names(f)));
  const rowD = f.find((r) => r.campaign_id === D);
  ok2(rowD.eligible === false && rowD.ineligible_reason === 'category_mismatch' && rowD.testing_mode === 'targeted' && rowD.target_categories.join() === 'tech_savvy', 'a not-eligible task is still LISTED (viewable) with mode, required categories and the reason');
  const rowE = f.find((r) => r.campaign_id === E);
  ok2(rowE.eligible === true && rowE.ineligible_reason === null && rowE.match_categories.join() === 'students_learners' && rowE.missing_screening.length === 0, 'an eligible task has no reason and shows only MY overlapping categories');
  ok2(f.find((r) => r.campaign_id === A).fit === 'eligible' && f.find((r) => r.campaign_id === F).match_categories.length === 0, 'open tasks without overlap are plain "eligible"');
  ok2(f.length === 6, 'nothing is hidden: all six open tasks are returned');

  // unscreened professional tester
  const P = await mk2();
  await as2(P, () => q2("select * from public.save_tester_profile('Pat','b','{tech_savvy}')"));
  f = await feed2(P);
  const dP = f.find((r) => r.campaign_id === D);
  ok2(dP.fit === 'not_eligible' && dP.ineligible_reason === 'screening_required' && dP.missing_screening.join() === 'tech_savvy', 'an unscreened professional sees the tech task as not eligible: screening_required + which screening');
  const rank = (r) => ({ recommended: 0, eligible: 1, not_eligible: 2 })[r.fit];
  ok2(f.every((r, i) => i === 0 || rank(f[i - 1]) <= rank(r)), 'tasks are ordered recommended -> eligible -> not eligible');
  await as2(P, () => q2('select public.submit_screening($1,$2::jsonb)', ['tech_savvy', JSON.stringify(PASS.tech_savvy)]));
  f = await feed2(P);
  ok2(f.find((r) => r.campaign_id === D).fit === 'recommended' && f.find((r) => r.campaign_id === E).fit === 'recommended', 'after screening, the tech tasks become Recommended');
  ok2(JSON.stringify(names(f)) === JSON.stringify(['D targeted tech', 'E targeted tech+students', 'F open prefers tech', 'A open plain', 'B open prefers students', 'C targeted students']), 'after screening: recommended (D, E, F) first, then eligible (A, B), the mismatched targeted task last', JSON.stringify(names(f)));

  // no profile
  const N = await mk2();
  f = await feed2(N);
  ok2(f.filter((r) => r.fit === 'not_eligible').map((r) => r.project_name).sort().join() === 'C targeted students,D targeted tech,E targeted tech+students' && f.every((r) => r.fit !== 'recommended'), 'no profile: open tasks eligible, every targeted task not eligible (no_profile), nothing recommended');
  ok2(f.filter((r) => r.fit === 'not_eligible').every((r) => r.ineligible_reason === 'no_profile'), 'reason = no_profile');
  ok2(JSON.stringify(names(f).slice(0, 3)) === JSON.stringify(['A open plain', 'B open prefers students', 'F open prefers tech']), 'open tasks first in the old oldest-first order');

  // parity with the existing feeds: the SAME rows are visible (v2 only adds flags)
  let parity = true;
  for (const u of [T, P, N]) {
    const a = (await feed2(u)).map((r) => r.campaign_id).sort();
    const b = (await as2(u, () => q2('select campaign_id from public.list_open_campaigns()'))).map((r) => r.campaign_id).sort();
    const c = (await as2(u, () => q2('select campaign_id from public.list_matched_campaigns()'))).map((r) => r.campaign_id).sort();
    if (JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(a) !== JSON.stringify(c)) parity = false;
  }
  ok2(parity, 'list_campaigns_v2 shows exactly the rows list_open_campaigns and list_matched_campaigns show (v1 UI keeps working)');

  // visibility rules unchanged
  const ownerOfC = (await q2('select owner_id from public.campaigns where id=$1', [C]))[0].owner_id;
  ok2(!(await feed2(ownerOfC)).some((r) => r.campaign_id === C), 'you never see your own campaign');
  await as2(T, () => q2('select public.start_test($1)', [B]));
  const fT = await feed2(T);
  ok2(fT[0].campaign_id === B && fT[0].reserved_by_me === true, 'my own live reservation is first');
  ok2(!(await feed2(P)).some((r) => r.campaign_id === B), "a task reserved by someone else disappears from other testers' feeds");
  const stale = await camp2('targeted', ['students_learners'], 9 * 24 * 60, 'stale');
  ok2(!(await feed2(T)).some((r) => r.campaign_id === stale), 'an expired campaign is not listed');
  // reservation holder who loses eligibility keeps seeing the task as eligible (in progress)
  await as2(T, () => q2("select * from public.save_tester_profile('Tess','b','{}')"));
  const held = (await feed2(T)).find((r) => r.campaign_id === B);
  ok2(held && held.eligible === true && held.reserved_by_me === true, 'an in-progress reservation stays valid in the feed after a profile edit');

  // limit 50 applied AFTER ordering
  const L = await mk2();
  await as2(L, () => q2("select * from public.save_tester_profile('Lee','b','{business_office}')"));
  for (let i = 0; i < 52; i++) await camp2('open', [], 1000 + i, 'filler ' + i);
  const needle = await camp2('targeted', ['business_office', 'students_learners'], 1, 'needle');
  await as2(L, () => q2('select public.submit_screening($1,$2::jsonb)', ['business_office', JSON.stringify(PASS.business_office)]));
  const top = await feed2(L);
  ok2(top.length === 50 && top[0].campaign_id === needle && top[0].fit === 'recommended', 'a recommended task newer than 50 others is still first (limit applies after ordering)');
}

console.log('\n[credit / reward regression with targeted tasks]');
{
  const T = await mk();
  await profile(T, ['students_learners']);
  const owners = [];
  let rewards = 0;
  for (let i = 0; i < 5; i++) {
    const { id, owner } = await fresh('targeted', ['students_learners'], 'Cap ' + i);
    owners.push(owner);
    await startOf(T, id);
    const r = await finish(T, id);
    rewards += r.credits_awarded;
  }
  ok(rewards === 5 && (await bal(T)) === 6, 'five eligible targeted tests award 1 credit each');
  const { id: sixth } = await fresh('targeted', ['students_learners'], 'Cap 6');
  ok(await failsWith(() => startOf(T, sixth), 'daily_limit'), 'the 5-per-24h reward cap still applies to targeted tasks');
  const { id: own } = await fresh('targeted', ['students_learners'], 'Own');
  const owner = (await q('select owner_id from public.campaigns where id=$1', [own]))[0].owner_id;
  await profile(owner, ['students_learners']);
  ok(await failsWith(() => startOf(owner, own), 'own_campaign'), 'you can never test your own campaign, targeted or not');
  const ledger = (await q('select coalesce(sum(delta),0)::int s from public.credit_ledger'))[0].s;
  const bals = (await q('select coalesce(sum(credit_balance),0)::int s from public.profiles'))[0].s;
  ok(ledger === bals, `credit conservation: ledger sum ${ledger} = balances ${bals}`);
  // cancelling a targeted campaign nobody tested refunds exactly once
  const { id: cc, owner: co } = await fresh('targeted', ['business_office'], 'Cancel me');
  const bBefore = await bal(co);
  const c1 = (await as(co, () => q('select public.cancel_campaign($1) r', [cc])))[0].r;
  ok(c1.refunded === true && (await bal(co)) === bBefore + 1, 'cancelling an untouched targeted campaign refunds 1 credit');
  await fails(() => as(co, () => q('select public.cancel_campaign($1)', [cc])));
  ok((await bal(co)) === bBefore + 1 && (await q(`select count(*)::int n from public.credit_ledger where campaign_id=$1 and reason='campaign_refund'`, [cc]))[0].n === 1, 'and a second cancel never refunds again (one refund row)');
}

const a = counts(), b = h2.counts();
console.log(`\n${a.passed + b.passed} passed, ${a.failed + b.failed} failed`);
process.exit(a.failed + b.failed ? 1 : 0);
