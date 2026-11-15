// Rehearsal of the PRODUCTION upgrade path for migration 4:
//   * Supabase settings: "automatic table exposure" DISABLED (no default grants) + "automatic RLS" ENABLED
//   * migrations 1-3 already applied and the database already holding real rows
//   * THEN migration 4 is applied on top.
// Proves the migration applies on a populated database, backfills correctly, loses nothing, and that
// every privilege it needs is granted explicitly.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, uid } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mig = (f) => readFileSync(join(here, '..', 'migrations', f), 'utf8');
const M4 = '20261114000100_lifecycle_antiabuse.sql';

const { db, as, q, ok, fails, summary } = await createHarness({
  migrations: ['20261113000100_schema.sql', '20261113000200_rls.sql', '20261113000300_rpc.sql'],
  exposureDisabled: true,
  autoRls: true,
});

console.log('\n[production-like data BEFORE the upgrade]');
for (let i = 1; i <= 5; i++) {
  await db.query('insert into auth.users (id) values ($1)', [uid(i)]);
  await as(uid(i), () => q('select * from public.ensure_profile()'));
}
const TASK = 'Find the pricing page and tell me which plan you would pick.';
const doneCamp = (await as(uid(1), () => q(`select public.create_project_with_campaign('Old done','https://example.com','d',$1) id`, [TASK])))[0].id;
// OLD submit_test: no reservation needed in migration 3.
await as(uid(2), () => q(`select public.submit_test($1,true,'The pricing link was hidden.','Add pricing to the nav.',4,true)`, [doneCamp]));
const openCamp = (await as(uid(3), () => q(`select public.create_project_with_campaign('Old open','https://example.org','d',$1) id`, [TASK])))[0].id;
await q(`update public.campaigns set created_at = now() - interval '2 days' where id = $1`, [openCamp]);
const snapshot = async () => (await q(`select
    (select count(*) from public.test_submissions)::int subs,
    (select md5(string_agg(id::text || friction || suggestion || ux_rating::text || share_consent::text, '|' order by id)) from public.test_submissions where campaign_id = (select c.id from public.campaigns c join public.projects p on p.id = c.project_id where p.name = 'Old done')) subs_hash,
    (select count(*) from public.credit_ledger)::int ledger,
    (select coalesce(sum(credit_balance),0) from public.profiles)::int credits,
    (select count(*) from public.projects)::int projects`))[0];
const before = await snapshot();

console.log('\n[apply migration 4 on the populated database]');
let err = null;
try { await db.exec(mig(M4)); } catch (e) { err = e.message; }
ok(err === null, 'migration 4 applies cleanly on a populated database', err ?? '');

console.log('\n[existing data intact and backfilled]');
const after = await snapshot();
ok(JSON.stringify(before) === JSON.stringify(after), 'feedback (byte-identical), ledger rows, total credits and projects are unchanged', JSON.stringify([before, after]));
const rows = await q('select id, status, extract(epoch from (expires_at - created_at))::int d from public.campaigns');
ok(rows.length === 2 && rows.every((r) => r.d === 7 * 86400), 'every existing campaign got expires_at = created_at + 7 days');
ok(rows.find((r) => r.id === doneCamp).status === 'completed' && rows.find((r) => r.id === openCamp).status === 'open', 'statuses unchanged');
const flags = await q(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`);
ok(flags.length === 6 && flags.every((r) => r.relrowsecurity), 'RLS is enabled on all 6 public tables incl. the new test_reservations');

console.log('\n[with NO default grants, every privilege the new code needs is explicit]');
const tester = uid(4);
const feed = await as(tester, () => q('select * from public.list_open_campaigns()'));
ok(feed.some((r) => r.campaign_id === openCamp), 'pre-existing open campaign appears in the new feed');
ok((await as(tester, () => q('select project_url from public.get_campaign_for_test($1)', [openCamp])))[0].project_url === null, 'URL hidden until reserved');
ok(!!(await as(tester, () => q('select public.start_test($1) r', [openCamp])))[0].r.reservation_expires_at, 'start_test works for authenticated');
ok((await as(tester, () => q('select project_url from public.get_campaign_for_test($1)', [openCamp])))[0].project_url === 'https://example.org', 'URL revealed to the holder');
await q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds', started_at = started_at - interval '61 seconds' where tester_id = $1`, [tester]);
ok((await as(tester, () => q(`select public.submit_test($1,true,'Friction text here.','Suggestion text here.',3,false) r`, [openCamp])))[0].r.credits_awarded === 1, 'submit_test works end-to-end after the upgrade');
ok((await as(uid(3), () => q('select campaign_id, expires_at, consumed_at from public.test_reservations'))).length === 1, 'founder can read the granted reservation columns');
ok(await fails(() => as(uid(3), () => q('select tester_id from public.test_reservations'))) !== null, 'founder cannot read tester_id');
for (const [name, f] of [
  ['anon start_test', () => as(null, () => q(`select public.start_test('${openCamp}')`))],
  ['anon settle', () => as(null, () => q('select public.settle_expired_campaigns()'))],
  ['anon table', () => as(null, () => q('select * from public.test_reservations'))],
  ['authenticated direct insert', () => as(tester, () => q(`insert into public.test_reservations (campaign_id, tester_id, expires_at) values ('${openCamp}', '${tester}', now() + interval '1 day')`))],
  ['authenticated refund helper', () => as(tester, () => q(`select public.close_campaign_refund('${openCamp}', 'expired')`))],
]) ok((await fails(f)) !== null, `denied: ${name}`);

