// REAL-PROJECT end-to-end test of referral links (migration 20261114000200): real anonymous auth, real PostgREST,
// real RLS, and genuinely concurrent requests (parallel claims, parallel settlers racing for ONE referrer's cap).
//
//   !! WRITES test data into the project in .env.local: ~10 anonymous identities, 4 campaigns (all completed
//   !! by the test itself, so nothing is left in Discover), 4 referrals and 3 referral-reward ledger rows.
//   !! Only the public publishable key is used, exactly like the browser. No DELETE/TRUNCATE anywhere.
//
// Prerequisite: ALL FIVE migrations applied. Takes ~80 s (the 60-second minimum testing time).
//   PowerShell:  $env:PEERPROBE_LIVE_TESTS="1"; node tests/live/referral-e2e.mjs
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.PEERPROBE_LIVE_TESTS !== '1') {
  console.error('Refusing to run: this test writes data to the Supabase project in .env.local.\nSet PEERPROBE_LIVE_TESTS=1 to confirm.');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = join(root, '.env.local');
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {};
const URL_ = (process.env.PEERPROBE_URL ?? fileEnv.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.PEERPROBE_KEY ?? fileEnv.VITE_SUPABASE_ANON_KEY ?? '';
if (!URL_ || !KEY || /^sb_secret_/.test(KEY)) { console.error('Need the public URL + publishable key in .env.local (never a secret key).'); process.exit(2); }
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
const get = (p, u) => call('GET', `/rest/v1/${p}`, u?.token);
const denied = (r) => r.status === 401 || r.status === 403 || r.status === 404;
const msg = (r) => (r.data && (r.data.message || r.data.msg)) || '';
async function newUser(label) {
  const r = await call('POST', '/auth/v1/signup', null, { data: {} });
  if (r.status !== 200 || !r.data?.access_token) throw new Error(`anonymous sign-in failed (${label}): ${r.status} ${j(r.data)}`);
  return { label, token: r.data.access_token, id: r.data.user.id };
}
const bal = async (u) => (await get('profiles?select=credit_balance', u)).data?.[0]?.credit_balance;
const LEDGER = 'credit_ledger?select=id,user_id,delta,reason,campaign_id,created_at';
const TASK = 'Open the homepage and tell me what the product does in one sentence.';
const create = (u, name) => rpc('create_project_with_campaign', u, { p_name: name, p_url: 'https://example.com/', p_description: null, p_task: TASK });
const fb = (id, n) => ({ p_campaign_id: id, p_task_completed: true, p_friction: `Friction notes from invitee ${n}.`, p_suggestion: `Suggestion notes from invitee ${n}.`, p_ux_rating: 4, p_share_consent: false });

console.log('[setup] 10 anonymous identities');
const [R, I1, I2, I3, I4, O1, O2, O3, O4, S] = await Promise.all(['R', 'I1', 'I2', 'I3', 'I4', 'O1', 'O2', 'O3', 'O4', 'S'].map(newUser));
const all = [R, I1, I2, I3, I4, O1, O2, O3, O4, S];
const profs = await Promise.all(all.map((u) => rpc('ensure_profile', u)));
ok(profs.every((p) => p.status === 200 && /^[a-z0-9]{12}$/.test(p.data.ref_code ?? '')), 'every identity got a 12-char ref_code from ensure_profile', j(profs[0].data));
const code = profs[0].data.ref_code;
ok(new Set(profs.map((p) => p.data.ref_code)).size === all.length, 'all codes are distinct');
ok((await get('profiles?select=id,ref_code', I1)).data.length === 1, 'a user can read only their own profile row, so only their own code');

console.log('\n[privileges]');
for (const [fn, args] of [['claim_referral', { p_code: code }], ['settle_referral_rewards', {}], ['get_my_referrals', {}]]) {
  const r = await rpc(fn, null, args);
  ok(denied(r), `anon RPC ${fn} denied`, `${r.status} ${j(r.data)}`);
}
ok(denied(await get('referrals?select=referrer_id', null)), 'anon cannot read referrals');
ok(denied(await get('referrals?select=referrer_id', R)), 'authenticated cannot read the referrals table either');
ok(denied(await get('credit_ledger?select=*', R)), 'select=* on the ledger is rejected (referee_id is not granted)');
ok(denied(await get('credit_ledger?select=referee_id', R)), 'referee_id is not readable by anyone');
ok((await get(LEDGER, R)).status === 200, 'the explicit column list the app uses still works');

console.log('\n[claims]');
for (const bad of ['', 'x', 'not-a-code', 'zzzzzzzzzzzz', "'; drop table profiles; --"]) {
  const r = await rpc('claim_referral', I1, { p_code: bad });
  ok(r.status === 200 && r.data.claimed === false && r.data.reason === 'invalid_code', `invalid code ${j(bad.slice(0, 16))} -> invalid_code, no error`, j(r));
}
ok((await rpc('claim_referral', R, { p_code: code })).data?.reason === 'self', 'cannot refer yourself');
const waves = await Promise.all([I1, I2, I3, I4].map((u) => rpc('claim_referral', u, { p_code: code.toUpperCase() })));
ok(waves.every((r) => r.status === 200 && r.data.claimed === true), '4 invitees claim IN PARALLEL (case-insensitive) — all succeed', j(waves.map((r) => r.data)));
const [dup1, dup2] = await Promise.all([rpc('claim_referral', I1, { p_code: code }), rpc('claim_referral', I1, { p_code: code })]);
ok([dup1, dup2].every((r) => r.data.claimed === false && r.data.reason === 'already_referred'), 'claiming again (even twice at once) is a no-op: already_referred', j([dup1.data, dup2.data]));
ok((await rpc('claim_referral', I2, { p_code: profs[5].data.ref_code })).data.reason === 'already_referred', 'an invitee cannot be re-assigned to another referrer');
ok(j((await rpc('claim_referral', R, { p_code: profs[1].data.ref_code })).data) === j((await rpc('claim_referral', R, { p_code: 'zzzzzzzzzzzz' })).data), 'mutual referral (the referrer "joining" via their own invitee) is refused, answered exactly like an unknown code');
ok(j((await rpc('claim_referral', I2, { p_code: code })).data) === j((await rpc('claim_referral', I2, { p_code: 'zzzzzzzzzzzz' })).data), 'an already-referred caller gets the same answer for a real and a fake code (no code oracle)');
const m0 = await rpc('get_my_referrals', R);
ok(m0.status === 200 && m0.data.code === code && m0.data.invited === 4 && m0.data.converted === 0 && m0.data.rewarded === 0 && m0.data.cap === 3, 'get_my_referrals: invited 4, converted 0, rewarded 0, cap 3', j(m0.data));
ok((await rpc('settle_referral_rewards', S)).data === 0, 'nothing is paid before the invitees have finished a test');

console.log('\n[the invitees each complete their FIRST real test]');
const owners = [O1, O2, O3, O4];
const camps = (await Promise.all(owners.map((o, i) => create(o, `Live P2 ${i + 1}`)))).map((r) => r.data);
const invitees = [I1, I2, I3, I4];
const starts = await Promise.all(invitees.map((u, i) => rpc('start_test', u, { p_campaign_id: camps[i] })));
ok(starts.every((r) => r.status === 200), 'each invitee reserves their own campaign', j(starts.map((r) => r.data)));
const t0 = Date.now();
console.log('  …waiting out the 60-second minimum testing time');
for (let left = 62; left > 0; left -= 10) { process.stdout.write(`  …${left}s\n`); await sleep(Math.min(10_000, left * 1000)); }
void t0;
const subs = await Promise.all(invitees.map((u, i) => rpc('submit_test', u, fb(camps[i], i + 1))));
ok(subs.every((r) => r.status === 200 && r.data.credits_awarded === 1), 'all 4 invitees complete a valid test and are rewarded', j(subs.map((r) => r.data ?? msg(r))));
ok((await bal(R)) === 1, 'the referrer has NOT been paid yet (settlement is lazy)');
const m1 = (await rpc('get_my_referrals', R)).data;
ok(m1.converted === 4 && m1.rewarded === 0, 'get_my_referrals: converted 4, rewarded 0', j(m1));

console.log('\n[REAL race] six settlers at once, all competing for ONE referrer’s cap of 3');
const wave = await Promise.all([S, R, O1, O2, I1, I2].map((u) => rpc('settle_referral_rewards', u)));
ok(wave.every((r) => r.status === 200 && Number.isInteger(r.data)), 'every concurrent settle call succeeds (no deadlock, no error)', j(wave.map((r) => r.data ?? msg(r))));
const paidWave = wave.reduce((a, r) => a + r.data, 0);
ok(paidWave <= 3, `the concurrent wave paid ${paidWave} reward(s) — never more than the cap of 3`);
let total = paidWave;
for (let i = 0; i < 4; i++) total += (await rpc('settle_referral_rewards', S)).data;
ok(total === 3, `repeated settling converges to exactly 3 rewards in total (got ${total}); the 4th invitee is not paid`);
ok((await bal(R)) === 4, 'referrer balance is exactly 1 + 3 = 4');
const led = (await get(LEDGER, R)).data;
ok(led.filter((r) => r.reason === 'referral_reward').length === 3 && led.filter((r) => r.reason === 'referral_reward').every((r) => r.delta === 1 && r.campaign_id === null), 'exactly three +1 referral_reward ledger rows');
const m2 = (await rpc('get_my_referrals', R)).data;
ok(m2.invited === 4 && m2.converted === 4 && m2.rewarded === 3, 'get_my_referrals: invited 4, converted 4, rewarded 3 (cap)', j(m2));
ok((await rpc('settle_referral_rewards', R)).data === 0 && (await bal(R)) === 4, 'settling again pays nothing');
for (const u of invitees) ok((await bal(u)) === 2, `${u.label}: invitee kept their own earned credit (1 starter + 1 test)`);

console.log('\n[a user who already earned a reward cannot be referred]');
{
  const r = await rpc('claim_referral', I1, { p_code: profs[6].data.ref_code });
  ok(r.data?.claimed === false && ['already_active', 'already_referred'].includes(r.data?.reason), 'an invitee who already finished a test cannot be re-referred to someone else', j(r.data));
}
const fresh = await newUser('N'); await rpc('ensure_profile', fresh);
all.push(fresh);

console.log('\n[invariants]');
let sum = 0, driftBad = 0, dupBad = 0;
for (const u of all) {
  const b = await bal(u);
  const l = (await get(LEDGER, u)).data;
  sum += b;
  if (l.reduce((a, r) => a + r.delta, 0) !== b) driftBad++;
  const keys = l.filter((r) => r.reason !== 'starter').map((r) => `${r.reason}:${r.campaign_id}:${r.id}`);
  if (new Set(keys).size !== keys.length) dupBad++;
}
ok(driftBad === 0, 'balance == SUM(ledger) for every identity');
ok(dupBad === 0, 'no duplicate ledger rows');
ok(sum === all.length + 3, `credits conserved: total balances ${sum} == identities ${all.length} + 3 referral rewards`);
const feed = (await rpc('list_open_campaigns', fresh)).data ?? [];
ok(!camps.some((id) => feed.some((r) => r.campaign_id === id)), 'none of this test’s campaigns remain in Discover');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
console.log('Identities:', all.map((u) => `${u.label}:${u.id.slice(0, 8)}`).join(' '));
process.exit(fail ? 1 : 0);
