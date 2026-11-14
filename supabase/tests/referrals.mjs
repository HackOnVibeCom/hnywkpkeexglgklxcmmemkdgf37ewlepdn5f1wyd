// Phase 2 tests: referral links (migration 20261114000200). Same limits as harness.mjs: PGlite is a single
// connection, so true parallelism (and the SKIP LOCKED paths) is covered by the real-project script.

import { createHarness, uid } from './harness.mjs';

const { db, as, q, ok, fails, failsWith, summary } = await createHarness();

const TASK = 'Find the pricing page and tell me which plan you would pick.';
const FB = { friction: 'The pricing link was hidden in the footer.', suggestion: 'Add a pricing link to the top nav.' };
let nextId = 1;
async function mk() {
  const id = uid(nextId++);
  await db.query('insert into auth.users (id) values ($1)', [id]);
  await as(id, () => q('select * from public.ensure_profile()'));
  return id;
}
const bal = async (u) => (await as(u, () => q('select credit_balance from public.profiles')))[0].credit_balance;
const codeOf = async (u) => (await as(u, () => q('select ref_code from public.profiles')))[0].ref_code;
const claim = async (u, code) => (await as(u, () => q('select public.claim_referral($1) r', [code])))[0].r;
const settleRef = async (u) => (await as(u, () => q('select public.settle_referral_rewards() n')))[0].n;
const mine = async (u) => (await as(u, () => q('select public.get_my_referrals() r')))[0].r;
const ledgerRows = (u, reason) => q('select * from public.credit_ledger where user_id=$1 and reason=$2', [u, reason]);
const create = async (u) => (await as(u, () => q('select public.create_project_with_campaign($1,$2,$3,$4) id', ['Ref test', 'https://example.com', 'd', TASK])))[0].id;
/** Honest completed test by `tester` on a fresh campaign of a fresh owner. */
async function completeTest(tester) {
  const owner = await mk();
  const camp = await create(owner);
  await as(tester, () => q('select public.start_test($1)', [camp]));
  await q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds', started_at = started_at - interval '61 seconds' where tester_id=$1 and campaign_id=$2`, [tester, camp]);
  await as(tester, () => q('select public.submit_test($1,true,$2,$3,4,false)', [camp, FB.friction, FB.suggestion]));
  return camp;
}

console.log('\n[ref_code]');
const R = await mk();
const codes = (await q('select ref_code from public.profiles')).map((r) => r.ref_code);
ok(codes.every((c) => /^[a-z0-9]{12}$/.test(c)), 'every identity has a 12-char lowercase alphanumeric code');
ok(new Set(codes).size === codes.length, 'codes are unique');
const codeR = await codeOf(R);
ok((await as(R, () => q('select ref_code from public.profiles'))).length === 1, 'a user reads only their own profile row (so only their own code)');
ok(await failsWith(() => q(`update public.profiles set ref_code = 'AB' where id = $1`, [R]), 'profiles_ref_code_format'), 'malformed code rejected by CHECK');
ok(await failsWith(() => as(R, () => q(`update public.profiles set ref_code = 'zzzzzzzzzzzz'`)), 'permission denied'), 'clients cannot choose their own code');

console.log('\n[privileges]');
for (const call of ["select public.claim_referral('abcdefabcdef')", 'select public.settle_referral_rewards()', 'select public.get_my_referrals()', 'select * from public.referrals']) {
  ok(await failsWith(() => as(null, () => q(call)), 'permission denied'), `anon denied: ${call}`);
}
ok(await failsWith(() => as(R, () => q('select * from public.referrals')), 'permission denied'), 'authenticated cannot read the referrals table at all');
ok(await failsWith(() => as(R, () => q(`insert into public.referrals (referee_id, referrer_id) values ('${R}', '${R}')`)), 'permission denied'), 'authenticated cannot insert referrals directly');
ok(await failsWith(() => as(R, () => q('select * from public.credit_ledger')), 'permission denied'), 'select * on the ledger is rejected (referee_id is not granted)');
ok(await failsWith(() => as(R, () => q('select referee_id from public.credit_ledger')), 'permission denied'), 'the invitee id column is not readable');
ok((await as(R, () => q('select id, user_id, delta, reason, campaign_id, created_at from public.credit_ledger'))).length >= 1, 'the explicit column list the app uses still works');
ok(await failsWith(() => as(R, () => q(`insert into public.credit_ledger (user_id, delta, reason, referee_id) values ('${R}', 1, 'referral_reward', '${R}')`)), 'permission denied'), 'clients cannot forge referral rewards');

