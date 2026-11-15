// HOTFIX tests: referral reward settled by the trusted completion path (migration 20261115000700), with the owner's product decision that
// a test on the REFERRER'S OWN campaign qualifies (a founder inviting a friend to test their product).
// The database starts in the exact PRODUCTION state (migrations 1-10, production-like settings), is populated with historical referral
// rows, and migration 11 is applied on top. Then the whole flow is driven through the real RPCs.
// Real Postgres (PGlite). Single connection: genuinely parallel transactions cannot be raced here; "concurrent" completions are
// exercised as several completions inside ONE transaction (which hits the cap/lock logic under a shared snapshot) and the locking is
// reasoned in the migration; the cap and idempotency backstops are database constraints.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, uid } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const mig = (f) => readFileSync(join(here, '..', 'migrations', f), 'utf8');
const M11 = '20261115000700_referral_settlement_on_completion.sql';

const { db, as, q, ok, failsWith, summary } = await createHarness({
  quiet: true, upTo: '20261115000600_consent_withdrawal_clears_decisions.sql', exposureDisabled: true, autoRls: true, autoReady: true,
});

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
const settleRef = async (u) => (await as(u, () => q('select public.settle_referral_rewards() n', [])))[0].n;
const mine = async (u) => (await as(u, () => q('select public.get_my_referrals() r')))[0].r;
const rewards = (u) => q(`select * from public.credit_ledger where user_id=$1 and reason='referral_reward'`, [u]);
const refRow = async (referee) => (await q('select * from public.referrals where referee_id=$1', [referee]))[0];
const create = async (owner, name = 'Ref hotfix') => (await as(owner, () => q('select public.create_project_with_campaign($1,$2,$3,$4) id', [name, 'https://example.com', 'd', TASK])))[0].id;
const reserve = (tester, camp) => as(tester, () => q('select public.start_test($1)', [camp]));
const age = (tester, camp) => q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds', started_at = started_at - interval '61 seconds' where tester_id=$1 and campaign_id=$2`, [tester, camp]);
const submit = (tester, camp) => as(tester, () => q('select public.submit_test($1,true,$2,$3,4,false) r', [camp, FB.friction, FB.suggestion]));
async function completeOn(tester, camp) { await reserve(tester, camp); await age(tester, camp); return submit(tester, camp); }
async function completeThirdParty(tester) { const owner = await mk(); const camp = await create(owner); await completeOn(tester, camp); return { owner, camp }; }
const campaignOf = async (id) => (await q('select status, response_count, max_responses from public.campaigns where id=$1', [id]))[0];
const driftRows = async () => (await q(`select count(*)::int n from public.profiles p where p.credit_balance <> coalesce((select sum(delta) from public.credit_ledger l where l.user_id = p.id),0)`))[0].n;
const moneySnapshot = async () => (await q(`select (select count(*)::int from public.credit_ledger) ledger, (select coalesce(sum(credit_balance),0)::int from public.profiles) credits,
   (select count(*)::int from public.referrals where rewarded_at is not null) rewarded, (select count(*)::int from public.test_reservations) reservations, (select count(*)::int from public.test_submissions) submissions`))[0];
const SQL = (f) => readFileSync(join(repo, 'docs', f), 'utf8').replace(/^--.*$/gm, '');

