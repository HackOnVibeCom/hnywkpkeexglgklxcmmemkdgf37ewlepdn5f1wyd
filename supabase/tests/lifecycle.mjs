// Phase 1 tests: campaign lifecycle + anti-abuse (migration 20261114000100).
// Time is simulated by shifting timestamps backwards with superuser UPDATEs (clients can never do
// that: they have no write privileges). Same limits as harness.mjs: PGlite is single-connection, so
// genuinely parallel races are covered by the live-API script, not here.

import { createHarness, uid } from './harness.mjs';

const { db, as, q, ok, fails, failsWith, summary } = await createHarness({ autoReady: true });

const URL_ = 'https://example.com/app';
const TASK = 'Find the pricing page and tell me which plan you would pick.';
const FB = { friction: 'The pricing link was hidden in the footer.', suggestion: 'Add a pricing link to the top nav.' };

let nextId = 1;
/** Creates an identity with its profile (+ starter credit). */
async function mk() {
  const id = uid(nextId++);
  await db.query('insert into auth.users (id) values ($1)', [id]);
  await as(id, () => q('select * from public.ensure_profile()'));
  return id;
}
const bal = async (u) => (await as(u, () => q('select credit_balance from public.profiles')))[0].credit_balance;
const create = async (u, o = {}) =>
  (await as(u, () => q('select public.create_project_with_campaign($1,$2,$3,$4) as id', [o.name ?? 'Acme', URL_, 'desc', o.task ?? TASK])))[0].id;
const start = async (u, id) => (await as(u, () => q('select public.start_test($1) as r', [id])))[0].r;
const submitRaw = async (u, id, o = {}) =>
  (await as(u, () => q('select public.submit_test($1,$2,$3,$4,$5,$6) as r', [id, true, FB.friction, FB.suggestion, o.rating ?? 4, false])))[0].r;
const cancel = async (u, id) => (await as(u, () => q('select public.cancel_campaign($1) as r', [id])))[0].r;
const settle = async (u) => (await as(u, () => q('select public.settle_expired_campaigns() as n')))[0].n;
const feed = (u) => as(u, () => q('select * from public.list_open_campaigns()'));
const page = async (u, id) => (await as(u, () => q('select * from public.get_campaign_for_test($1)', [id])))[0] ?? null;
const status = async (u) => (await as(u, () => q('select public.get_my_status() as s')))[0].s;
const campaignRow = async (id) => (await q('select * from public.campaigns where id=$1', [id]))[0];
const ledger = (u, reason) => q('select * from public.credit_ledger where user_id=$1 and reason=$2', [u, reason]);

// --- simulated clock (superuser only) ---
const ageReservation = (u, id, secs) => q(
  `update public.test_reservations
      set first_started_at = first_started_at - make_interval(secs => $3),
          started_at = started_at - make_interval(secs => $3),
          expires_at = expires_at - make_interval(secs => $3)
    where tester_id = $1 and campaign_id = $2`, [u, id, secs]);
const lapseReservation = (u, id) => ageReservation(u, id, 20 * 60); // 15 min hold -> expired 5 min ago
/** Pretend the reservation was made exactly `secs` ago (absolute, not cumulative). */
const setElapsed = (u, id, secs) => q(
  `update public.test_reservations
      set first_started_at = now() - make_interval(secs => $3),
          started_at = now() - make_interval(secs => $3),
          expires_at = now() - make_interval(secs => $3) + interval '15 minutes'
    where tester_id = $1 and campaign_id = $2`, [u, id, secs]);
const expireCampaign = (id) => q(`update public.campaigns set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id=$1`, [id]);
const ageReward = (u, hours) => q(
  `update public.credit_ledger set created_at = now() - make_interval(hours => $2)
    where id = (select id from public.credit_ledger where user_id=$1 and reason='test_reward' order by created_at asc limit 1)`, [u, hours]);

