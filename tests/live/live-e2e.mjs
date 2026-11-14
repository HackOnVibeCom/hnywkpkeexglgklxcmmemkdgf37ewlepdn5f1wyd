// REAL-PROJECT end-to-end test of the Phase 1 lifecycle: real Auth (anonymous sign-in), real
// PostgREST, real RLS, and REAL concurrency (parallel requests = parallel Postgres transactions).
//
//   !! This WRITES test data (about 9 anonymous identities, 4 campaigns, feedback) into the project
//   !! configured in .env.local. It closes every campaign it creates so nothing is left in Discover.
//   !! It only uses the public publishable/anon key, exactly like the browser does.
//
// Prerequisite: ALL FOUR migrations are applied to that project (it is a post-migration test).
// Run (takes ~75 s because of the 60-second minimum testing time):
//   PowerShell:  $env:PEERPROBE_LIVE_TESTS="1"; node tests/live/live-e2e.mjs
//   bash:        PEERPROBE_LIVE_TESTS=1 node tests/live/live-e2e.mjs
//
// Not covered here (cannot be done through the public API without waiting days or having admin
// rights): 7-day expiry and 15-minute reservation lapse against the real clock. Those are covered
// with simulated time in supabase/tests/lifecycle.mjs; see README "Manual check of expiry on a real project".
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.PEERPROBE_LIVE_TESTS !== '1') {
  console.error('Refusing to run: this test writes data to the Supabase project in .env.local.\nSet PEERPROBE_LIVE_TESTS=1 to confirm.');
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
function readEnvFile() {
  const f = join(root, '.env.local');
  if (!existsSync(f)) return {};
  return Object.fromEntries(
    readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}
const fileEnv = readEnvFile();
const URL_ = (process.env.PEERPROBE_URL ?? fileEnv.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.PEERPROBE_KEY ?? fileEnv.VITE_SUPABASE_ANON_KEY ?? '';
if (!URL_ || !KEY) { console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (.env.local).'); process.exit(2); }
if (/^sb_secret_/.test(KEY)) { console.error('Refusing to run with a secret key. Use the publishable/anon key.'); process.exit(2); }
console.log(`Target project: ${URL_}\n`);

let pass = 0, fail = 0;
const ok = (c, n, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const j = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, token, body) {
  const h = { apikey: KEY, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(URL_ + path, { method, headers: h, body: body === undefined ? undefined : j(body) });
  const t = await r.text(); let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return { status: r.status, data };
}
const rpc = (fn, u, args = {}) => call('POST', `/rest/v1/rpc/${fn}`, u?.token, args);
const get = (path, u) => call('GET', `/rest/v1/${path}`, u?.token);
const msg = (r) => (r.data && (r.data.message || r.data.msg)) || '';
const denied = (r) => r.status === 401 || r.status === 403 || r.status === 404;
const failedWith = (r, code) => r.status >= 400 && msg(r).includes(code);

async function newUser(label) {
  const r = await call('POST', '/auth/v1/signup', null, { data: {} });
  if (r.status !== 200 || !r.data?.access_token) throw new Error(`anonymous sign-in failed for ${label}: ${r.status} ${j(r.data)}`);
  return { label, token: r.data.access_token, id: r.data.user.id };
}
const bal = async (u) => (await get('profiles?select=credit_balance', u)).data?.[0]?.credit_balance;
const SITE = 'https://example.com/';
const TASK = 'Open the homepage and tell me what the product does in one sentence.';
const create = (u, name) => rpc('create_project_with_campaign', u, { p_name: name, p_url: SITE, p_description: null, p_task: TASK });
const fb = (id, n = 'x') => ({ p_campaign_id: id, p_task_completed: true, p_friction: `Friction notes from tester ${n}.`, p_suggestion: `Suggestion notes from tester ${n}.`, p_ux_rating: 4, p_share_consent: false });

console.log('[setup] 9 anonymous identities');
const [A, B, C, D, E, F, G, H, Z] = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Z'].map(newUser));
const all = [A, B, C, D, E, F, G, H, Z];
await Promise.all(all.map((u) => rpc('ensure_profile', u)));
ok((await Promise.all(all.map(bal))).every((b) => b === 1), 'every identity has exactly its 1 starter credit');

console.log('\n[privileges] no session may touch the new objects');
for (const fn of ['start_test', 'cancel_campaign', 'settle_expired_campaigns', 'get_my_status']) {
  const r = await rpc(fn, null, fn === 'start_test' || fn === 'cancel_campaign' ? { p_campaign_id: A.id } : {});
  ok(denied(r), `anon RPC ${fn} denied`, `${r.status} ${j(r.data)}`);
}
ok(denied(await get('test_reservations?select=campaign_id', null)), 'anon GET test_reservations denied');
{
  const r = await rpc('close_campaign_refund', A, { p_campaign_id: A.id, p_new_status: 'expired' });
  ok(denied(r), 'internal refund helper is not callable through the API', `${r.status} ${j(r.data)}`);
  const w = await call('POST', '/rest/v1/test_reservations', A.token, { campaign_id: A.id, tester_id: A.id });
  ok(w.status === 401 || w.status === 403, 'authenticated cannot INSERT reservations directly', `${w.status}`);
  const u = await call('PATCH', `/rest/v1/campaigns?id=eq.${A.id}`, A.token, { expires_at: '2099-01-01T00:00:00Z' });
  ok(u.status === 401 || u.status === 403, 'authenticated cannot extend campaign expiry', `${u.status}`);
}

console.log('\n[setup] owners spend their starter credit');
const [c1, cE, cF, cG] = await Promise.all([create(A, 'Live P1 A'), create(E, 'Live P1 E'), create(F, 'Live P1 F'), create(G, 'Live P1 G')]);
ok([c1, cE, cF, cG].every((r) => r.status === 200 && typeof r.data === 'string'), 'four campaigns created', j([c1.data, cE.data, cF.data, cG.data]));
const [id1, idE, idF, idG] = [c1.data, cE.data, cF.data, cG.data];
{
  const x = await get('campaigns?select=id,expires_at,created_at,status', A);
  const days = (Date.parse(x.data[0].expires_at) - Date.parse(x.data[0].created_at)) / 864e5;
  ok(x.status === 200 && Math.abs(days - 7) < 0.001, `campaign expires 7 days after creation (${days.toFixed(4)} d)`, j(x));
}

console.log('\n[reservation] exclusive, idempotent, URL gated');
{
  const pre = await rpc('get_campaign_for_test', B, { p_campaign_id: id1 });
  ok(pre.status === 200 && pre.data.length === 1 && pre.data[0].project_url === null, 'before reserving, the website URL is NOT returned', j(pre.data));
  const tB0 = Date.now();
  const starts = await Promise.all(Array.from({ length: 8 }, () => rpc('start_test', B, { p_campaign_id: id1 })));
  ok(starts.every((r) => r.status === 200), '8 PARALLEL start_test calls by the same tester all succeed', j(starts.map((r) => r.status)));
  ok(new Set(starts.map((r) => r.data.reservation_expires_at)).size === 1, 'they all return the SAME reservation (idempotent, no timer reset)');
  const mins = (Date.parse(starts[0].data.reservation_expires_at) - Date.parse(starts[0].data.server_now)) / 60e3;
  ok(Math.abs(mins - 15) < 0.01, `reservation lasts 15 minutes (${mins.toFixed(3)} min)`);
  const own = await get('test_reservations?select=campaign_id,expires_at,consumed_at', A);
  ok(own.status === 200 && own.data.length === 1, 'founder sees exactly ONE reservation row on their campaign', j(own));
  ok(denied(await get('test_reservations?select=tester_id', A)), 'founder cannot read tester_id');
  const pg = await rpc('get_campaign_for_test', B, { p_campaign_id: id1 });
  ok(pg.data[0].project_url === SITE && pg.data[0].reserved_by_me === true, 'holder now gets the URL');
  const pgC = await rpc('get_campaign_for_test', C, { p_campaign_id: id1 });
  ok(pgC.data[0].project_url === null && pgC.data[0].reserved_by_other === true, 'another tester sees "busy" and no URL');
  ok(!(await rpc('list_open_campaigns', C)).data.some((r) => r.campaign_id === id1), 'reserved campaign is hidden from other testers’ feed');
  ok((await rpc('list_open_campaigns', B)).data.some((r) => r.campaign_id === id1 && r.reserved_by_me), 'holder still sees it (continue test)');
  ok(failedWith(await rpc('start_test', C, { p_campaign_id: id1 }), 'campaign_reserved'), 'second tester cannot reserve it');
  ok(failedWith(await rpc('start_test', B, { p_campaign_id: idE }), 'reservation_exists'), 'one live reservation per tester');
  ok(failedWith(await rpc('start_test', A, { p_campaign_id: id1 }), 'own_campaign'), 'owner cannot reserve own campaign');
  const st = await rpc('get_my_status', B);
  ok(st.status === 200 && st.data.active_reservation?.campaign_id === id1 && st.data.rewards_24h === 0 && st.data.daily_limit === 5, 'get_my_status reports the live reservation and 0/5 rewards', j(st.data));

  console.log('\n[60-second minimum] early submit is refused, nothing stored');
  const early = await rpc('submit_test', B, fb(id1));
  ok(failedWith(early, 'too_fast'), 'immediate submit -> too_fast', j(early));
  ok((await get('test_submissions?select=id', B)).data.length === 0 && (await bal(B)) === 1, 'no feedback stored, no credit awarded');
  ok(failedWith(await rpc('cancel_campaign', A, { p_campaign_id: id1 }), 'campaign_reserved') && (await bal(A)) === 0, 'founder cannot cancel while a tester holds it; no refund');

  console.log('\n[REAL race] two testers reserve the same campaign at once');
  const [rC, rD] = await Promise.all([rpc('start_test', C, { p_campaign_id: idE }), rpc('start_test', D, { p_campaign_id: idE })]);
  const winners = [rC, rD].filter((r) => r.status === 200);
  ok(winners.length === 1, 'exactly ONE of two simultaneous reservations wins', j([rC.data, rD.data]));
  const loser = [rC, rD].find((r) => r.status !== 200);
  ok(loser && failedWith(loser, 'campaign_reserved'), 'the other gets campaign_reserved');
  const W = rC.status === 200 ? C : D; const L = W === C ? D : C;

  console.log('\n[cancel vs reservation]');
  ok((await rpc('start_test', H, { p_campaign_id: idG })).status === 200, 'H reserves campaign G');
  ok(failedWith(await rpc('cancel_campaign', G, { p_campaign_id: idG }), 'campaign_reserved') && (await bal(G)) === 0, 'G cannot cancel while H is testing; no refund');
  const tLast = Date.now();

  console.log('\n[REAL race] 6 parallel cancels of one campaign refund exactly once');
  const cancels = await Promise.all(Array.from({ length: 6 }, () => rpc('cancel_campaign', F, { p_campaign_id: idF })));
  const okC = cancels.filter((r) => r.status === 200);
  ok(okC.length >= 1 && okC.filter((r) => r.data.refunded === true).length === 1, 'exactly ONE call reports refunded:true', j(cancels.map((r) => r.data)));
  ok((await bal(F)) === 1, 'F balance is exactly 1 (starter 1 - spend 1 + ONE refund)');
  const fl = (await get('credit_ledger?select=delta,reason,campaign_id', F)).data;
  ok(fl.filter((r) => r.reason === 'campaign_refund').length === 1, 'exactly one campaign_refund ledger row');
  ok(failedWith(await rpc('start_test', Z, { p_campaign_id: idF }), 'campaign_closed'), 'cancelled campaign cannot be reserved');
  ok(!(await rpc('list_open_campaigns', Z)).data.some((r) => r.campaign_id === idF), 'cancelled campaign is not in the feed');
  const again = await rpc('cancel_campaign', F, { p_campaign_id: idF });
  ok(again.status === 200 && again.data.refunded === false && (await bal(F)) === 1, 're-cancelling later refunds nothing');
  ok(failedWith(await rpc('cancel_campaign', Z, { p_campaign_id: idF }), 'campaign_not_found'), 'non-owner cancel -> campaign_not_found');

  console.log('\n[settlement] callable, bounded, harmless when nothing is overdue');
  const se = await rpc('settle_expired_campaigns', Z);
  ok(se.status === 200 && Number.isInteger(se.data) && se.data >= 0 && se.data <= 25, `settle_expired_campaigns returns a small integer (${se.data})`, j(se));

  console.log('\n[wait] 60-second minimum testing time…');
  const earliest = Math.max(tB0, tLast); // all reservations started before tLast; wait 62 s after the LAST one
  const waitMs = Math.max(0, 62_000 - (Date.now() - earliest));
  for (let left = Math.ceil(waitMs / 1000); left > 0; left -= 10) { process.stdout.write(`  …${left}s\n`); await sleep(Math.min(10_000, left * 1000)); }

  console.log('\n[submit] REAL race: the same tester submits twice at once');
  const [s1, s2] = await Promise.all([rpc('submit_test', B, fb(id1, 'B')), rpc('submit_test', B, fb(id1, 'B2'))]);
  const sOk = [s1, s2].filter((r) => r.status === 200);
  ok(sOk.length === 1 && sOk[0].data.credits_awarded === 1 && sOk[0].data.balance === 2, 'exactly ONE submit is rewarded (+1 -> 2)', j([s1.data, s2.data]));
  ok((await bal(B)) === 2, 'B balance is 2, not 3');
  ok((await get('test_submissions?select=id', B)).data.length === 1, 'exactly one submission stored');
  const w = await rpc('submit_test', W, fb(idE, 'W'));
  ok(w.status === 200 && w.data.balance === 2, 'race winner submits after the minimum time and is rewarded');
  const lsub = await rpc('submit_test', L, fb(idE, 'L'));
  ok(lsub.status >= 400 && /campaign_closed|reservation_required/.test(msg(lsub)), 'race loser gets no reward', j(lsub));
  ok((await bal(L)) === 1, 'loser balance unchanged');
  const h = await rpc('submit_test', H, fb(idG, 'H'));
  ok(h.status === 200 && h.data.balance === 2, 'H completes campaign G');
  ok(failedWith(await rpc('submit_test', B, fb(id1, 'again')), 'already_tested'), 'a retry after success gets already_tested, no second reward');
  ok((await get('test_reservations?select=consumed_at', A)).data.every((r) => r.consumed_at !== null), 'reservation marked consumed after submit');

  console.log('\n[founder results + completed campaigns are protected]');
  const res = await get('test_submissions?select=id,campaign_id,task_completed,friction,suggestion,ux_rating,share_consent,created_at', A);
  ok(res.status === 200 && res.data.length === 1 && res.data[0].ux_rating === 4, 'A reads the real feedback');
  const cA = await get('campaigns?select=id,status,response_count', A);
  ok(cA.data[0].status === 'completed' && cA.data[0].response_count === 1, 'campaign completed');
  const cc = await rpc('cancel_campaign', A, { p_campaign_id: id1 });
  ok(failedWith(cc, 'campaign_closed') && (await bal(A)) === 0, 'a campaign WITH feedback can never be cancelled/refunded');
  ok((await get('test_submissions?select=id', A)).data.length === 1, 'feedback still there');
}

console.log('\n[invariants]');
let sum = 0; let driftBad = 0; let dupBad = 0;
for (const u of all) {
  const b = await bal(u);
  const l = (await get('credit_ledger?select=delta,reason,campaign_id', u)).data;
  const s = l.reduce((a, r) => a + r.delta, 0);
  sum += b; if (s !== b) driftBad++;
  const keys = l.filter((r) => r.reason !== 'starter').map((r) => `${r.reason}:${r.campaign_id}`);
  if (new Set(keys).size !== keys.length) dupBad++;
}
ok(driftBad === 0, 'balance == SUM(ledger) for every identity');
ok(dupBad === 0, 'no duplicate reward / refund / spend rows for any campaign');
ok(sum === all.length, `credits conserved: total balances ${sum} == identities ${all.length} (no open campaigns hold a credit)`);
{
  const feed = (await rpc('list_open_campaigns', Z)).data ?? [];
  ok(![id1, idE, idF, idG].some((id) => feed.some((r) => r.campaign_id === id)), 'none of this test’s campaigns remain in Discover');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
console.log('Identities:', all.map((u) => `${u.label}:${u.id.slice(0, 8)}`).join(' '));
process.exit(fail ? 1 : 0);