// ------------------------------------------------------------------------------------------------------------------
console.log('\n[production state before the hotfix (migrations 1-10) with historical referral rows]');
// H3: a referrer already at the cap of 3 rewarded referrals, plus a 4th invitee that completed a qualifying test.
const H3r = await mk();
for (let i = 0; i < 3; i++) { const e = await mk(); await claim(e, await codeOf(H3r)); await completeThirdParty(e); await settleRef(await mk()); }
const H3e = await mk(); await claim(H3e, await codeOf(H3r)); await completeThirdParty(H3e);
// H1: qualifies under the OLD rule too, unpaid because the lazy settler never ran after the completion.
const H1r = await mk(), H1e = await mk();
await claim(H1e, await codeOf(H1r));
await completeThirdParty(H1e);
// H2: exactly the ReleaseCheck situation: the invitee's ONLY test was on the referrer's own campaign (A -> B -> A's campaign).
const H2r = await mk();
const H2camp = await create(H2r, 'H2 own campaign');
const H2e = await mk();
await claim(H2e, await codeOf(H2r));
await completeOn(H2e, H2camp);
// in-progress reservation of an invitee, taken BEFORE the hotfix
const IPr = await mk(), IPe = await mk();
await claim(IPe, await codeOf(IPr));
const ipOwner = await mk(); const ipCamp = await create(ipOwner, 'in progress');
await reserve(IPe, ipCamp);
ok((await refRow(H1e)).rewarded_at === null && (await rewards(H1r)).length === 0, 'precondition H1: a qualifying (third-party) invitee exists and the referrer is unpaid');
ok((await rewards(H2r)).length === 0 && (await refRow(H2e)).rewarded_at === null && (await bal(H2r)) === 0 && (await campaignOf(H2camp)).status === 'completed', 'precondition H2: the ReleaseCheck situation: A\'s balance 0, campaign Tested, B tested A\'s own campaign, referral unpaid');
ok((await rewards(H3r)).length === 3 && (await refRow(H3e)).rewarded_at === null, 'precondition H3: referrer at the cap with a 4th unpaid qualifying invitee');
const before = await moneySnapshot();
const settleDefBefore = (await q(`select md5(pg_get_functiondef('public.settle_referral_rewards()'::regprocedure)) h`))[0].h;
const myRefDefBefore = (await q(`select md5(pg_get_functiondef('public.get_my_referrals()'::regprocedure)) h`))[0].h;
const privBefore = (await q(`select has_function_privilege('authenticated','public.settle_referral_rewards()','execute') a, has_function_privilege('anon','public.settle_referral_rewards()','execute') n`))[0];

console.log('\n[read-only preview of the UPDATED policy on the historical rows (before migration 11 exists)]');
{
  const preview = await q(SQL('preview-unpaid-referrals.sql'));
  const by = (k) => preview.filter((x) => x.verdict === k).length;
  ok(by('eligible_unpaid') === 1 && by('eligible_unpaid_needs_reconciliation') === 1 && by('blocked_referrer_cap_reached') === 1 && by('no_test_yet') === 1, 'the preview works on the live schema and classifies: 1 eligible (old rule), 1 needs reconciliation (own-campaign only: the ReleaseCheck case), 1 capped, 1 without a test', JSON.stringify(preview.map((x) => x.verdict)));
  ok((await moneySnapshot()).credits === before.credits, 'the preview changed nothing');
}

console.log('\n[apply migration 11 on the populated database]');
let err = null;
try { await db.exec(mig(M11)); } catch (e) { err = e.message; }
ok(err === null, 'migration 11 applies cleanly on top of 1-10', err ?? '');
const after = await moneySnapshot();
ok(JSON.stringify(before) === JSON.stringify(after), 'no credit, ledger row, referral flag, reservation or submission changed: NO backfill, NO automatic repair of history', JSON.stringify([before, after]));
ok((await refRow(H1e)).rewarded_at === null && (await refRow(H2e)).rewarded_at === null && (await refRow(H3e)).rewarded_at === null, 'the historical unpaid rows are untouched by the migration');
ok(await driftRows() === 0, 'ledger sums to every balance');

