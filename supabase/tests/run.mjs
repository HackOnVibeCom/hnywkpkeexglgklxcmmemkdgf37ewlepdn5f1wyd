// Executes the real migration files in real Postgres (PGlite) and asserts the
// security/atomicity guarantees of the MVP core (starter credit, spend, reward, RLS, privileges).
// The lifecycle / anti-abuse guarantees (expiry, reservations, refunds, caps) are in lifecycle.mjs.
// Shared setup + limits: see harness.mjs.

import { createHarness } from './harness.mjs';

const { db, as, q, ok, fails, failsWith, summary } = await createHarness();

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
for (const u of [A, B, C]) await db.query('insert into auth.users (id) values ($1)', [u]);

const GOOD_URL = 'https://example.com/app';
const TASK = 'Find the pricing page and tell me which plan you would pick.';
const FEEDBACK = { friction: 'The pricing link was hidden in the footer.', suggestion: 'Add a pricing link to the top nav.' };

console.log('\n[anon role]');
ok(await failsWith(() => as(null, () => q('select * from public.profiles')), 'permission denied'), 'anon cannot read profiles');
ok(await failsWith(() => as(null, () => q('select public.ensure_profile()')), 'permission denied'), 'anon cannot call ensure_profile');
ok(await failsWith(() => as(null, () => q('select * from public.list_open_campaigns()')), 'permission denied'), 'anon cannot list campaigns');

console.log('\n[starter credit]');
const p1 = await as(A, () => q('select * from public.ensure_profile()'));
ok(p1[0].credit_balance === 1, 'first ensure_profile grants balance 1');
await as(A, () => q('select * from public.ensure_profile()'));
await as(A, () => q('select * from public.ensure_profile()'));
const starters = await q(`select count(*)::int n from public.credit_ledger where user_id=$1 and reason='starter'`, [A]);
ok(starters[0].n === 1, 'repeated ensure_profile -> exactly one starter ledger row');
ok((await as(A, () => q('select credit_balance from public.profiles')))[0].credit_balance === 1, 'balance still 1 after repeats');
ok(await failsWith(() => q(`insert into public.credit_ledger (user_id, delta, reason) values ($1, 1, 'starter')`, [A]), 'credit_ledger_one_starter'), 'unique index blocks a 2nd starter row (backstop)');
await db.exec('set role authenticated');
await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
ok(await failsWith(() => q('select public.ensure_profile()'), 'not_authenticated'), 'authenticated role without a JWT subject is rejected');
await db.exec('reset role');

console.log('\n[no direct writes from clients]');
for (const [name, sql] of [
  ['insert profile', `insert into public.profiles (id, credit_balance) values ('${C}', 100)`],
  ['update own balance', `update public.profiles set credit_balance = 999`],
  ['insert ledger', `insert into public.credit_ledger (user_id, delta, reason) values ('${A}', 5, 'test_reward')`],
  ['insert project', `insert into public.projects (owner_id, name, url) values ('${A}', 'xx', '${GOOD_URL}')`],
  ['insert submission', `insert into public.test_submissions (campaign_id, tester_id, task_completed, friction, suggestion, ux_rating) values (gen_random_uuid(), '${A}', true, 'aaaaaaaaaa', 'bbbbbbbbbb', 5)`],
  ['delete ledger', `delete from public.credit_ledger`],
]) {
  ok(await failsWith(() => as(A, () => q(sql)), 'permission denied'), `authenticated cannot ${name}`);
}

console.log('\n[create campaign: validation + spend]');
const create = (uid, o = {}) => as(uid, () => q(
  'select public.create_project_with_campaign($1,$2,$3,$4) as id',
  [o.name ?? 'Acme', o.url ?? GOOD_URL, o.desc ?? 'A thing', o.task ?? TASK]));