console.log('\n[claim_referral rules]');
const I1 = await mk();
ok(await failsWith(() => q(`update public.profiles set ref_code = $1 where id = $2`, [codeR, I1]), 'profiles_ref_code_key'), 'two identities can never share a code (unique index backstop)');
for (const bad of ['', '   ', 'x', 'nope-nope', "'; drop table profiles; --", 'a'.repeat(40), 'zzzzzzzzzzzz']) {
  const r = await claim(I1, bad);
  ok(r.claimed === false && r.reason === 'invalid_code', `invalid code ${JSON.stringify(bad.slice(0, 18))} -> invalid_code (no error)`);
}
ok((await claim(R, codeR)).reason === 'self', 'cannot refer yourself');
const c1 = await claim(I1, `  ${codeR.toUpperCase()}  `);
ok(c1.claimed === true, 'a valid code claims (case-insensitive, trimmed)');
ok((await claim(I1, codeR)).reason === 'already_referred', 'claiming again is a no-op');
const R2 = await mk();
ok((await claim(I1, await codeOf(R2))).reason === 'already_referred', 'an invitee cannot be re-assigned to a different referrer');
ok((await q('select count(*)::int n from public.referrals where referee_id=$1', [I1]))[0].n === 1, 'exactly one referral row for the invitee');
{
  const mutual = await claim(R, await codeOf(I1));
  const unknown = await claim(R, 'zzzzzzzzzzzz');
  ok(mutual.claimed === false && JSON.stringify(mutual) === JSON.stringify(unknown), 'mutual referral (invitee "inviting" their referrer back) is refused — and answered exactly like an unknown code', JSON.stringify([mutual, unknown]));
}
ok((await q('select count(*)::int n from public.referrals where referee_id=$1', [R]))[0].n === 0, 'the refused mutual claim created no row');
{
  // Caller-state answers must not depend on the code (so they cannot be used to probe which codes exist).
  const withReal = await claim(I1, codeR); const withFake = await claim(I1, 'zzzzzzzzzzzz');
  ok(JSON.stringify(withReal) === JSON.stringify(withFake) && withReal.reason === 'already_referred', 'an already-referred caller gets the same answer for a real and a fake code', JSON.stringify([withReal, withFake]));
}
const active = await mk();
await completeTest(active);
ok((await claim(active, codeR)).reason === 'already_active', 'someone who already earned a test reward cannot be "referred"');
ok(await failsWith(() => as(null, () => q("select public.claim_referral('abcdefabcdef')")), 'permission denied'), 'no session -> denied');