console.log('\n[historical rows are NOT paid automatically; only the explicit reconciliation pays the own-campaign case]');
{
  const n = await settleRef(await mk());
  ok(n === 1 && (await rewards(H1r)).length === 1, 'the lazy safety net (existing behaviour) pays the row that qualified under the OLD rule (H1) and nothing else');
  ok((await rewards(H2r)).length === 0 && (await bal(H2r)) === 0 && (await refRow(H2e)).rewarded_at === null, 'the ReleaseCheck-like row (own-campaign test BEFORE the policy date) is NOT paid by the safety net');
  await settleRef(await mk()); await settleRef(H2r); await settleRef(H2e);
  ok((await rewards(H2r)).length === 0, '...however often it runs, also not when its own referrer or invitee loads a page');
  const preview = await q(SQL('preview-unpaid-referrals.sql'));
  ok(preview.filter((x) => x.verdict === 'eligible_unpaid_needs_reconciliation').length === 1 && preview.find((x) => x.verdict === 'eligible_unpaid_needs_reconciliation').referrer_rewards === 0, 'the preview still lists exactly that row as needing explicit reconciliation (+1 for its referrer)');
  const bH = await bal(H2r);
  const out1 = await q(SQL('reconcile-referrals.sql'));
  ok(out1.filter((x) => x.outcome === 'paid').length === 1 && (await rewards(H2r)).length === 1 && (await bal(H2r)) === bH + 1 && (await refRow(H2e)).settle_reason === 'paid', 'the owner-approved reconciliation pays it exactly once: A\'s balance 0 -> 1');
  ok((await rewards(H3r)).length === 3 && (await refRow(H3e)).settle_reason === 'referrer_cap_reached' && (await refRow(H3e)).rewarded_at === null, 'the capped referrer stays at exactly 3 rewards; the 4th row records referrer_cap_reached');
  const out2 = await q(SQL('reconcile-referrals.sql'));
  ok(out2.filter((x) => x.outcome === 'paid').length === 0 && (await bal(H2r)) === bH + 1 && (await rewards(H2r)).length === 1, 'running the reconciliation again pays nothing (idempotent)');
  // a test completed BEFORE the claim never qualifies, not even through the explicit reconciliation (history is only about the policy for own-campaign tests)
  const early = await mk(), earlyRef = await mk();
  await completeThirdParty(early);
  await q(`insert into public.referrals (referee_id, referrer_id, created_at) values ($1, $2, now() + interval '1 day')`, [early, earlyRef]);
  const outE = await q(SQL('reconcile-referrals.sql'));
  ok(outE.find((x) => x.referee_id === early).outcome === 'no_qualifying_test_yet' && (await rewards(earlyRef)).length === 0, 'a test completed BEFORE the referral claim never qualifies, even through the reconciliation');
  await q('delete from public.referrals where referee_id = $1', [early]);
  ok(await driftRows() === 0, 'ledger still sums to every balance after the reconciliation');
}

// ------------------------------------------------------------------------------------------------------------------
console.log('\n[THE EXACT USER JOURNEY: A joins (1 credit), spends it on a campaign, B joins via A\'s link and completes A\'s OWN campaign]');
const A = await mk();
ok((await bal(A)) === 1, 'A joins UXBarter and gets 1 starter credit');
const linkCode = await codeOf(A);
const campA = await create(A, 'A\'s product');
ok((await bal(A)) === 0, 'A spends that credit creating a campaign (balance 0)');
const B = await mk();                                  // (the test fixture completes B's profile: Students & Learners + four answers)
ok((await claim(B, linkCode)).claimed === true, 'B joins through A\'s referral link');
ok((await refRow(B)).referrer_id === A && (await refRow(B)).rewarded_at === null && (await bal(A)) === 0, 'B is attributed to A; signup alone pays nothing');
const balB0 = await bal(B);
await reserve(B, campA); await age(B, campA);
const sub = (await submit(B, campA))[0].r;
ok(sub.credits_awarded === 1 && (await bal(B)) === balB0 + 1, 'B reserves and successfully completes A\'s own campaign and earns +1 test credit');
// ---- from here on NOTHING else is called: no settle, no dashboard, no RPC of A's ----
const rA = await rewards(A);
ok((await bal(A)) === 1 && rA.length === 1 && rA[0].delta === 1 && rA[0].referee_id === B && rA[0].campaign_id === null, 'A AUTOMATICALLY earns +1 referral credit: balance back to 1, one referral_reward ledger row naming B, with no additional request');
const cA = await campaignOf(campA);
ok(cA.status === 'completed' && cA.response_count === 1 && cA.max_responses === 1, 'A\'s campaign is Tested (completed) with 1/1 responses');
const ref = await refRow(B);
ok(ref.rewarded_at !== null && ref.settle_reason === 'paid' && ref.evaluated_at !== null && ref.settle_failures === 0, 'the referral is marked rewarded (rewarded_at, reason "paid")');
ok((await mine(A)).rewarded === 1 && (await mine(A)).converted === 1 && (await mine(A)).invited === 1, 'get_my_referrals agrees: invited 1, converted 1, rewarded 1');
ok(await driftRows() === 0, 'balance == SUM(ledger) for every user');

