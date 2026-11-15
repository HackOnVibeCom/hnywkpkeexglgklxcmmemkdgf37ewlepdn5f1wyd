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

console.log('\n[migration 8 (experience profile + qualification) on the same populated database]');
const M8 = '20261115000300_experience_profile.sql';
const ANSW = (t) => ({ q1: `I use ${t} tools almost every day`, q2: `A project where I built ${t} things`, q3: `Something broke so I read the ${t} logs`, q4: `Products about ${t} are fun to test` });
// BEFORE the migration, in the live (migration 7) state: pend = tech+business profile never screened; gen = students only;
// hold = passed the OLD multiple-choice screening AND holds a live reservation of a targeted task.
const pend = uid(30), gen = uid(31), hold = uid(32), ownerH = uid(33), own2 = uid(34), own3 = uid(35);
for (const u of [pend, gen, hold, ownerH, own2, own3]) { await db.query('insert into auth.users (id) values ($1)', [u]); await as(u, () => q('select * from public.ensure_profile()')); }
await as(pend, () => q("select * from public.save_tester_profile('Pending','b','{tech_savvy,business_office}')"));
await as(gen, () => q("select * from public.save_tester_profile('General','b','{students_learners}')"));
await as(hold, () => q("select * from public.save_tester_profile('Holder','b','{tech_savvy}')"));
await as(hold, () => q('select public.submit_screening($1, $2::jsonb)', ['tech_savvy', JSON.stringify({ q1: ['code', 'terminal'], q2: ['git'], q3: ['none'], q4: ['none'] })]));
const heldCamp = (await as(ownerH, () => q("select public.create_campaign_v2('Held targeted','https://example.net','d',$1,'targeted','{tech_savvy}') id", [TASK])))[0].id;
await as(hold, () => q('select public.start_test($1)', [heldCamp]));
const prefCamp = (await as(own3, () => q("select public.create_targeted_campaign('Open with preferences','https://example.net','d',$1,'{tech_savvy}') id", [TASK])))[0].id;
const pendTech = (await as(own2, () => q("select public.create_campaign_v2('Tech for pending','https://example.net','d',$1,'targeted','{tech_savvy}') id", [TASK])))[0].id;
const SQL8 = {
  campaigns: 'select id, owner_id, project_id, task_description, status, response_count, created_at, expires_at, target_categories, testing_mode from public.campaigns order by id',
  subs: 'select id, friction, suggestion, ux_rating from public.test_submissions order by id',
  ledger: 'select id, user_id, delta, reason, campaign_id from public.credit_ledger order by id',
  reservations: 'select id, campaign_id, tester_id, expires_at, starts from public.test_reservations order by id',
  profiles: 'select user_id, nickname, bio, categories from public.tester_profiles order by user_id',
  attempts: 'select id, user_id, category, version, passed, areas from public.screening_attempts order by id',
  balances: 'select id, credit_balance from public.profiles order by id',
};
const before8 = {};
for (const k of Object.keys(SQL8)) before8[k] = await q(SQL8[k]);
const fnSql8 = "select p.oid::regprocedure::text sig, md5(p.prosrc) m from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1";
const fnBefore8 = await q(fnSql8);
ok((await as(pend, () => q('select * from public.list_matched_campaigns()'))).some((r) => r.is_recommended), 'BEFORE migration 8 an unscreened professional category was still used for recommendations (the behaviour being replaced)');
ok(!!(await as(pend, () => q('select public.start_test($1) r', [prefCamp])))[0].r.reservation_expires_at, 'and any identity could reserve an open task without a completed profile (the behaviour being replaced)');
await q('delete from public.test_reservations where tester_id = $1', [pend]); // undo, keep the data comparable
before8.reservations = await q(SQL8.reservations);
let err8 = null;
try { await db.exec(mig(M8)); } catch (e) { err8 = e.message; }
ok(err8 === null, 'migration 8 applies cleanly on a populated database', err8 ?? '');
for (const k of Object.keys(SQL8)) ok(JSON.stringify(before8[k]) === JSON.stringify(await q(SQL8[k])), 'migration 8 leaves ' + k + ' byte-identical (no existing row is rewritten)');
const fnAfter8 = await q(fnSql8);
const changed8 = fnBefore8.filter((a) => fnAfter8.find((b) => b.sig === a.sig)?.m !== a.m).map((a) => a.sig).sort();
ok(JSON.stringify(changed8) === JSON.stringify(['enforce_campaign_eligibility()', 'get_screening(text)', 'list_matched_campaigns()', 'submit_screening(text,jsonb)', 'tester_eligibility(uuid,text,text[])'].sort()), 'EXACTLY five existing function bodies changed (eligibility rule, its trigger, the v1 feed, the two retired screening RPCs); start_test, submit_test, credits, referrals, refunds untouched', JSON.stringify(changed8));
const added8 = fnAfter8.filter((b) => !fnBefore8.find((a) => a.sig === b.sig)).map((b) => b.sig).sort();
const expectAdded = ['experience_current_version(text)', 'experience_complete(uuid,text)', 'is_qualified(uuid,text)', 'category_state(uuid,text)', 'active_tester_categories(uuid)', 'tester_participation_ready(uuid)', 'normalize_experience_answers(text,jsonb)', 'experience_hash(integer,jsonb)', 'experience_category_json(uuid,text)', 'get_experience_questions(text)', 'save_experience_answers(text,jsonb)', 'get_my_experience()', 'set_ai_consent(boolean)', 'delete_my_experience(text)', 'service_get_ai_profile(uuid)', 'service_list_pending_assessments(integer)', 'service_record_qualification(uuid,text,integer,text,text,jsonb)', 'service_list_eligible_campaigns(uuid)', 'service_list_erasure_events(bigint,integer)', 'log_erasure_on_profile_removed()', 'log_erasure_on_consent_row_deleted()'].sort();
ok(JSON.stringify(added8) === JSON.stringify(expectAdded), 'and exactly twenty-one functions were added (incl. 2 erasure-log trigger functions)', JSON.stringify(added8));
ok((await q('select count(*)::int n from public.experience_questions'))[0].n === 20, 'twenty questions seeded (4 x 5 categories)');
ok((await q('select count(*)::int n from public.experience_answers'))[0].n === 0 && (await q('select count(*)::int n from public.ai_consents'))[0].n === 0, 'no answers and no consent exist yet: nothing is invented for anybody');
const flags8 = await q("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ('experience_questions','experience_answers','ai_consents','category_qualifications','experience_save_limits','ai_erasure_events')");
ok(flags8.length === 6 && flags8.every((r) => r.relrowsecurity), 'the six new tables exist with RLS enabled (auto-RLS + explicit)');
ok((await q('select count(*)::int n from public.category_qualifications'))[0].n === 0, 'NO qualification exists after the migration: real earlier multiple-choice passes are NOT carried over, so they can never activate a professional category');
ok((await q('select count(*)::int n from public.screening_attempts where passed'))[0].n >= 1, 'the earlier passes still exist as history only (nothing reads them any more)');
const stateOf = async (u) => Object.fromEntries((await as(u, () => q('select public.get_my_experience() r')))[0].r.categories.map((c) => [c.category, c.state]));
ok(JSON.stringify(Object.values(await stateOf(pend))) === JSON.stringify(['incomplete', 'inactive', 'incomplete', 'inactive', 'inactive']) && (await as(pend, () => q('select public.get_my_experience() r')))[0].r.participation_ready === false, 'an EXISTING profile with professional categories reads as incomplete: nothing is active, nothing is deleted');
ok((await q('select categories from public.tester_profiles where user_id = $1', [pend]))[0].categories.join() === 'tech_savvy,business_office', 'the stored profile is untouched');
ok((await as(pend, () => q('select * from public.list_matched_campaigns()'))).every((r) => !r.is_recommended), 'incomplete categories no longer drive recommendations (v1 feed)');
ok((await as(pend, () => q('select public.get_campaign_eligibility($1) r', [prefCamp])))[0].r.reason === 'profile_incomplete', 'an existing user must complete a category before testing (profile_incomplete) - and is told why');
ok(await fails(() => as(pend, () => q('select public.start_test($1)', [prefCamp]))) !== null, 'the server refuses the reservation until then');
ok(await fails(() => as(pend, () => q("select public.submit_screening('tech_savvy','{}')"))) !== null, 'the old multiple-choice submit cannot create a pass any more');
// in-progress reservation (made before the migration, by a tester with NO answers) is protected
ok((await as(hold, () => q('select public.get_campaign_eligibility($1) r', [heldCamp])))[0].r.reason === 'in_progress', 'the in-progress reservation that existed before the migration is intact (even though the holder has no answers yet)');
ok(!!(await as(hold, () => q('select public.start_test($1) r', [heldCamp])))[0].r.reservation_expires_at, 'start_test still returns it');
await q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds' where tester_id=$1 and campaign_id=$2`, [hold, heldCamp]);
const subH = (await as(hold, () => q('select public.submit_test($1,true,$2,$3,4,false) r', [heldCamp, 'Friction text that is long enough.', 'Suggestion text that is long enough.'])))[0].r;
ok(subH.credits_awarded === 1, 'and it can be submitted and rewarded after the migration');
// completing the profile
await as(pend, () => q('select public.save_experience_answers($1,$2::jsonb)', ['tech_savvy', JSON.stringify(ANSW('tech'))]));
ok((await stateOf(pend)).tech_savvy === 'pending_assessment', 'answers for a professional category -> pending assessment (NOT active)');
ok(!!(await as(pend, () => q('select public.start_test($1) r', [prefCamp])))[0].r.reservation_expires_at, 'and the open task (with v1 preferred categories) can now be reserved: profile completion is enough');
await as(gen, () => q('select public.save_experience_answers($1,$2::jsonb)', ['students_learners', JSON.stringify(ANSW('study'))]));
ok((await stateOf(gen)).students_learners === 'active', 'a general category is active as soon as its four answers are valid');
await as(hold, () => q('select public.save_experience_answers($1,$2::jsonb)', ['tech_savvy', JSON.stringify(ANSW('legacy'))]));
ok((await stateOf(hold)).tech_savvy === 'pending_assessment', 'a tester who passed the OLD multiple-choice screening gets no shortcut: with four answers the category is PENDING assessment, not active');
ok((await as(hold, () => q('select public.get_my_experience() r')))[0].r.categories.find((c) => c.category === 'tech_savvy').qualification === null && (await q('select count(*)::int n from public.category_qualifications'))[0].n === 0, 'and no qualification record exists for anybody');
ok((await as(nb3, () => q('select public.get_my_experience() r')))[0].r.has_profile === true, 'get_my_experience works with NO default grants (explicit EXECUTE)');
ok(await fails(() => as(null, () => q('select public.get_my_experience()'))) !== null, 'anon denied: get_my_experience');
ok(await fails(() => as(nb3, () => q('select public.service_get_ai_profile($1)', [nb3]))) !== null, 'authenticated denied: the service-only AI interface');
await db.exec('set role service_role');
const aip = (await q('select public.service_get_ai_profile($1) r', [hold]))[0].r;
await db.exec('reset role');
ok(aip.contract_version === 1 && aip.categories.length === 5, 'service_role can read the AI contract (explicit grant, no default privileges)');
const cr8 = (await q('select coalesce((select sum(delta) from public.credit_ledger),0)::int l, coalesce((select sum(credit_balance) from public.profiles),0)::int b'))[0];
ok(cr8.l === cr8.b, 'credit conservation holds after the migration and the flows above (' + cr8.l + ' = ' + cr8.b + ')');

summary();
