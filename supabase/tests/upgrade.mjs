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

console.log('\n[migration 6 (targeted tester matching) on the same populated database]');
const M6 = '20261115000100_tester_matching.sql';
const campaignsBefore = await q('select id, owner_id, project_id, task_description, status, response_count, created_at, expires_at from public.campaigns order by id');
const subsBefore = await q('select id, friction, suggestion, ux_rating from public.test_submissions order by id');
const ledgerBefore6 = await q('select id, user_id, delta, reason, campaign_id from public.credit_ledger order by id');
const feedBefore = (await as(uid(6), () => q('select campaign_id from public.list_open_campaigns()'))).map((r) => r.campaign_id).sort();
let err6 = null;
try { await db.exec(mig(M6)); } catch (e) { err6 = e.message; }
ok(err6 === null, 'migration 6 applies cleanly on a populated database', err6 ?? '');
const campaignsAfter = await q('select id, owner_id, project_id, task_description, status, response_count, created_at, expires_at from public.campaigns order by id');
ok(JSON.stringify(campaignsBefore) === JSON.stringify(campaignsAfter), 'existing campaigns are unchanged (same ids, owners, tasks, statuses, timestamps)');
ok((await q('select count(*)::int n from public.campaigns where target_categories = $1::text[]', ['{}']))[0].n === campaignsAfter.length, 'every existing campaign reads as "no preference" (empty target_categories)');
ok(JSON.stringify(subsBefore) === JSON.stringify(await q('select id, friction, suggestion, ux_rating from public.test_submissions order by id')), 'feedback is byte-identical');
ok(JSON.stringify(ledgerBefore6) === JSON.stringify(await q('select id, user_id, delta, reason, campaign_id from public.credit_ledger order by id')), 'ledger rows are unchanged');
const tp = await q("select relrowsecurity from pg_class where oid = 'public.tester_profiles'::regclass");
ok(tp.length === 1 && tp[0].relrowsecurity, 'tester_profiles exists with RLS enabled');
ok((await q("select count(*)::int n from pg_policies where tablename = 'tester_profiles'"))[0].n === 0, 'and no policy (default deny)');
const feedAfter = (await as(uid(6), () => q('select campaign_id from public.list_open_campaigns()'))).map((r) => r.campaign_id).sort();
ok(JSON.stringify(feedBefore) === JSON.stringify(feedAfter), 'the OLD Discover RPC (used by the currently deployed UI) returns the same rows');
const matchedAfter = await as(uid(6), () => q('select * from public.list_matched_campaigns()'));
ok(JSON.stringify(matchedAfter.map((r) => r.campaign_id).sort()) === JSON.stringify(feedAfter) && matchedAfter.every((r) => r.target_categories.length === 0 && !r.is_recommended), 'the new matched feed lists the legacy campaigns, none recommended');
const oldCreate = (await as(uid(6), () => q("select public.create_project_with_campaign('Post-M6 legacy','https://example.net','d',$1) id", [TASK])))[0].id;
ok(!!oldCreate, 'the OLD create RPC still works after the upgrade (a deployed old UI keeps working)');
const newbie = uid(7);
await db.query('insert into auth.users (id) values ($1)', [newbie]);
await as(newbie, () => q('select * from public.ensure_profile()'));
ok((await as(newbie, () => q("select * from public.save_tester_profile('Newbie','hi','{tech_savvy}')"))).length === 1, 'save_tester_profile works with NO default grants (explicit EXECUTE)');
ok((await as(newbie, () => q('select * from public.get_my_tester_profile()'))).length === 1, 'get_my_tester_profile works');
const tgt = (await as(newbie, () => q("select public.create_targeted_campaign('Post-M6 targeted','https://example.net','d',$1,'{tech_savvy}') id", [TASK])))[0].id;
ok(JSON.stringify((await as(newbie, () => q('select target_categories t from public.campaigns where id=$1', [tgt])))[0].t) === '["tech_savvy"]', 'create_targeted_campaign works with NO default grants and stores the audience');
ok((await as(newbie, () => q('select * from public.list_matched_campaigns()'))).some((r) => r.campaign_id === oldCreate), 'list_matched_campaigns works for authenticated');
for (const call of ["select * from public.save_tester_profile('X1','b','{}')", 'select * from public.get_my_tester_profile()', 'select public.delete_my_tester_profile()', 'select * from public.list_matched_campaigns()', 'select * from public.tester_profiles']) {
  ok(await fails(() => as(null, () => q(call))) !== null, 'anon denied: ' + call.slice(0, 44));
}
ok(await fails(() => as(newbie, () => q('select * from public.tester_profiles'))) !== null, 'authenticated cannot read tester_profiles directly');
ok(await fails(() => as(newbie, () => q("select public.normalize_tester_categories('{tech_savvy}')"))) !== null, 'the internal validator is not executable by clients');