/** Honest completed test: reserve, wait the minimum, submit. */
async function completeTest(tester, campaignId) {
  await start(tester, campaignId);
  await ageReservation(tester, campaignId, 61);
  return submitRaw(tester, campaignId);
}

console.log('\n[privileges: new objects are locked down]');
const anonU = await mk();
const owner = await mk();
const c1 = await create(owner);
for (const call of [
  `select public.start_test('${c1}')`,
  `select public.cancel_campaign('${c1}')`,
  `select public.settle_expired_campaigns()`,
  `select public.get_my_status()`,
  `select * from public.test_reservations`,
]) ok(await failsWith(() => as(null, () => q(call)), 'permission denied'), `anon denied: ${call.slice(0, 55)}`);
ok(await failsWith(() => as(anonU, () => q(`select public.close_campaign_refund('${c1}', 'cancelled')`)), 'permission denied'), 'authenticated cannot call the internal refund helper (no free refunds)');
for (const [name, sql] of [
  ['insert a reservation', `insert into public.test_reservations (campaign_id, tester_id, expires_at) values ('${c1}', '${anonU}', now() + interval '1 day')`],
  ['update a reservation', `update public.test_reservations set expires_at = now() + interval '1 year'`],
  ['delete a reservation', `delete from public.test_reservations`],
  ['extend campaign expiry', `update public.campaigns set expires_at = now() + interval '1 year'`],
  ['reopen a campaign', `update public.campaigns set status = 'open'`],
  ['forge a refund row', `insert into public.credit_ledger (user_id, delta, reason, campaign_id) values ('${owner}', 1, 'campaign_refund', '${c1}')`],
]) ok(await failsWith(() => as(owner, () => q(sql)), 'permission denied'), `authenticated cannot ${name}`);

console.log('\n[expiry]');
const exp = (await q('select extract(epoch from (expires_at - created_at))::int s from public.campaigns where id=$1', [c1]))[0].s;
ok(exp === 7 * 86400, 'new campaign expires exactly 7 days after creation', String(exp));
ok(await failsWith(() => q(`update public.campaigns set expires_at = created_at where id='${c1}'`), 'campaigns_expiry_after_creation'), 'expiry must be after creation (CHECK)');
ok(await failsWith(() => q(`update public.campaigns set status='cancelled' where id='${c1}'`), 'campaigns_closed_at_consistent'), 'cancelled/expired status requires closed_at (CHECK)');

console.log('\n[reservation: 15 minutes, exclusive, idempotent]');
const T1 = await mk();
const T2 = await mk();
ok(await failsWith(() => start(owner, c1), 'own_campaign'), 'owner cannot reserve own campaign');
ok(await failsWith(() => start(T1, '11111111-1111-1111-1111-111111111111'), 'campaign_not_found'), 'unknown campaign rejected');
const r1 = await start(T1, c1);
ok(Date.parse(r1.reservation_expires_at) - Date.parse(r1.server_now) === 15 * 60 * 1000, 'reservation lasts exactly 15 minutes');
ok(Date.parse(r1.min_submit_at) - Date.parse(r1.server_now) === 60 * 1000, 'minimum testing time is 60 seconds');
await ageReservation(T1, c1, 30);
const r1b = await start(T1, c1);
ok(r1b.reservation_expires_at !== r1.reservation_expires_at && Date.parse(r1b.reservation_expires_at) === Date.parse(r1.reservation_expires_at) - 30000,
  'start_test is idempotent: a page refresh does not reset or extend timers');