for (const bad of ['http://localhost:3000', 'http://127.0.0.1', 'javascript:alert(1)', 'ftp://example.com', 'https://user:pw@example.com', 'https://nodot', 'https://exa mple.com', 'data:text/html,hi', 'http://10.0.0.1/x']) {
  ok(await failsWith(() => create(A, { url: bad }), 'invalid_url'), `rejects url ${bad}`);
}
ok(await failsWith(() => create(A, { name: 'x' }), 'invalid_name'), 'rejects 1-char name');
ok(await failsWith(() => create(A, { task: 'too short' }), 'invalid_task'), 'rejects short task');
ok((await as(A, () => q('select credit_balance from public.profiles')))[0].credit_balance === 1, 'failed creates do not spend credit');
ok(await failsWith(() => create(B), 'profile_missing'), 'identity without profile cannot create');

const camp = (await create(A))[0].id;
ok(typeof camp === 'string', 'create succeeds with 1 credit');
ok((await as(A, () => q('select credit_balance from public.profiles')))[0].credit_balance === 0, 'balance is 0 after spending');
ok(await failsWith(() => create(A), 'insufficient_credits'), 'second create fails: insufficient_credits');
ok((await q('select count(*)::int n from public.projects'))[0].n === 1, 'failed create left no orphan project row');

console.log('\n[RLS read isolation]');
await as(B, () => q('select * from public.ensure_profile()'));
await as(C, () => q('select * from public.ensure_profile()'));
ok((await as(B, () => q('select * from public.campaigns'))).length === 0, "B cannot read A's campaigns table");
ok((await as(B, () => q('select * from public.projects'))).length === 0, "B cannot read A's projects table");
ok((await as(A, () => q('select * from public.projects'))).length === 1, 'A reads own project');
ok((await as(B, () => q('select * from public.profiles'))).length === 1, 'B sees only own profile row');
ok((await as(B, () => q('select * from public.credit_ledger'))).every((r) => r.user_id === B), 'B sees only own ledger rows');

console.log('\n[discovery]');
ok((await as(A, () => q('select * from public.list_open_campaigns()'))).length === 0, "owner does not see own campaign in feed");
const feed = await as(B, () => q('select * from public.list_open_campaigns()'));
ok(feed.length === 1 && feed[0].campaign_id === camp, 'other user sees the open campaign');
ok(!('project_url' in feed[0]) && !('owner_id' in feed[0]), 'feed leaks neither url nor owner id');
ok((await as(B, () => q('select * from public.get_campaign_for_test($1)', [camp])))[0].project_url === null, 'test page RPC hides the url until the tester reserves the task');
await as(B, () => q('select public.start_test($1)', [camp]));
ok((await as(B, () => q('select * from public.get_campaign_for_test($1)', [camp])))[0].project_url === GOOD_URL, 'test page RPC returns url to the tester holding a reservation');
ok((await as(A, () => q('select * from public.get_campaign_for_test($1)', [camp]))).length === 0, 'owner cannot fetch own campaign for testing');

console.log('\n[submit_test]');
// Since migration 4, submit_test needs a live reservation and >= 60 s of testing time. This helper
// satisfies that gate (reserve, then age the reservation 61 s) so the original MVP-core assertions
// below still exercise submit_test's own rules. start_test errors are swallowed on purpose: when the
// campaign is own/closed/unknown, submit_test must produce the error under test. Any unconsumed
// reservation is dropped afterwards so one test cannot leak a live reservation into the next.
// (The gate itself is tested in lifecycle.mjs.)
const submit = async (uid, o = {}) => {
  const id = o.id ?? camp;
  await as(uid, () => q('select public.start_test($1)', [id])).catch(() => null);
  await q(`update public.test_reservations
              set first_started_at = first_started_at - interval '61 seconds',
                  started_at = started_at - interval '61 seconds'
            where tester_id = $1 and campaign_id = $2 and consumed_at is null`, [uid, id]);
  try {
    return await as(uid, () => q(
      'select public.submit_test($1,$2,$3,$4,$5,$6) as r',
      [id, o.done ?? true, o.friction ?? FEEDBACK.friction, o.suggestion ?? FEEDBACK.suggestion, o.rating ?? 4, o.consent ?? false]));
  } finally {
    await q('delete from public.test_reservations where tester_id = $1 and consumed_at is null', [uid]);
  }
};
ok(await failsWith(() => submit(A), 'own_campaign'), 'owner cannot test own project');
ok(await failsWith(() => submit(B, { friction: 'short' }), 'invalid_feedback'), 'rejects too-short friction');
ok(await failsWith(() => submit(B, { rating: 6 }), 'invalid_rating'), 'rejects rating 6');
ok(await failsWith(() => submit(B, { rating: 0 }), 'invalid_rating'), 'rejects rating 0');
ok(await failsWith(() => submit(B, { id: '11111111-1111-1111-1111-111111111111' }), 'campaign_not_found'), 'unknown campaign rejected');
ok((await as(B, () => q('select credit_balance from public.profiles')))[0].credit_balance === 1, 'rejected submits award nothing');