console.log('\n[a legacy completed campaign past its deadline is never refunded]');
await q(`update public.campaigns set created_at = now() - interval '9 days', expires_at = now() - interval '2 days' where id = $1`, [doneCamp]);
ok((await as(uid(5), () => q('select public.settle_expired_campaigns() n')))[0].n === 0, 'settlement ignores it');
ok(JSON.stringify(await snapshot()) !== undefined && (await snapshot()).subs_hash === before.subs_hash, 'its feedback is still byte-identical');

console.log('\n[migration 5 (referrals) on the same populated database]');
const M5 = '20261114000200_referrals.sql';
const profilesBefore = (await q('select count(*)::int n from public.profiles'))[0].n;
const ledgerBefore = await q('select id, user_id, delta, reason, campaign_id from public.credit_ledger order by id');
let err5 = null;
try { await db.exec(mig(M5)); } catch (e) { err5 = e.message; }
ok(err5 === null, 'migration 5 applies cleanly on a populated database', err5 ?? '');
const codes = await q('select ref_code from public.profiles');
ok(codes.length === profilesBefore && codes.every((r) => /^[a-z0-9]{12}$/.test(r.ref_code)), 'every EXISTING identity got a valid ref_code');
ok(new Set(codes.map((r) => r.ref_code)).size === codes.length, 'backfilled codes are unique (volatile default evaluated per row)');
const ledgerAfter = await q('select id, user_id, delta, reason, campaign_id from public.credit_ledger order by id');
ok(JSON.stringify(ledgerBefore) === JSON.stringify(ledgerAfter), 'existing ledger rows are unchanged');
const flags5 = await q("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = 'referrals'");
ok(flags5.length === 1 && flags5[0].relrowsecurity, 'referrals table exists with RLS enabled');
const newcomer = uid(6);
await db.query('insert into auth.users (id) values ($1)', [newcomer]);
await as(newcomer, () => q('select * from public.ensure_profile()'));
const referrerCode = (await as(uid(1), () => q('select ref_code from public.profiles')))[0].ref_code;
ok((await as(newcomer, () => q('select public.claim_referral($1) r', [referrerCode])))[0].r.claimed === true, 'claim_referral works with NO default grants');
ok((await as(newcomer, () => q('select public.get_my_referrals() r')))[0].r.cap === 3, 'get_my_referrals works');
ok((await as(newcomer, () => q('select public.settle_referral_rewards() n')))[0].n === 0, 'settle_referral_rewards works (nothing due yet)');
ok(await fails(() => as(newcomer, () => q('select * from public.referrals'))) !== null, 'referrals table is not readable by clients');
ok(await fails(() => as(newcomer, () => q('select * from public.credit_ledger'))) !== null, 'select * on the ledger is now rejected (referee_id hidden)');
ok(!(await fails(() => as(uid(1), () => q('select id, user_id, delta, reason, campaign_id, created_at from public.credit_ledger')))), 'the explicit column list the app uses still works');
ok(await fails(() => as(null, () => q("select public.claim_referral('abcdefabcdef')"))) !== null, 'anon cannot call claim_referral');

summary();