ok((await q('select starts from public.test_reservations where tester_id=$1', [T1]))[0].starts === 1, 'idempotent start does not count as a new start');
ok(await failsWith(() => start(T2, c1), 'campaign_reserved'), 'second tester cannot reserve a reserved campaign');
const pageT1 = await page(T1, c1);
ok(pageT1.project_url === URL_ && pageT1.reserved_by_me === true, 'holder gets the website URL');
const pageT2 = await page(T2, c1);
ok(pageT2.project_url === null && pageT2.reserved_by_other === true && pageT2.reserved_by_me === false, 'other tester sees "busy" and NO url');
ok((await feed(T2)).every((r) => r.campaign_id !== c1), 'reserved campaign is hidden from other testers’ feed');
const f1 = (await feed(T1)).find((r) => r.campaign_id === c1);
ok(f1 && f1.reserved_by_me === true, 'holder still sees it first in own feed (continue test)');
ok((await status(T1)).active_reservation.campaign_id === c1, 'get_my_status reports the live reservation');

console.log('\n[one live reservation per tester]');
const o2 = await mk();
const c2 = await create(o2);
let det = null;
try { await start(T1, c2); } catch (e) { det = { msg: e.message, detail: e.detail }; }
ok(det && det.msg.includes('reservation_exists') && det.detail === c1, 'second reservation while one is live -> reservation_exists (points at the live one)', JSON.stringify(det));

console.log('\n[founder can see THAT a test is in progress, never WHO]');
ok((await as(owner, () => q('select campaign_id, expires_at, consumed_at from public.test_reservations'))).length === 1, 'owner sees the reservation on own campaign');
ok(await failsWith(() => as(owner, () => q('select tester_id from public.test_reservations')), 'permission denied'), 'owner cannot read tester_id of a reservation');
ok((await as(T2, () => q('select campaign_id from public.test_reservations'))).length === 0, 'unrelated user sees no reservations');

console.log('\n[cancel is refused while a tester is mid-test]');
const balBefore = await bal(owner);
ok(await failsWith(() => cancel(owner, c1), 'campaign_reserved'), 'cancel -> campaign_reserved');
ok((await bal(owner)) === balBefore && (await campaignRow(c1)).status === 'open', 'no refund and campaign still open');

console.log('\n[60-second minimum testing time]');
const early = await fails(() => submitRaw(T1, c1));
ok(early && early.includes('too_fast'), 'immediate submit -> too_fast');
let tf = null; try { await submitRaw(T1, c1); } catch (e) { tf = Number(e.detail); }
ok(tf > 0 && tf <= 60, `too_fast reports seconds remaining (${tf})`);
ok((await q('select count(*)::int n from public.test_submissions where campaign_id=$1', [c1]))[0].n === 0 && (await bal(T1)) === 1, 'too-early submit stored nothing and awarded nothing');
await setElapsed(T1, c1, 59);
ok(await failsWith(() => submitRaw(T1, c1), 'too_fast'), 'still too_fast at 59 s of testing');
ok(await failsWith(() => submitRaw(T2, c1), 'reservation_required'), 'a tester without a reservation cannot submit (reservation_required)');
await setElapsed(T1, c1, 61);
const done1 = await submitRaw(T1, c1);
ok(done1.credits_awarded === 1 && done1.balance === 2, 'submit after >= 60 s succeeds: +1 credit');
ok((await campaignRow(c1)).status === 'completed', 'campaign completed');
ok((await q('select consumed_at from public.test_reservations where tester_id=$1 and campaign_id=$2', [T1, c1]))[0].consumed_at !== null, 'reservation marked consumed');
ok((await status(T1)).active_reservation === null, 'no live reservation after submit');
ok(await failsWith(() => submitRaw(T1, c1), 'already_tested'), 'a retry after success (e.g. lost response) gets already_tested, never "no credit earned"');
ok(await failsWith(() => submitRaw(T2, c1), 'campaign_closed'), 'a DIFFERENT tester on a completed campaign gets campaign_closed');
ok((await bal(T1)) === 2, 'and the retry awarded nothing extra');