console.log('\n[the same journey with a THIRD-PARTY campaign]');
{
  const r = await mk(), e = await mk();
  await claim(e, await codeOf(r));
  const b0 = await bal(r);
  await completeThirdParty(e);
  ok((await bal(r)) === b0 + 1 && (await rewards(r)).length === 1 && (await refRow(e)).settle_reason === 'paid', 'a first test on someone else\'s campaign pays the referrer +1 automatically as well');
  await completeThirdParty(e);
  ok((await rewards(r)).length === 1 && (await bal(r)) === b0 + 1, 'the invitee\'s SECOND test pays nothing more: exactly one reward per referred identity');
}

console.log('\n[exactly once: duplicates, retries and repeated settlement]');
ok(await failsWith(() => submit(B, campA), 'already_tested') && (await rewards(A)).length === 1 && (await bal(A)) === 1, 'a duplicate submit (retried request) is refused and pays nothing more');
const s1 = await settleRef(await mk()), s2 = await settleRef(A), s3 = await settleRef(B);
ok(s1 + s2 + s3 === 0 && (await rewards(A)).length === 1 && (await bal(A)) === 1, 'the safety net called by anyone, repeatedly, does not pay B\'s referral again');
const again = await q(`select public.referral_try_settle($1, 0, false) r`, [B]);
const again2 = await q(`select public.referral_try_settle($1, 250, true) r`, [B]);
ok(again[0].r === 'already_rewarded' && again2[0].r === 'already_rewarded', 'calling the settlement function again (even with history) answers already_rewarded');
ok(await failsWith(() => q(`insert into public.credit_ledger (user_id, delta, reason, referee_id) values ($1, 1, 'referral_reward', $2)`, [A, B]), 'credit_ledger_one_referral_reward'), 'the unique index is the final backstop: a second reward row for B cannot exist');
const lt = await db.exec(`begin; select current_setting('lock_timeout') a; select public.referral_try_settle('${B}', 250, false); select current_setting('lock_timeout') b; rollback;`);
ok(lt[1].rows[0].a === lt[3].rows[0].b, 'the bounded lock wait is restored after the settlement (no leak into the rest of the transaction)', JSON.stringify([lt[1].rows, lt[3].rows]));