console.log('\n[reward: first test only, once, to the referrer]');
const balR0 = await bal(R);
ok((await settleRef(R2)) === 0, 'nothing is paid before the invitee has finished a test');
ok((await mine(R)).invited === 1 && (await mine(R)).converted === 0 && (await mine(R)).rewarded === 0, 'get_my_referrals: invited 1, converted 0, rewarded 0');
await completeTest(I1);
ok((await mine(R)).converted === 1 && (await mine(R)).rewarded === 0, 'after the invitee’s test: converted 1, rewarded 0 (not settled yet)');
ok((await bal(R)) === balR0, 'the referrer is not paid until settlement runs (lazy, like expiry)');
const stranger = await mk();
ok((await settleRef(stranger)) === 1, 'any signed-in client can trigger settlement; 1 reward paid');
ok((await bal(R)) === balR0 + 1, 'referrer earned exactly +1 credit');
const rr = await ledgerRows(R, 'referral_reward');
ok(rr.length === 1 && rr[0].delta === 1 && rr[0].referee_id === I1 && rr[0].campaign_id === null, 'one ledger row: +1 referral_reward naming the invitee');
ok((await mine(R)).rewarded === 1 && (await mine(R)).code === codeR, 'get_my_referrals: rewarded 1, code returned');
ok((await settleRef(stranger)) === 0 && (await settleRef(R)) === 0 && (await bal(R)) === balR0 + 1, 'settling again (by anyone) pays nothing more');
await completeTest(I1);
ok((await settleRef(stranger)) === 0 && (await bal(R)) === balR0 + 1, 'the invitee’s later tests earn the referrer nothing more');
ok(await failsWith(() => q(`insert into public.credit_ledger (user_id, delta, reason, referee_id) values ($1, 1, 'referral_reward', $2)`, [R, I1]), 'credit_ledger_one_referral_reward'), 'unique index blocks a second reward for the same invitee (backstop)');
ok(await failsWith(() => q(`insert into public.credit_ledger (user_id, delta, reason) values ($1, 1, 'referral_reward')`, [R]), 'credit_ledger_referee_only_for_referral'), 'a referral reward must name its invitee (CHECK)');
ok(await failsWith(() => q(`insert into public.credit_ledger (user_id, delta, reason, referee_id) values ($1, 1, 'test_reward', $2)`, [R, I1]), 'credit_ledger_referee_only_for_referral'), 'only referral rewards may carry a referee id (CHECK)');

console.log('\n[a test done BEFORE the claim never counts]');
{
  const early = await mk(); const ref = await mk();
  await completeTest(early);                                   // first test happens …
  await q(`insert into public.referrals (referee_id, referrer_id, created_at) values ($1, $2, now() + interval '1 day')`, [early, ref]); // … but the referral is dated after it
  ok((await settleRef(stranger)) === 0 && (await ledgerRows(ref, 'referral_reward')).length === 0, 'reward requires the invitee’s first test to be on/after the claim');
  await q('delete from public.referrals where referee_id = $1', [early]);
}

console.log('\n[a test on the REFERRER\'S OWN campaign never counts]');
{
  const ref = await mk(); const friend = await mk();
  ok((await claim(friend, await codeOf(ref))).claimed === true, 'friend claims');
  const ownCamp = await create(ref);
  await as(friend, () => q('select public.start_test($1)', [ownCamp]));
  await q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds', started_at = started_at - interval '61 seconds' where tester_id=$1 and campaign_id=$2`, [friend, ownCamp]);
  await as(friend, () => q('select public.submit_test($1,true,$2,$3,4,false)', [ownCamp, FB.friction, FB.suggestion]));
  ok((await ledgerRows(friend, 'test_reward')).length === 1, 'the friend really earned a test reward on the referrer’s campaign');
  const m1 = await mine(ref);
  ok(m1.invited === 1 && m1.converted === 0, 'converted does NOT flip when the friend tests the referrer’s own campaign (no timing link to the feedback they receive)', JSON.stringify(m1));
  ok((await settleRef(stranger)) === 0 && (await ledgerRows(ref, 'referral_reward')).length === 0, 'and nothing is paid for it');
  await completeTest(friend);   // a test on someone else's campaign
  ok((await mine(ref)).converted === 1 && (await settleRef(stranger)) === 1 && (await ledgerRows(ref, 'referral_reward')).length === 1, 'the friend’s test on a third party’s campaign does qualify and pays once');
}

console.log('\n[cap: 3 rewarded referrals per referrer]');
{
  const boss = await mk(); const codeB = await codeOf(boss);
  const invitees = [];
  for (let i = 0; i < 5; i++) { const u = await mk(); ok((await claim(u, codeB)).claimed === true, `invitee ${i + 1} claims`); invitees.push(u); }
  for (const u of invitees) await completeTest(u);
  const b0 = await bal(boss);
  let paid = 0; for (let i = 0; i < 4; i++) paid += await settleRef(stranger);
  ok(paid === 3, `exactly 3 rewards are paid across repeated settlements (got ${paid})`);
  ok((await bal(boss)) === b0 + 3 && (await ledgerRows(boss, 'referral_reward')).length === 3, 'referrer +3 credits, 3 ledger rows');
  const m = await mine(boss);
  ok(m.invited === 5 && m.converted === 5 && m.rewarded === 3 && m.cap === 3, 'get_my_referrals is honest: invited 5, converted 5, rewarded 3 (cap 3)', JSON.stringify(m));
  ok((await settleRef(stranger)) === 0, 'further settlement pays nothing past the cap');
}