console.log('\n[reservation expiry: automatic, safe, no lost work]');
const o3 = await mk();
const c3 = await create(o3);
const T3 = await mk();
await start(T3, c3);
await lapseReservation(T3, c3);
ok(await failsWith(() => submitRaw(T3, c3), 'reservation_expired'), 'submit on a lapsed reservation -> reservation_expired');
ok((await q('select count(*)::int n from public.test_submissions where campaign_id=$1', [c3]))[0].n === 0 && (await bal(T3)) === 1, 'nothing stored, nothing awarded');
ok((await feed(T2)).some((r) => r.campaign_id === c3), 'lapsed reservation frees the campaign in the feed automatically (no cron)');
ok((await status(T3)).active_reservation === null, 'lapsed reservation is not reported as live');
// someone else can take it now…
await start(T2, c3);
ok(await failsWith(() => start(T3, c3), 'campaign_reserved'), 'original tester cannot re-reserve while another holds it');
await lapseReservation(T2, c3);
// …and when free again the original tester may renew WITHOUT waiting 60 s again.
const renew = await start(T3, c3);
ok(Date.parse(renew.min_submit_at) < Date.parse(renew.server_now), 'renewed reservation keeps the original 60 s clock (min time already served)');
ok((await q('select starts from public.test_reservations where tester_id=$1 and campaign_id=$2', [T3, c3]))[0].starts === 2, 'renewal counts as a second start');
const doneRenew = await submitRaw(T3, c3);
ok(doneRenew.credits_awarded === 1, 'renewed tester can submit immediately and is rewarded');

console.log('\n[renewal cap: a tester cannot hog a campaign]');
const o4 = await mk(); const c4 = await create(o4); const T4 = await mk();
for (let i = 1; i <= 3; i++) { await start(T4, c4); await lapseReservation(T4, c4); }
ok(await failsWith(() => start(T4, c4), 'reservation_limit'), '4th start on the same campaign -> reservation_limit');
ok((await feed(T2)).some((r) => r.campaign_id === c4), 'campaign stays available to others');

console.log('\n[reward cap: 5 per rolling 24 h]');
const R = await mk(); // the rate-limited tester
const owners = []; const camps = [];
for (let i = 0; i < 7; i++) { const o = await mk(); owners.push(o); camps.push(await create(o)); }
for (let i = 0; i < 5; i++) await completeTest(R, camps[i]);
ok((await bal(R)) === 6, 'five rewarded tests: starter 1 + 5 = 6');
const s5 = await status(R);
ok(s5.rewards_24h === 5 && s5.daily_limit === 5 && s5.next_reward_slot_at !== null, 'get_my_status reports 5/5 and when the next slot opens');
ok(await failsWith(() => start(R, camps[5]), 'daily_limit'), 'start_test refuses the 6th test in 24 h (daily_limit)');
// Backstop: even if a reservation exists, submit_test enforces the cap itself.
await q(`insert into public.test_reservations (campaign_id, tester_id, first_started_at, started_at, expires_at)
         values ($1, $2, now() - interval '5 minutes', now() - interval '5 minutes', now() + interval '10 minutes')`, [camps[5], R]);
ok(await failsWith(() => submitRaw(R, camps[5]), 'daily_limit'), 'submit_test enforces the cap too (reservation alone is not enough)');
ok((await bal(R)) === 6 && (await campaignRow(camps[5])).status === 'open', 'over-cap submit awarded nothing and left the campaign open');
await q('delete from public.test_reservations where tester_id=$1 and consumed_at is null', [R]);
await ageReward(R, 23);
ok(await failsWith(() => start(R, camps[5]), 'daily_limit'), 'window is rolling: a reward 23 h old still counts');
await ageReward(R, 25);
ok((await status(R)).rewards_24h === 4, 'a reward 25 h old falls out of the window');
const s6 = await completeTest(R, camps[5]);
ok(s6.credits_awarded === 1, 'next test is rewarded once a slot is free');
ok(await failsWith(() => start(R, camps[6]), 'daily_limit'), 'and the cap applies again immediately (5 in window)');