console.log('\n[abuse protections are unchanged]');
{
  const x = await mk();
  const r = await claim(x, await codeOf(x));
  ok(r.claimed === false && r.reason === 'self', 'self-referral is refused by claim_referral');
  ok(await failsWith(() => q(`insert into public.referrals (referee_id, referrer_id) values ($1, $1)`, [x]), 'referrals_not_self'), 'and by a table constraint');
  const own = await create(x, 'x own');
  ok(await failsWith(() => submit(x, own), 'own_campaign'), 'an owner cannot submit a test on their own campaign (the same identity can never be both)');
  await completeThirdParty(x);
  ok((await rewards(x)).length === 0, 'a self-referral can never be rewarded');
}
{
  const r = await mk(), e = await mk();
  await claim(e, await codeOf(r));
  const back = await claim(r, await codeOf(e));
  ok(back.claimed === false, 'mutual referral (A invites B, B "invites" A) is refused');
}
{
  const r = await mk(), e = await mk();
  await claim(e, await codeOf(r));
  await settleRef(await mk());
  ok((await rewards(r)).length === 0 && (await refRow(e)).rewarded_at === null, 'merely signing up through the link pays nothing, even after settlement runs');
}
{
  const stranger = await mk(), someone = await mk();
  const n0 = (await q(`select count(*)::int n from public.credit_ledger where reason='referral_reward'`))[0].n;
  await completeThirdParty(stranger);
  ok((await q(`select count(*)::int n from public.credit_ledger where reason='referral_reward'`))[0].n === n0, 'an unrelated completion (no referral attribution) creates no reward anywhere');
  const fresh = await mk();
  const bogus = await claim(fresh, 'zzzzzzzzzzzz');
  ok(bogus.claimed === false && bogus.reason === 'invalid_code', 'an invalid code attributes nothing');
  const late = await claim(stranger, await codeOf(someone));
  ok(late.claimed === false && late.reason === 'already_active', 'a user who already earned a reward can no longer be referred (cannot farm by claiming late)');
}
{
  // unsuccessful / incomplete tests never reward
  const r = await mk(), e = await mk();
  await claim(e, await codeOf(r));
  const camp = await create(await mk(), 'incomplete');
  await reserve(e, camp);
  ok(await failsWith(() => submit(e, camp), 'too_fast'), 'a submission before the minimum testing time is refused');
  await q(`update public.test_reservations set started_at = now() - interval '20 minutes', first_started_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute' where tester_id=$1 and campaign_id=$2`, [e, camp]);
  ok(await failsWith(() => submit(e, camp), 'reservation_expired'), 'a submission on an expired reservation is refused');
  await settleRef(await mk());
  ok((await rewards(r)).length === 0 && (await refRow(e)).rewarded_at === null, 'incomplete / refused tests never pay the referrer');
}
{
  const boss = await mk(); const code = await codeOf(boss);
  const b0 = await bal(boss);
  const inv = [];
  for (let i = 0; i < 4; i++) { const u = await mk(); await claim(u, code); inv.push(u); }
  for (const u of inv) await completeThirdParty(u);
  ok((await rewards(boss)).length === 3 && (await bal(boss)) === b0 + 3, 'MULTIPLE invitees completing: exactly 3 rewards are paid, the referrer gets +3');
  ok((await refRow(inv[3])).settle_reason === 'referrer_cap_reached' && (await refRow(inv[3])).rewarded_at === null, 'the 4th invitee is not paid and the reason is recorded: referrer_cap_reached');
  ok((await bal(inv[3])) >= 2, 'the 4th invitee still got their own test reward (the cap only concerns the referrer)');
  await settleRef(await mk());
  ok((await rewards(boss)).length === 3, 'repeated settlement cannot exceed the cap');
}

console.log('\n[concurrent completions: several invitees of one referrer finishing inside ONE transaction]');
{
  const boss = await mk(); const code = await codeOf(boss);
  const inv = [];
  for (let i = 0; i < 2; i++) { const u = await mk(); await claim(u, code); inv.push(u); }
  const e3 = await mk(); await claim(e3, code); await completeThirdParty(e3);   // boss already has 1 reward
  const e4 = await mk(); await claim(e4, code); await completeThirdParty(e4);   // 2 rewards
  const camps = [];
  for (const u of inv) { const c = await create(await mk(), 'concurrent'); await reserve(u, c); await age(u, c); camps.push(c); }
  const stmt = (u, c) => `select set_config('request.jwt.claim.sub','${u}',true); select public.submit_test('${c}',true,'${FB.friction}','${FB.suggestion}',4,false);`;
  await db.exec(`begin; set local role authenticated; ${stmt(inv[0], camps[0])} ${stmt(inv[1], camps[1])} reset role; commit;`);
  ok((await rewards(boss)).length === 3, 'two completions (cap room for one) in one transaction: exactly 3 rewards exist in total (the cap holds under a shared snapshot)');
  ok((await bal(inv[0])) >= 2 && (await bal(inv[1])) >= 2, 'both invitees got their own test reward');
  ok((await q(`select count(*)::int n from public.referrals where referee_id = any($1) and rewarded_at is not null`, [inv]))[0].n === 1, 'exactly one of the two simultaneous invitees was paid; the other recorded the cap');
  ok(await driftRows() === 0, 'ledger conserved');
}