const res = (await submit(B))[0].r;
ok(res.credits_awarded === 1 && res.balance === 2, 'valid submit awards 1 credit (starter 1 -> 2)');
ok((await q('select status, response_count from public.campaigns where id=$1', [camp]))[0].status === 'completed', 'one-response campaign becomes completed');
ok(await failsWith(() => submit(B), 'already_tested'), 'same tester cannot be rewarded twice (a retry is told it was already recorded)');
ok(await failsWith(() => submit(C), 'campaign_closed'), 'second tester loses the race: campaign_closed, no credit');
ok((await as(C, () => q('select credit_balance from public.profiles')))[0].credit_balance === 1, 'losing tester balance unchanged');
ok(await failsWith(() => q(`insert into public.credit_ledger (user_id, delta, reason, campaign_id) values ($1, 1, 'test_reward', $2)`, [B, camp]), 'credit_ledger_one_reward'), 'unique index blocks duplicate reward (backstop)');
ok(await failsWith(() => q(`insert into public.test_submissions (campaign_id, tester_id, task_completed, friction, suggestion, ux_rating) values ($1,$2,true,'aaaaaaaaaa','bbbbbbbbbb',3)`, [camp, B]), 'test_submissions_one_per_tester'), 'unique constraint: one submission per tester per campaign');
ok(await failsWith(() => q(`insert into public.test_submissions (campaign_id, tester_id, task_completed, friction, suggestion, ux_rating) values ($1,$2,true,'aaaaaaaaaa','bbbbbbbbbb',3)`, [camp, A]), 'own_campaign'), 'trigger blocks self-test even on a direct insert');
ok((await as(B, () => q('select * from public.list_open_campaigns()'))).length === 0, 'completed campaign leaves the feed');

console.log('\n[submission visibility]');
const subCols = 'id, campaign_id, task_completed, friction, suggestion, ux_rating, share_consent, created_at';
ok((await as(A, () => q(`select ${subCols} from public.test_submissions`))).length === 1, 'founder reads feedback on own campaign');
ok((await as(B, () => q(`select ${subCols} from public.test_submissions`))).length === 1, 'tester reads own submission');
ok((await as(C, () => q(`select ${subCols} from public.test_submissions`))).length === 0, 'unrelated user sees no submissions');
ok(await failsWith(() => as(A, () => q('select tester_id from public.test_submissions')), 'permission denied'), 'founder cannot read tester_id (testers stay anonymous)');
ok((await as(A, () => q(`select share_consent from public.test_submissions`)))[0].share_consent === false, 'share_consent defaults to false (private)');

console.log('\n[ledger invariants]');
const drift = await q(`
  select p.id, p.credit_balance, coalesce(sum(l.delta),0)::int as ledger_sum
  from public.profiles p left join public.credit_ledger l on l.user_id = p.id
  group by p.id having p.credit_balance <> coalesce(sum(l.delta),0)`);