console.log('\n[cancel + refund exactly once]');
const oc = await mk(); const cc = await create(oc);
ok((await bal(oc)) === 0, 'owner spent the starter credit');
const k1 = await cancel(oc, cc);
ok(k1.status === 'cancelled' && k1.refunded === true && k1.balance === 1, 'cancel refunds 1 credit');
const cr = await campaignRow(cc);
ok(cr.status === 'cancelled' && cr.closed_at !== null && cr.response_count === 0, 'campaign cancelled with closed_at set');
const k2 = await cancel(oc, cc);
ok(k2.refunded === false && k2.balance === 1, 'second cancel is a no-op: no second refund');
ok((await ledger(oc, 'campaign_refund')).length === 1 && (await bal(oc)) === 1, 'exactly one refund row, balance 1');
ok(await failsWith(() => q(`insert into public.credit_ledger (user_id, delta, reason, campaign_id) values ($1, 1, 'campaign_refund', $2)`, [oc, cc]), 'credit_ledger_one_refund'), 'unique index blocks a duplicate refund row (backstop)');
const Tc = await mk();
ok(await failsWith(() => start(Tc, cc), 'campaign_closed'), 'cancelled campaign cannot be reserved');
ok((await feed(Tc)).every((r) => r.campaign_id !== cc), 'cancelled campaign leaves the feed');
ok(await failsWith(() => cancel(Tc, cc), 'campaign_not_found'), 'non-owner cancel -> campaign_not_found (no existence leak)');
ok(await failsWith(() => cancel(owner, c1), 'campaign_closed'), 'completed campaign (has feedback) can NOT be cancelled/refunded');
ok((await bal(owner)) === balBefore, 'owner of the completed campaign got no refund');
const cc2 = await create(oc);
ok((await bal(oc)) === 0 && typeof cc2 === 'string', 'refunded credit is spendable again');

console.log('\n[expiry settlement + refund exactly once]');
const oe = await mk(); const ce = await create(oe);
await expireCampaign(ce);
const Te = await mk();
ok((await feed(Te)).every((r) => r.campaign_id !== ce), 'expired campaign is hidden from the feed even BEFORE settlement');
ok((await page(Te, ce)) === null, 'expired campaign page is unavailable');
ok(await failsWith(() => start(Te, ce), 'campaign_expired'), 'expired campaign cannot be reserved');
ok((await bal(oe)) === 0, 'not refunded yet (lazy settlement)');
ok((await settle(Te)) >= 1, 'any signed-in client can trigger settlement');
const er = await campaignRow(ce);
ok(er.status === 'expired' && er.closed_at !== null, 'campaign marked expired');
ok((await bal(oe)) === 1 && (await ledger(oe, 'campaign_refund')).length === 1, 'owner refunded exactly 1 credit');
ok((await settle(Te)) === 0 && (await settle(oe)) === 0, 'repeat settlement does nothing');
ok((await bal(oe)) === 1 && (await ledger(oe, 'campaign_refund')).length === 1, 'still exactly one refund (no double refund)');
ok((await cancel(oe, ce)).refunded === false && (await bal(oe)) === 1, 'cancelling an already-expired campaign refunds nothing');

