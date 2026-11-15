// REAL-PROJECT check of the two things that need the clock to move: 7-day EXPIRY (+ refund) and the
// 15-minute RESERVATION LAPSE. The public API cannot move time, so ONE human-reviewed SQL statement
// per scenario shifts timestamps on the test rows only (selected by a unique marker in the project name).
//
//   node tests/live/expiry-check.mjs prepare   -> creates 3 anonymous identities + 2 marked campaigns, reserves one,
//                                                 prints the exact SQL to run in the Supabase SQL Editor
//   (you run the printed SQL in the SQL Editor; each statement must report "UPDATE 1")
//   node tests/live/expiry-check.mjs verify    -> asserts expiry/refund/lapse behaviour through the public API
//
// Guarded like live-e2e.mjs (PEERPROBE_LIVE_TESTS=1). The script itself never sends anything but sign-ups,
// reads and the app's own RPCs; the only data-changing SQL is what it PRINTS for you to review and run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

if (process.env.PEERPROBE_LIVE_TESTS !== '1') { console.error('Set PEERPROBE_LIVE_TESTS=1 to confirm this writes test data to the project in .env.local.'); process.exit(2); }
const mode = process.argv[2];
if (!['prepare', 'verify'].includes(mode)) { console.error('usage: expiry-check.mjs prepare|verify'); process.exit(2); }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = join(root, '.env.local');
const fileEnv = existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])) : {};
const URL_ = (process.env.PEERPROBE_URL ?? fileEnv.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.PEERPROBE_KEY ?? fileEnv.VITE_SUPABASE_ANON_KEY ?? '';
if (!URL_ || !KEY || /^sb_secret_/.test(KEY)) { console.error('Need the public URL + publishable key in .env.local (never a secret key).'); process.exit(2); }
const STATE = process.env.EXPIRY_STATE_FILE ?? join(tmpdir(), 'peerprobe-expiry-state.json'); // outside the repo

let pass = 0, fail = 0;
const ok = (c, n, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const j = (o) => JSON.stringify(o);
async function call(method, path, token, body) {
  const h = { apikey: KEY, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(URL_ + path, { method, headers: h, body: body === undefined ? undefined : j(body) });
  const t = await r.text(); let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return { status: r.status, data };
}
const rpc = (fn, u, args = {}) => call('POST', `/rest/v1/rpc/${fn}`, u?.token, args);
const get = (p, u) => call('GET', `/rest/v1/${p}`, u?.token);
const msg = (r) => (r.data && (r.data.message || r.data.msg)) || '';
const bal = async (u) => (await get('profiles?select=credit_balance', u)).data?.[0]?.credit_balance;
async function newUser(label) {
  const r = await call('POST', '/auth/v1/signup', null, { data: {} });
  if (r.status !== 200 || !r.data?.access_token) throw new Error(`sign-in failed (${label}): ${r.status} ${j(r.data)}`);
  return { label, token: r.data.access_token, refresh: r.data.refresh_token, id: r.data.user.id };
}
async function refreshed(u) {
  const r = await call('POST', '/auth/v1/token?grant_type=refresh_token', null, { refresh_token: u.refresh });
  if (r.status !== 200) throw new Error(`token refresh failed (${u.label}): ${r.status} ${j(r.data)}`);
  return { ...u, token: r.data.access_token, refresh: r.data.refresh_token };
}
const TASK = 'Open the homepage and tell me what the product does in one sentence.';

if (mode === 'prepare') {
  const tag = randomBytes(4).toString('hex');
  const markExpiry = `ZZ-EXPIRY-CHECK-${tag}`;
  const markLapse = `ZZ-LAPSE-CHECK-${tag}`;
  const [E1, E2, T] = await Promise.all(['E1', 'E2', 'T'].map(newUser));
  await Promise.all([E1, E2, T].map((u) => rpc('ensure_profile', u)));
  const c1 = await rpc('create_project_with_campaign', E1, { p_name: markExpiry, p_url: 'https://example.com/', p_description: null, p_task: TASK });
  const c2 = await rpc('create_project_with_campaign', E2, { p_name: markLapse, p_url: 'https://example.com/', p_description: null, p_task: TASK });
  const rs = await rpc('start_test', T, { p_campaign_id: c2.data });
  ok(c1.status === 200 && c2.status === 200 && rs.status === 200, 'prepared: two marked campaigns created, tester T holds a live reservation on the second', j([c1.data, c2.data, rs.data]));
  ok((await bal(E1)) === 0 && (await bal(E2)) === 0, 'both owners spent their starter credit (balance 0) — nothing refunded yet');
  writeFileSync(STATE, j({ tag, markExpiry, markLapse, E1, E2, T, c1: c1.data, c2: c2.data }));
  if (fail) process.exit(1);
  console.log(`\nState saved to ${STATE} (outside the repo; contains throw-away anonymous test tokens).`);
  const [ID1, ID2, OWN1, OWN2, TST] = [c1.data, c2.data, E1.id, E2.id, T.id];
  console.log(`
TEST RECORDS CREATED (all throw-away, anonymous):
  expiry campaign : ${ID1}   project "${markExpiry}"   owner ${OWN1}
  lapse  campaign : ${ID2}   project "${markLapse}"   owner ${OWN2}   reserved by tester ${TST}

════════════════════════════════════════════════════════════════════════════
STEP A — READ-ONLY checks (run these first; they change nothing)
════════════════════════════════════════════════════════════════════════════
-- A1: the two campaigns. Expect exactly 2 rows, status 'open', owner_ids as listed above.
select c.id, c.owner_id, c.status, c.response_count, c.created_at, c.expires_at, p.name
  from public.campaigns c join public.projects p on p.id = c.project_id
 where c.id in ('${ID1}', '${ID2}');

-- A2: the reservation B2 will move. Expect exactly 1 row: tester_id = ${TST}, consumed_at null.
-- (The reservation's own id is shown here for your records; it is also unique per (campaign, tester).)
select r.id, r.campaign_id, r.tester_id, r.first_started_at, r.started_at, r.expires_at, r.consumed_at, r.starts
  from public.test_reservations r
 where r.campaign_id = '${ID2}';

-- A3: how many rows each UPDATE below will touch. Expect b1_rows = 1 AND b2_rows = 1.
select
  (select count(*) from public.campaigns c join public.projects p on p.id = c.project_id
    where c.id = '${ID1}' and c.owner_id = '${OWN1}' and p.name = '${markExpiry}'
      and c.status = 'open' and c.response_count = 0) as b1_rows,
  (select count(*) from public.test_reservations r
    where r.campaign_id = '${ID2}' and r.tester_id = '${TST}' and r.consumed_at is null
      and exists (select 1 from public.campaigns c join public.projects p on p.id = c.project_id
                   where c.id = r.campaign_id and p.name = '${markLapse}')) as b2_rows;

════════════════════════════════════════════════════════════════════════════
STEP B — MODIFIES PRODUCTION DATA. Each statement is pinned by UUID(s) + marker and
         returns the changed row (RETURNING). Run ONLY if A3 shows 1 and 1, and each
         statement must report exactly one returned row / "UPDATE 1".
════════════════════════════════════════════════════════════════════════════
-- B1: make the expiry campaign look 8 days old (its 7-day window has passed)
update public.campaigns c
   set created_at = now() - interval '8 days',
       expires_at = now() - interval '1 day'
  from public.projects p
 where c.id = '${ID1}'
   and c.owner_id = '${OWN1}'
   and p.id = c.project_id
   and p.name = '${markExpiry}'
   and c.status = 'open'
   and c.response_count = 0
returning c.id, c.owner_id, c.status, c.created_at, c.expires_at;

-- B2: make the tester's reservation look 20 minutes old (its 15-minute hold has lapsed)
update public.test_reservations r
   set first_started_at = r.first_started_at - interval '20 minutes',
       started_at       = r.started_at       - interval '20 minutes',
       expires_at       = r.expires_at       - interval '20 minutes'
 where r.campaign_id = '${ID2}'
   and r.tester_id   = '${TST}'
   and r.consumed_at is null
   and exists (select 1 from public.campaigns c join public.projects p on p.id = c.project_id
                where c.id = r.campaign_id and p.name = '${markLapse}')
returning r.id, r.campaign_id, r.tester_id, r.expires_at;

Neither statement deletes or inserts anything, and neither can match a row outside these
two test campaigns / this one reservation.

Afterwards run:  PEERPROBE_LIVE_TESTS=1 node tests/live/expiry-check.mjs verify`);
  process.exit(0);
}

// ─────────────────────────────── verify ───────────────────────────────
if (!existsSync(STATE)) { console.error(`No state file at ${STATE}. Run "prepare" first.`); process.exit(2); }
const S = JSON.parse(readFileSync(STATE, 'utf8'));
const [E1, E2, T] = await Promise.all([refreshed(S.E1), refreshed(S.E2), refreshed(S.T)]);
const Z = await newUser('Z'); await rpc('ensure_profile', Z);

console.log('\n[7-day expiry]');
const row1 = await get('campaigns?select=id,status,created_at,expires_at,closed_at', E1);
ok(row1.status === 200 && row1.data.length === 1 && row1.data[0].status === 'open' && Date.parse(row1.data[0].expires_at) < Date.now(), 'the shifted campaign is open but past its deadline (UPDATE B1 took effect)', j(row1));
ok(!(await rpc('list_open_campaigns', Z)).data.some((r) => r.campaign_id === S.c1), 'overdue campaign is ALREADY hidden from Discover, before any settlement');
ok(msg(await rpc('start_test', Z, { p_campaign_id: S.c1 })).includes('campaign_expired'), 'start_test on it -> campaign_expired');
ok((await rpc('get_campaign_for_test', Z, { p_campaign_id: S.c1 })).data?.length === 0, 'get_campaign_for_test returns nothing for it');
ok((await bal(E1)) === 0, 'owner not refunded yet (settlement is lazy)');
const s1 = await rpc('settle_expired_campaigns', Z);
ok(s1.status === 200 && s1.data >= 1, `settle_expired_campaigns (called by an unrelated user) settled ${s1.data} campaign(s)`, j(s1));
ok((await bal(E1)) === 1, 'owner refunded: balance 0 -> 1');
const after1 = await get('campaigns?select=id,status,closed_at,response_count', E1);
ok(after1.data[0].status === 'expired' && after1.data[0].closed_at !== null && after1.data[0].response_count === 0, 'campaign is now status=expired with closed_at set');
const ref1 = (await get('credit_ledger?select=delta,reason,campaign_id', E1)).data.filter((r) => r.reason === 'campaign_refund');
ok(ref1.length === 1 && ref1[0].delta === 1 && ref1[0].campaign_id === S.c1, 'exactly ONE refund ledger row of +1 for this campaign');
const [sa, sb] = await Promise.all([rpc('settle_expired_campaigns', Z), rpc('settle_expired_campaigns', E1)]);
ok(sa.status === 200 && sb.status === 200 && (await bal(E1)) === 1, 'two more settlements (in parallel) refund nothing further: balance stays 1');
ok((await get('credit_ledger?select=reason', E1)).data.filter((r) => r.reason === 'campaign_refund').length === 1, 'still exactly one refund row');
const cc = await rpc('cancel_campaign', E1, { p_campaign_id: S.c1 });
ok(cc.status === 200 && cc.data.refunded === false && (await bal(E1)) === 1, 'cancelling an already-expired campaign refunds nothing');

console.log('\n[15-minute reservation lapse]');
ok((await get('test_reservations?select=campaign_id,expires_at,consumed_at', E2)).data.every((r) => Date.parse(r.expires_at) < Date.now()), 'the shifted reservation is past its expiry (UPDATE B2 took effect)');
ok((await rpc('list_open_campaigns', Z)).data.some((r) => r.campaign_id === S.c2), 'lapsed reservation freed the campaign: it is back in Discover with no cron job');
const late = await rpc('submit_test', T, { p_campaign_id: S.c2, p_task_completed: true, p_friction: 'Friction notes after the lapse.', p_suggestion: 'Suggestion notes after the lapse.', p_ux_rating: 4, p_share_consent: false });
ok(late.status >= 400 && msg(late).includes('reservation_expired'), 'the lapsed tester cannot submit (reservation_expired)', j(late));
ok((await bal(T)) === 1 && (await get('test_submissions?select=id', T)).data.length === 0, 'nothing stored, nothing awarded');
const can = await rpc('cancel_campaign', E2, { p_campaign_id: S.c2 });
ok(can.status === 200 && can.data.refunded === true && can.data.balance === 1, 'with the reservation lapsed the founder can cancel and is refunded');
ok((await bal(E2)) === 1 && (await get('credit_ledger?select=reason', E2)).data.filter((r) => r.reason === 'campaign_refund').length === 1, 'balance 1, exactly one refund row');
ok(!(await rpc('list_open_campaigns', Z)).data.some((r) => r.campaign_id === S.c1 || r.campaign_id === S.c2), 'neither test campaign remains in Discover');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