ok(drift.length === 0, 'profiles.credit_balance == SUM(ledger) for every user', JSON.stringify(drift));
ok(await failsWith(() => q(`update public.profiles set credit_balance = -1 where id = $1`, [A]), 'credit_balance_check'), 'negative balance impossible');

// ───────────────────────── hardening added after security review ─────────────────────────
const D = '00000000-0000-0000-0000-00000000000d';
const E = '00000000-0000-0000-0000-00000000000e';
for (const u of [D, E]) { await db.query('insert into auth.users (id) values ($1)', [u]); await as(u, () => q('select * from public.ensure_profile()')); }

console.log('\n[whitespace-only input (btrim only strips spaces)]');
for (const [label, ws] of [['newlines', '\n'.repeat(30)], ['tabs', '\t'.repeat(30)], ['NBSP', ' '.repeat(30)], ['zero-width', '​'.repeat(30)], ['mixed', ' \n\t ​'.repeat(8)]]) {
  ok(await failsWith(() => create(D, { name: ws }), 'invalid_name'), `name of only ${label} rejected`);
  ok(await failsWith(() => create(D, { task: ws }), 'invalid_task'), `task of only ${label} rejected`);
}
const camp2 = (await create(D))[0].id; // D spends starter
for (const [label, ws] of [['newlines', '\n'.repeat(30)], ['NBSP', ' '.repeat(30)], ['zero-width', '​'.repeat(30)]]) {
  ok(await failsWith(() => submit(E, { id: camp2, friction: ws }), 'invalid_feedback'), `feedback of only ${label} rejected`);
}
ok(await failsWith(() => q(`insert into public.test_submissions (campaign_id, tester_id, task_completed, friction, suggestion, ux_rating) values ($1,$2,true,$3,'bbbbbbbbbb',3)`, [camp2, E, '\n'.repeat(20)]), 'test_submissions_friction_check'), 'table CHECK also rejects whitespace-only friction');
ok((await as(E, () => q('select credit_balance from public.profiles')))[0].credit_balance === 1, 'rejected whitespace feedback awarded nothing');

console.log('\n[boundaries]');
ok((await create(E, { name: 'ab', task: 'x'.repeat(20) }).catch(() => null)) !== null, 'min-length name (2) and task (20) accepted');
const F = '00000000-0000-0000-0000-00000000000f';
await db.query('insert into auth.users (id) values ($1)', [F]); await as(F, () => q('select * from public.ensure_profile()'));
ok(await failsWith(() => create(F, { name: 'a'.repeat(81) }), 'invalid_name'), 'name of 81 chars rejected');
ok(await failsWith(() => create(F, { task: 'x'.repeat(601) }), 'invalid_task'), 'task of 601 chars rejected');
ok(await failsWith(() => create(F, { desc: 'x'.repeat(501) }), 'invalid_description'), 'description of 501 chars rejected');
ok(await failsWith(() => create(F, { url: 'https://example.com/' + 'a'.repeat(2040) }), 'invalid_url'), 'url over 2048 chars rejected');
ok(await failsWith(() => submit(F, { id: camp2, friction: 'x'.repeat(2001) }), 'invalid_feedback'), 'feedback over 2000 chars rejected');
ok((await as(F, () => q('select credit_balance from public.profiles')))[0].credit_balance === 1, 'none of the rejected calls spent/earned credit');

console.log('\n[anon role: EVERY function and table]');
for (const call of [
  `select public.create_project_with_campaign('ab','${GOOD_URL}','', '${TASK}')`,
  `select public.submit_test('${camp2}', true, 'aaaaaaaaaa', 'bbbbbbbbbb', 3, false)`,
  `select * from public.get_campaign_for_test('${camp2}')`,
  `select public.is_valid_public_url('https://example.com')`,
  `select public.trim_all('x')`,
  `select * from public.projects`, `select * from public.campaigns`, `select * from public.credit_ledger`,
  `select id from public.test_submissions`,
]) ok(await failsWith(() => as(null, () => q(call)), 'permission denied'), `anon denied: ${call.slice(0, 60)}`);
ok(await failsWith(() => as(D, () => q(`select public.is_valid_public_url('https://example.com')`)), 'permission denied'), 'authenticated cannot call is_valid_public_url directly');
ok(await failsWith(() => as(D, () => q(`select public.trim_all('x')`)), 'permission denied'), 'authenticated cannot call trim_all directly');