console.log('\n[expiry never strands a tester or eats feedback]');
const of = await mk(); const cf = await create(of); const Tf = await mk();
await start(Tf, cf);
await expireCampaign(cf);                 // expires WHILE the tester is mid-test
ok((await settle(Tf)) === 0 && (await campaignRow(cf)).status === 'open', 'settlement skips a campaign with a live reservation');
ok((await bal(of)) === 0, 'owner not refunded while a test is in progress');
ok((await page(Tf, cf))?.project_url === URL_, 'the tester can keep working on it');
await ageReservation(Tf, cf, 61);
const finished = await submitRaw(Tf, cf);
ok(finished.credits_awarded === 1, 'tester finishes after expiry and is rewarded');
ok((await campaignRow(cf)).status === 'completed', 'campaign becomes completed, not expired');
ok((await settle(Tf)) === 0 && (await bal(of)) === 0 && (await ledger(of, 'campaign_refund')).length === 0, 'a completed campaign is never refunded');
// Completed + past expiry + settlement must not touch the feedback.
const subsBefore = await q('select id, friction, suggestion, ux_rating from public.test_submissions order by id');
await expireCampaign(cf);
await settle(Tf); await settle(of);
ok(await failsWith(() => cancel(of, cf), 'campaign_closed'), 'completed campaign cannot be cancelled');
const subsAfter = await q('select id, friction, suggestion, ux_rating from public.test_submissions order by id');
ok(JSON.stringify(subsBefore) === JSON.stringify(subsAfter) && subsAfter.length >= 5, `all ${subsAfter.length} feedback rows byte-identical after cancel/expire/settle attempts`);
// Defence in depth: even called directly (superuser, bypassing the public RPC guards), the refund
// helper refuses campaigns that have feedback or are already closed.
const ownerOfCf = (await q('select owner_id from public.campaigns where id=$1', [cf]))[0].owner_id;
const balCf = await bal(ownerOfCf);
ok((await q(`select public.close_campaign_refund($1, 'expired') r`, [cf]))[0].r === null, 'refund helper returns NULL for a completed campaign');
ok((await q(`select public.close_campaign_refund($1, 'expired') r`, [cc]))[0].r === null, 'refund helper returns NULL for an already cancelled campaign');
ok((await campaignRow(cf)).status === 'completed' && (await bal(ownerOfCf)) === balCf && (await ledger(ownerOfCf, 'campaign_refund')).length === 0, 'helper changed nothing and refunded nothing');
const og = await mk(); const cg = await create(og); const Tg = await mk();
await start(Tg, cg); await lapseReservation(Tg, cg); await expireCampaign(cg);
ok((await settle(Tg)) === 1 && (await bal(og)) === 1, 'a LAPSED reservation does not block expiry refund');

console.log('\n[expired / reserved / cancelled campaigns cannot starve the feed]');
const many = []; const manyOwners = [];
for (let i = 0; i < 60; i++) { const o = await mk(); manyOwners.push(o); many.push(await create(o, { name: `Bulk ${i}` })); }
// Make the 52 OLDEST dead (expired) and the next one reserved; the 7 newest stay eligible.
for (let i = 0; i < 52; i++) {
  await q(`update public.campaigns set created_at = now() - interval '9 days' + make_interval(secs => $2), expires_at = now() - interval '1 day' where id=$1`, [many[i], i]);
}
const Thold = await mk();
await start(Thold, many[52]);
const Tview = await mk();
const view = await feed(Tview);
const viewIds = new Set(view.map((r) => r.campaign_id));
const others = view.filter((r) => !many.includes(r.campaign_id)).length; // earlier scenarios' still-open campaigns
ok(many.slice(53).every((id) => viewIds.has(id)) && view.length === 7 + others,
  `all 7 live bulk campaigns are visible although the 52 OLDEST campaigns are expired and the next is reserved (feed=${view.length}: 7 + ${others} unrelated open)`);
ok(many.slice(0, 53).every((id) => !viewIds.has(id)), 'no expired or reserved campaign appears');
ok(view.length <= 50, 'feed stays bounded at 50');
let total = 0; const counts = [];
for (let i = 0; i < 5; i++) { const n = await settle(Tview); counts.push(n); total += n; }
ok(counts[0] === 25 && counts[1] === 25 && counts[2] === 2 && total === 52, `settlement is bounded to 25 per call and clears all 52 expired (${counts.join('+')})`);
ok((await Promise.all(manyOwners.slice(0, 52).map(bal))).every((b) => b === 1), 'all 52 expired owners refunded exactly 1');
ok((await Promise.all(manyOwners.slice(52).map(bal))).every((b) => b === 0), 'owners of reserved/live campaigns not refunded');
ok((await q(`select count(*)::int n from public.credit_ledger where reason='campaign_refund'`))[0].n === (await q(`select count(*)::int n from public.campaigns where status in ('cancelled','expired')`))[0].n,
  'refund rows == cancelled+expired campaigns (one each)');