console.log('\n[a failure while settling can never break the invitee\'s completion; the retry pays exactly once]');
{
  const r = await mk(), e = await mk();
  await claim(e, await codeOf(r));
  await db.exec(`create function public.test_block_reward() returns trigger language plpgsql as $f$ begin if current_setting('test.block', true) = 'on' then raise exception 'simulated failure'; end if; return new; end $f$;
                 create trigger test_block before insert on public.credit_ledger for each row when (new.reason = 'referral_reward') execute function public.test_block_reward();`);
  await db.exec(`select set_config('test.block', 'on', false)`);
  const b0 = await bal(r), e0 = await bal(e);
  await completeThirdParty(e);
  ok((await bal(e)) === e0 + 1 && (await q('select count(*)::int n from public.test_submissions where tester_id=$1', [e]))[0].n === 1, 'the invitee\'s own submission and reward are committed even though the referral settlement failed');
  const failed = await refRow(e);
  ok((await bal(r)) === b0 && (await rewards(r)).length === 0 && failed.rewarded_at === null && failed.settle_failures === 1 && failed.settle_reason === 'error', 'nothing was paid, the failure is recorded (settle_failures 1, reason error): all-or-nothing');
  ok(await driftRows() === 0, 'no balance/ledger mismatch after the partial failure');
  await db.exec(`select set_config('test.block', 'off', false)`);
  const n1 = await settleRef(await mk());
  ok(n1 >= 1 && (await rewards(r)).length === 1 && (await bal(r)) === b0 + 1, 'retry through the safety net pays the referral exactly once');
  const n2 = await settleRef(await mk());
  ok((await rewards(r)).length === 1 && (await bal(r)) === b0 + 1 && n2 === 0, 'and a second retry changes nothing');
  await db.exec('drop trigger test_block on public.credit_ledger; drop function public.test_block_reward()');
}

console.log('\n[in-progress reservation taken before the hotfix]');
{
  await age(IPe, ipCamp);
  const r0 = await bal(IPr);
  const s = (await submit(IPe, ipCamp))[0].r;
  ok(s.credits_awarded === 1 && (await bal(IPr)) === r0 + 1 && (await rewards(IPr)).length === 1, 'the reservation survives the migration, completes normally, and its referrer is paid automatically');
}

console.log('\n[a signed-in user cannot credit themselves or call anything internal]');
{
  const u = await mk(); const v = await mk();
  for (const call of [`select public.referral_try_settle('${v}', 0, true)`, `select public.referral_try_settle('${u}', 250, false)`, 'select public.referral_settle_on_reward()']) {
    ok(await failsWith(() => as(u, () => q(call)), 'permission denied'), `authenticated cannot call: ${call.slice(0, 64)}`);
  }
  ok(await failsWith(() => as(u, () => q(`insert into public.credit_ledger (user_id, delta, reason, referee_id) values ('${u}', 1, 'referral_reward', '${v}')`)), 'permission denied'), 'cannot forge a reward row');
  ok(await failsWith(() => as(u, () => q(`update public.referrals set rewarded_at = null`)), 'permission denied') && await failsWith(() => as(u, () => q(`update public.profiles set credit_balance = 99 where id='${u}'`)), 'permission denied'), 'cannot edit referrals or their own balance');
  ok(await failsWith(() => as(u, () => q(`update public.referral_policy set own_campaign_counts_from = '2000-01-01'`)), 'permission denied') && await failsWith(() => as(u, () => q('select * from public.referral_policy')), 'permission denied'), 'cannot read or move the policy date');
  ok(await failsWith(() => as(null, () => q('select public.settle_referral_rewards()')), 'permission denied'), 'anonymous (no session) cannot call the safety net');
  ok(await failsWith(() => as(u, () => q('select settle_reason from public.referrals')), 'permission denied'), 'the referrals table (and the reason column) is invisible to clients');
  ok(await failsWith(() => as(u, () => q(`select public.claim_referral('${'q'.repeat(12)}', '${v}')`)), 'does not exist'), 'claim_referral takes only a code: a client cannot name a referrer id');
}