console.log('\n[authenticated: UPDATE / DELETE / TRUNCATE / select *]');
for (const [name, sql] of [
  ['update projects', `update public.projects set name='hacked name'`],
  ['update campaigns', `update public.campaigns set status='open'`],
  ['update submissions', `update public.test_submissions set ux_rating=5`],
  ['update ledger', `update public.credit_ledger set delta=100`],
  ['delete projects', `delete from public.projects`],
  ['delete campaigns', `delete from public.campaigns`],
  ['delete submissions', `delete from public.test_submissions`],
  ['truncate ledger', `truncate public.credit_ledger`],
]) ok(await failsWith(() => as(D, () => q(sql)), 'permission denied'), `authenticated cannot ${name}`);
ok(await failsWith(() => as(A, () => q('select * from public.test_submissions')), 'permission denied'), 'select * on test_submissions is rejected (column grant)');
ok(await failsWith(() => as(A, () => q('select id from public.test_submissions where tester_id is not null')), 'permission denied'), 'filtering on tester_id is rejected');
ok(await failsWith(() => as(A, () => q('select id from public.test_submissions order by tester_id')), 'permission denied'), 'ordering by tester_id is rejected');

console.log('\n[consent + cross-user reads]');
const camp3 = (await create(F))[0].id; // F spends starter
const r3 = (await submit(E, { id: camp3, consent: true }))[0].r;
ok(r3.credits_awarded === 1, 'E earns a credit testing F');
ok((await as(F, () => q(`select share_consent from public.test_submissions where campaign_id='${camp3}'`)))[0].share_consent === true, 'share_consent=true is stored when the tester opts in');
ok((await as(D, () => q(`select id from public.test_submissions where campaign_id='${camp3}'`))).length === 0, "founder D cannot read founder F's feedback");
ok((await as(F, () => q(`select id from public.test_submissions where campaign_id='${camp2}'`))).length === 0, "founder F cannot read founder D's campaign feedback");
ok((await as(F, () => q(`select id from public.test_submissions`))).length === 1, 'F sees exactly their own campaign’s submission');
ok(await failsWith(() => submit(D, { id: camp2 }), 'own_campaign'), 'D still cannot test own campaign');

console.log('\n[future objects are not auto-exposed]');
await db.exec(`create table public.future_table (id int); create function public.future_fn() returns int language sql as $$ select 1 $$;`);
ok(await failsWith(() => as(D, () => q('select * from public.future_table')), 'permission denied'), 'new table is not readable by authenticated by default');
ok(await failsWith(() => as(null, () => q('select public.future_fn()')), 'permission denied'), 'new function is not executable by anon by default');
ok(await failsWith(() => as(D, () => q('select public.future_fn()')), 'permission denied'), 'new function is not executable by authenticated by default');

console.log('\n[ledger invariants after multi-user churn]');
const drift2 = await q(`
  select p.id from public.profiles p left join public.credit_ledger l on l.user_id = p.id
  group by p.id having p.credit_balance <> coalesce(sum(l.delta),0)`);
ok(drift2.length === 0, 'balance == SUM(ledger) for every user after all scenarios');
const supply = (await q(`select coalesce(sum(credit_balance),0)::int s, (select count(*)::int from public.profiles) n, (select count(*)::int from public.campaigns where status='open') o from public.profiles`))[0];
ok(supply.s + supply.o === supply.n, `credits are conserved: balances(${supply.s}) + open campaigns holding a credit(${supply.o}) == identities(${supply.n})`);

summary();