console.log('\n[global invariants]');
const drift = await q(`select p.id from public.profiles p left join public.credit_ledger l on l.user_id = p.id
                        group by p.id having p.credit_balance <> coalesce(sum(l.delta),0)`);
ok(drift.length === 0, 'balance == SUM(ledger) for every user');
const neg = await q('select count(*)::int n from public.profiles where credit_balance < 0');
ok(neg[0].n === 0, 'no negative balance anywhere');
const supply = (await q(`select coalesce(sum(credit_balance),0)::int s, (select count(*)::int from public.profiles) n,
                                (select count(*)::int from public.campaigns where status='open') o from public.profiles`))[0];
ok(supply.s + supply.o === supply.n, `credits conserved: balances(${supply.s}) + open campaigns holding one(${supply.o}) == identities(${supply.n})`);
const dupRefund = await q(`select campaign_id from public.credit_ledger where reason='campaign_refund' group by campaign_id having count(*) > 1`);
ok(dupRefund.length === 0, 'no campaign has two refunds');
const refundAndReward = await q(`select c.id from public.campaigns c where c.status in ('cancelled','expired')
                                   and exists (select 1 from public.test_submissions s where s.campaign_id = c.id)`);
ok(refundAndReward.length === 0, 'no refunded (cancelled/expired) campaign has feedback');
const dupReward = await q(`select campaign_id from public.credit_ledger where reason='test_reward' group by campaign_id, user_id having count(*) > 1`);
ok(dupReward.length === 0, 'no double rewards');

console.log('\n[cancel after the reservation lapsed]');
{
  const ol = await mk(); const cl = await create(ol); const Tl = await mk();
  await start(Tl, cl);
  ok(await failsWith(() => cancel(ol, cl), 'campaign_reserved'), 'live reservation blocks cancel');
  await lapseReservation(Tl, cl);
  const kl = await cancel(ol, cl);
  ok(kl.refunded === true && (await bal(ol)) === 1, 'once the reservation has lapsed the founder can cancel and is refunded');
  ok(await failsWith(() => submitRaw(Tl, cl), 'campaign_closed'), 'the lapsed tester can no longer submit to the cancelled campaign');
}

console.log('\n[a malformed campaign cannot stop everyone else’s refunds]');
{
  // Poison: an overdue campaign whose spend row is missing (cannot happen via the API, but production
  // data can be edited by hand). It sorts FIRST (oldest expiry) on every settle call.
  const op = await mk(); const cp = await create(op);
  const oh = await mk(); const ch = await create(oh);
  await expireCampaign(cp); await expireCampaign(ch);
  await q(`update public.campaigns set expires_at = now() - interval '3 days', created_at = now() - interval '10 days' where id = $1`, [cp]);
  await q(`delete from public.credit_ledger where campaign_id = $1 and reason = 'campaign_spend'`, [cp]);
  const settler = await mk();
  const n1 = await settle(settler);
  ok(n1 === 1, 'settlement completes and refunds the healthy campaign (' + n1 + ')');
  ok((await bal(oh)) === 1 && (await ledger(oh, 'campaign_refund')).length === 1, 'healthy owner refunded exactly once');
  ok((await campaignRow(cp)).status === 'open' && (await ledger(op, 'campaign_refund')).length === 0, 'the poison campaign is left untouched (no partial refund)');
  ok((await settle(settler)) === 0 && (await settle(op)) === 0, 'repeat calls keep working instead of failing forever');
}

summary();