console.log('\n[settlement is bounded and survives a bad row]');
{
  // 30 pending referrals from 30 different referrers (ledger rows inserted directly to avoid 30 full tests).
  const pairs = [];
  for (let i = 0; i < 30; i++) { const r = await mk(); const e = await mk(); pairs.push([r, e]); }
  for (const [r, e] of pairs) {
    await q('insert into public.referrals (referee_id, referrer_id, created_at) values ($1, $2, now() - interval \'1 hour\')', [e, r]);
    await q(`insert into public.credit_ledger (user_id, delta, reason) values ($1, 1, 'test_reward')`, [e]);
    await q('update public.profiles set credit_balance = credit_balance + 1 where id = $1', [e]);
  }
  // Poison one: a stray reward row for that invitee already exists (e.g. paid by hand) but rewarded_at is still null.
  const [poisonR, poisonE] = pairs[0];
  await q(`insert into public.credit_ledger (user_id, delta, reason, referee_id) values ($1, 1, 'referral_reward', $2)`, [poisonR, poisonE]);
  await q('update public.profiles set credit_balance = credit_balance + 1 where id = $1', [poisonR]);
  const a = await settleRef(stranger); const b = await settleRef(stranger); const c = await settleRef(stranger);
  ok(a <= 25 && b <= 25 && a + b + c === 29 && c === 0, `each call pays at most 25; the poisoned row is skipped and the other 29 are paid (${a}+${b}+${c})`);
  ok((await ledgerRows(poisonR, 'referral_reward')).length === 1, 'the poisoned invitee is never paid twice');
}

console.log('\n[rows that can never be paid cannot starve the others]');
{
  // (a) 30 over-cap invitees queued BEFORE a legitimate referral from a different referrer.
  const boss = await mk();
  for (let i = 0; i < 3; i++) { // boss already at the cap (3 rewarded referrals)
    const e = await mk();
    await q(`insert into public.referrals (referee_id, referrer_id, created_at, rewarded_at) values ($1, $2, now() - interval '3 hour', now())`, [e, boss]);
  }
  for (let i = 0; i < 30; i++) {
    const e = await mk();
    await q(`insert into public.referrals (referee_id, referrer_id, created_at) values ($1, $2, now() - interval '2 hour')`, [e, boss]);
    await q(`insert into public.credit_ledger (user_id, delta, reason) values ($1, 1, 'test_reward')`, [e]);
    await q('update public.profiles set credit_balance = credit_balance + 1 where id = $1', [e]);
  }
  const lateR = await mk(); const lateE = await mk();
  await q(`insert into public.referrals (referee_id, referrer_id, created_at) values ($1, $2, now() - interval '1 hour')`, [lateE, lateR]);
  await q(`insert into public.credit_ledger (user_id, delta, reason) values ($1, 1, 'test_reward')`, [lateE]);
  await q('update public.profiles set credit_balance = credit_balance + 1 where id = $1', [lateE]);
  ok((await settleRef(stranger)) === 1 && (await ledgerRows(lateR, 'referral_reward')).length === 1, '30 over-cap rows ahead in the queue do not stop a later, legitimate referral from being paid on the first call');
  ok((await ledgerRows(boss, 'referral_reward')).length === 0, 'the capped referrer gets nothing more');

  // (b) 26 permanently failing rows (a reward row already exists) queued before another legitimate referral.
  const bad = [];
  for (let i = 0; i < 26; i++) {
    const r = await mk(); const e = await mk(); bad.push([r, e]);
    await q(`insert into public.referrals (referee_id, referrer_id, created_at) values ($1, $2, now() - interval '50 minute')`, [e, r]);
    await q(`insert into public.credit_ledger (user_id, delta, reason) values ($1, 1, 'test_reward')`, [e]);
    await q('update public.profiles set credit_balance = credit_balance + 1 where id = $1', [e]);
    await q(`insert into public.credit_ledger (user_id, delta, reason, referee_id) values ($1, 1, 'referral_reward', $2)`, [r, e]);
    await q('update public.profiles set credit_balance = credit_balance + 1 where id = $1', [r]);
  }
  const lateR2 = await mk(); const lateE2 = await mk();
  await q(`insert into public.referrals (referee_id, referrer_id, created_at) values ($1, $2, now() - interval '40 minute')`, [lateE2, lateR2]);
  await q(`insert into public.credit_ledger (user_id, delta, reason) values ($1, 1, 'test_reward')`, [lateE2]);
  await q('update public.profiles set credit_balance = credit_balance + 1 where id = $1', [lateE2]);
  let guard = 0; while ((await ledgerRows(lateR2, 'referral_reward')).length === 0 && guard++ < 8) await settleRef(stranger);
  ok((await ledgerRows(lateR2, 'referral_reward')).length === 1 && guard <= 4, `26 permanently failing rows are parked after a few tries and the legitimate referral behind them is paid (settle calls needed: ${guard + 1})`);
  for (let i = 0; i < 3; i++) await settleRef(stranger);
  const parked = await q(`select count(*)::int n from public.referrals where settle_failures >= 3 and referee_id = any($1)`, [bad.map(([, e]) => e)]);
  ok(parked[0].n === 26, 'every failing row was parked (settle_failures reached 3)');
  ok((await q('select count(*)::int n from public.referrals where settle_failures > 3'))[0].n === 0, 'a parked row is never tried again');
}