console.log('\n[verification SQL (docs/verify-migration11.sql)]');
{
  const v = await q(SQL('verify-migration11.sql'));
  ok(v.length === 13 && v.every((r) => r.ok === true), 'every check of the read-only verification query is true', JSON.stringify(v.filter((r) => r.ok !== true).map((r) => r.check_name)));
  const privAfter = (await q(`select has_function_privilege('authenticated','public.settle_referral_rewards()','execute') a, has_function_privilege('anon','public.settle_referral_rewards()','execute') n`))[0];
  ok(JSON.stringify(privAfter) === JSON.stringify(privBefore), 'settle_referral_rewards keeps exactly its previous privileges (authenticated yes, anon no)');
}
ok(await driftRows() === 0, 'FINAL: balance == SUM(ledger) for every user');
ok((await q(`select count(*)::int n from (select referee_id from public.credit_ledger where reason='referral_reward' group by referee_id having count(*) > 1) d`))[0].n === 0, 'FINAL: no invitee has more than one reward row');
ok((await q(`select count(*)::int n from (select user_id from public.credit_ledger where reason='referral_reward' group by user_id having count(*) > 3) d`))[0].n === 0, 'FINAL: no referrer has more than 3 reward rows');

console.log('\n[rollback: docs/rollback-migration11.sql]');
{
  const snap = await moneySnapshot();
  let e2 = null;
  try { await db.exec(readFileSync(join(repo, 'docs', 'rollback-migration11.sql'), 'utf8')); } catch (e) { e2 = e.message; }
  ok(e2 === null, 'the rollback runs cleanly on the migrated database');
  ok(JSON.stringify(await moneySnapshot()) === JSON.stringify(snap), 'it changes no credit, ledger row, referral flag, reservation or submission');
  const defAfter = (await q(`select md5(pg_get_functiondef('public.settle_referral_rewards()'::regprocedure)) h`))[0].h;
  const myAfter = (await q(`select md5(pg_get_functiondef('public.get_my_referrals()'::regprocedure)) h`))[0].h;
  ok(defAfter === settleDefBefore && myAfter === myRefDefBefore, 'settle_referral_rewards() and get_my_referrals() are IDENTICAL to their definitions before migration 11');
  ok((await q(`select count(*)::int n from pg_trigger where tgname='credit_ledger_referral_settle'`))[0].n === 0 && (await q(`select count(*)::int n from pg_proc where proname in ('referral_try_settle','referral_settle_on_reward')`))[0].n === 0 && (await q(`select count(*)::int n from pg_class where relname='referral_policy'`))[0].n === 0, 'the trigger, the new functions and the policy table are gone');
  const r = await mk(), e = await mk();
  await claim(e, await codeOf(r));
  const b0 = await bal(r);
  await completeThirdParty(e);
  ok((await bal(r)) === b0 && (await rewards(r)).length === 0, 'after the rollback a completion no longer pays the referrer by itself (previous behaviour)');
  ok((await settleRef(await mk())) >= 1 && (await rewards(r)).length === 1 && (await bal(r)) === b0 + 1, 'and the lazy settlement pays it exactly once (previous behaviour works)');
  const r2 = await mk(), e2b = await mk();
  await claim(e2b, await codeOf(r2));
  await completeOn(e2b, await create(r2, 'own after rollback'));
  await settleRef(await mk());
  ok((await rewards(r2)).length === 0, 'and a test on the referrer\'s own campaign counts again as NOT qualifying (previous rule restored)');
  ok(await driftRows() === 0, 'ledger still sums to every balance');
}

summary();