console.log('\n[migration 7 (matching v2: open vs targeted + screening) on the same populated database]');
const M7 = '20261115000200_matching_v2.sql';
const cSel = 'select id, owner_id, project_id, task_description, status, response_count, created_at, expires_at, target_categories from public.campaigns order by id';
const campaigns7 = await q(cSel);
const subs7 = await q('select id, friction, suggestion, ux_rating from public.test_submissions order by id');
const ledger7 = await q('select id, user_id, delta, reason, campaign_id from public.credit_ledger order by id');
const reservations7 = await q('select id, campaign_id, tester_id, expires_at, starts from public.test_reservations order by id');
const fnSql7 = "select p.oid::regprocedure::text sig, md5(p.prosrc) m from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1";
const fnBefore7 = await q(fnSql7);
let err7 = null;
try { await db.exec(mig(M7)); } catch (e) { err7 = e.message; }
ok(err7 === null, 'migration 7 applies cleanly on a populated database', err7 ?? '');
ok(JSON.stringify(campaigns7) === JSON.stringify(await q(cSel)), 'existing campaigns are unchanged (incl. their v1 preferred categories)');
const fnAfter7 = await q(fnSql7);
ok(fnBefore7.length > 20 && fnBefore7.every((a) => fnAfter7.find((b) => b.sig === a.sig)?.m === a.m), `NO existing function body changed (${fnBefore7.length} public functions compared by md5, incl. start_test, submit_test and every credit / referral / refund function)`);
ok(fnAfter7.length > fnBefore7.length, 'migration 7 only ADDED functions');
ok((await q("select count(*)::int n from public.campaigns where testing_mode = 'open'"))[0].n === campaigns7.length, 'EVERY existing campaign is OPEN testing (none is silently restricted)');
const v1pref = await q('select testing_mode, target_categories from public.campaigns where id = $1', [tgt]);
ok(v1pref[0].testing_mode === 'open' && JSON.stringify(v1pref[0].target_categories) === '["tech_savvy"]', 'the Matching-v1 campaign with preferred categories stays OPEN and keeps its preferred category');
ok(JSON.stringify(subs7) === JSON.stringify(await q('select id, friction, suggestion, ux_rating from public.test_submissions order by id')), 'feedback is byte-identical');
ok(JSON.stringify(ledger7) === JSON.stringify(await q('select id, user_id, delta, reason, campaign_id from public.credit_ledger order by id')), 'ledger rows are unchanged');
ok(JSON.stringify(reservations7) === JSON.stringify(await q('select id, campaign_id, tester_id, expires_at, starts from public.test_reservations order by id')), 'reservations are unchanged');
const flags7 = await q("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ('screening_versions','screening_questions','screening_attempts')");
ok(flags7.length === 3 && flags7.every((r) => r.relrowsecurity), 'the three screening tables exist with RLS enabled (auto-RLS + explicit)');
ok((await q('select count(*)::int n from public.screening_versions'))[0].n === 3 && (await q('select count(*)::int n from public.screening_questions'))[0].n === 12, 'screening content seeded: 3 categories x 4 questions');
ok((await q('select count(*)::int n from public.screening_attempts'))[0].n === 0, 'no attempts yet');
const nb = uid(20);
const nb2 = uid(21);
for (const u of [nb, nb2]) { await db.query('insert into auth.users (id) values ($1)', [u]); await as(u, () => q('select * from public.ensure_profile()')); }
ok(!!(await as(nb, () => q('select public.start_test($1) r', [tgt])))[0].r.reservation_expires_at, 'a tester with NO profile and NO screening can still start the pre-existing v1 campaign');
ok((await as(nb2, () => q('select * from public.list_open_campaigns()'))).length >= 1 && (await as(nb2, () => q('select * from public.list_matched_campaigns()'))).length >= 1, 'the v0 and v1 feed RPCs still work (the deployed UI keeps working)');
ok(!!(await as(nb2, () => q('select public.create_targeted_campaign($1,$2,$3,$4,$5) id', ['Post-M7 v1 style', 'https://example.net', 'd', TASK, ['students_learners']])))[0].id, 'the v1 create RPC still works and creates an OPEN campaign');
const nb3 = uid(22);
await db.query('insert into auth.users (id) values ($1)', [nb3]);
await as(nb3, () => q('select * from public.ensure_profile()'));
ok((await as(nb3, () => q("select * from public.save_tester_profile('Zed','b','{tech_savvy}')"))).length === 1, 'profile save still works');
const scr = (await as(nb3, () => q("select public.get_screening('tech_savvy') r")))[0].r;
ok(scr.questions.length === 4 && scr.attempts_left === 3, 'get_screening works with NO default grants (explicit EXECUTE)');
const pr = (await as(nb3, () => q("select public.submit_screening('tech_savvy', $1::jsonb) r", [JSON.stringify({ q1: ['code', 'terminal'], q2: ['git'], q3: ['none'], q4: ['none'] })])))[0].r;
ok(pr.passed === true, 'submit_screening works with NO default grants');
ok((await as(nb3, () => q('select public.get_my_screening_status() r')))[0].r.find((x) => x.category === 'tech_savvy').qualified === true, 'get_my_screening_status works');
const tgt2 = (await as(nb3, () => q("select public.create_campaign_v2('Post-M7 targeted','https://example.net','d',$1,'targeted','{business_office}') id", [TASK])))[0].id;
ok((await q('select testing_mode from public.campaigns where id = $1', [tgt2]))[0].testing_mode === 'targeted', 'create_campaign_v2 creates a TARGETED campaign');
ok((await as(nb, () => q('select public.get_campaign_eligibility($1) r', [tgt2])))[0].r.reason === 'no_profile', 'get_campaign_eligibility works');
ok((await as(nb2, () => q('select * from public.list_campaigns_v2()'))).some((r) => r.campaign_id === tgt2 && r.fit === 'not_eligible'), 'list_campaigns_v2 works and flags the targeted campaign as not eligible');
ok(await fails(() => as(nb2, () => q('select public.start_test($1)', [tgt2]))) !== null, 'the server refuses a non-eligible reservation on the new targeted campaign');
for (const call of ["select public.get_screening('tech_savvy')", 'select * from public.list_campaigns_v2()', 'select public.get_my_screening_status()', 'select * from public.screening_attempts', 'select * from public.screening_questions']) {
  ok(await fails(() => as(null, () => q(call))) !== null, 'anon denied: ' + call.slice(0, 48));
}
for (const call of ['select * from public.screening_attempts', 'select * from public.screening_questions', 'select * from public.screening_versions', "select public.is_screened('00000000-0000-0000-0000-000000000001','tech_savvy')", "select * from public.tester_eligibility('00000000-0000-0000-0000-000000000001','open','{}')"]) {
  ok(await fails(() => as(nb3, () => q(call))) !== null, 'authenticated denied: ' + call.slice(0, 52));
}

summary();