console.log('\n[global invariants]');
const drift = await q(`select p.id from public.profiles p left join public.credit_ledger l on l.user_id = p.id group by p.id having p.credit_balance <> coalesce(sum(l.delta),0)`);
ok(drift.length === 0, 'balance == SUM(ledger) for every user');
ok((await q('select count(*)::int n from public.profiles where credit_balance < 0'))[0].n === 0, 'no negative balance');
// test_reward rows inserted directly (no campaign spend): 30 (bounded settlement) + 30 + 1 (over-cap queue) + 26 + 1 (failing rows)
const FABRICATED = 30 + 31 + 27;
const dupe = await q(`select referee_id from public.credit_ledger where reason='referral_reward' group by referee_id having count(*) > 1`);
ok(dupe.length === 0, 'no invitee has been paid for twice');
const perRef = await q(`select user_id, count(*)::int n from public.credit_ledger where reason='referral_reward' group by user_id having count(*) > 3`);
ok(perRef.length === 0, 'no referrer has more than 3 rewards');
const sup = (await q(`select coalesce(sum(credit_balance),0)::int s, (select count(*)::int from public.profiles) n,
                             (select count(*)::int from public.campaigns where status='open') o,
                             (select count(*)::int from public.credit_ledger where reason='referral_reward') rr from public.profiles`))[0];
ok(sup.s + sup.o === sup.n + sup.rr + FABRICATED, `credits conserved: balances(${sup.s}) + open campaigns(${sup.o}) == identities(${sup.n}) + referral rewards minted(${sup.rr}) + ${FABRICATED} fabricated by the test`);

console.log('\n[deleting a paid invitee]');
{
  // Account cleanup (e.g. removing an anonymous user) must not be blocked by a ledger row that names the invitee.
  const ref = await mk(); const inv = await mk();
  await claim(inv, await codeOf(ref));
  await completeTest(inv);
  ok((await settleRef(stranger)) >= 1 && (await ledgerRows(ref, 'referral_reward')).length === 1, 'setup: a paid referral exists');
  let err = null;
  try { await q('delete from public.profiles where id = $1', [inv]); } catch (e) { err = e; }
  ok(err === null, 'the paid invitee can be deleted', err?.message);
  ok((await q('select count(*)::int n from public.referrals where referee_id=$1', [inv]))[0].n === 0, 'their referral row is gone with them');
  ok((await ledgerRows(ref, 'referral_reward')).length === 1 && (await bal(ref)) >= 1, 'the referrer keeps the credit they earned');
  let err2 = null;
  try { await q('delete from public.profiles where id = $1', [ref]); } catch (e) { err2 = e; }
  ok(err2 === null, 'a referrer with rewards can be deleted too', err2?.message);
}

summary();
