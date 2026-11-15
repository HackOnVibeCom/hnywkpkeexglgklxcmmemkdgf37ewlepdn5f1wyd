// Targeted Tester Matching v1 (migration 20261115000100): optional private tester profiles, campaign target
// categories, the matched Discover feed. Real Postgres (PGlite) + the real migration files. Same limits as the
// other suites: PGlite is single-connection, so true parallelism is covered by the real-project script only.

import { createHarness, uid } from './harness.mjs';

const { db, as, q, ok, failsWith, counts } = await createHarness({ quiet: true, upTo: '20261115000200_matching_v2.sql' });

const TASK = 'Find the pricing page and tell me which plan you would pick.';
const FB = { friction: 'The pricing link was hidden in the footer.', suggestion: 'Add a pricing link to the top nav.' };
const ALL = ['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical'];
let nextId = 1;
async function mk() {
  const id = uid(nextId++);
  await db.query('insert into auth.users (id) values ($1)', [id]);
  await as(id, () => q('select * from public.ensure_profile()'));
  return id;
}
const bal = async (u) => (await as(u, () => q('select credit_balance from public.profiles')))[0].credit_balance;
const save = (u, nick, bio, cats) => as(u, () => q('select * from public.save_tester_profile($1,$2,$3)', [nick, bio, cats]));
const myProfile = async (u) => (await as(u, () => q('select * from public.get_my_tester_profile()')))[0] ?? null;
/** Legacy 4-argument creation = exactly what the currently deployed UI calls. */
const createLegacy = async (u, name = 'Legacy') => (await as(u, () => q('select public.create_project_with_campaign($1,$2,$3,$4) id', [name, 'https://example.com', 'd', TASK])))[0].id;
const createTargeted = async (u, cats, name = 'Targeted') => (await as(u, () => q('select public.create_targeted_campaign($1,$2,$3,$4,$5) id', [name, 'https://example.com', 'd', TASK, cats])))[0].id;
const feed = (u) => as(u, () => q('select * from public.list_matched_campaigns()'));
const oldFeed = (u) => as(u, () => q('select * from public.list_open_campaigns()'));
const ids = (rows) => rows.map((r) => r.campaign_id);
const age = (camp, minutes) => q(`update public.campaigns set created_at = now() - make_interval(mins => $2), expires_at = now() - make_interval(mins => $2) + interval '7 days' where id = $1`, [camp, minutes]);

console.log('\n[privileges: the new objects are not a back door]');
const U = await mk();
const V = await mk();
for (const call of ['select * from public.get_my_tester_profile()', "select * from public.save_tester_profile('Nick', 'bio', '{}')", 'select public.delete_my_tester_profile()', "select public.create_targeted_campaign('Nam','https://example.com','d','" + TASK + "','{}')", 'select * from public.list_matched_campaigns()', 'select * from public.tester_profiles']) {
  ok(await failsWith(() => as(null, () => q(call)), 'permission denied'), `anon denied: ${call.slice(0, 48)}`);
}
ok(await failsWith(() => as(U, () => q("select public.normalize_tester_categories('{tech_savvy}')")), 'permission denied'), 'the internal validator is not callable by clients');
for (const [name, sql] of [
  ['select the table', 'select * from public.tester_profiles'],
  ['insert a row', `insert into public.tester_profiles (user_id, nickname) values ('${U}', 'Sneaky')`],
  ['update a row', `update public.tester_profiles set nickname = 'x'`],
  ['delete a row', 'delete from public.tester_profiles'],
]) ok(await failsWith(() => as(U, () => q(sql)), 'permission denied'), `authenticated cannot ${name} directly`);
const cOwn = await createLegacy(U);
ok(await failsWith(() => as(U, () => q(`update public.campaigns set target_categories = '{tech_savvy}' where id = '${cOwn}'`)), 'permission denied'), 'an owner cannot set target_categories with a plain UPDATE (RPC only)');
ok((await db.query('select relrowsecurity from pg_class where oid = $1::regclass', ['public.tester_profiles'])).rows[0].relrowsecurity, 'RLS is enabled on tester_profiles');
ok((await db.query(`select count(*)::int n from pg_policies where tablename = 'tester_profiles'`)).rows[0].n === 0, 'tester_profiles has no policy at all (default deny)');

console.log('\n[profiles are optional and start empty]');
ok((await myProfile(U)) === null, 'a new identity has no tester profile');
ok((await as(U, () => q('select count(*)::int n from public.list_matched_campaigns()')))[0].n === 0, 'and can still use Discover (empty feed here)');
await db.exec('set role authenticated');
await db.query("select set_config('request.jwt.claim.sub', '', false)");
ok(await failsWith(() => q("select public.save_tester_profile('Nick','bio','{}')"), 'not_authenticated'), 'saving needs a signed-in identity (no auth.uid -> not_authenticated)');
ok(await failsWith(() => q("select public.create_targeted_campaign('Nam','https://example.com','d','" + TASK + "','{}')"), 'not_authenticated'), 'and so does creating a targeted campaign');
await db.exec('reset role');

console.log('\n[save / read / correct a profile]');
const s1 = await save(U, '  Ada   Lovelace ', 'I build\n\nAPIs   for a living.', ['students_learners', 'tech_savvy', 'tech_savvy']);
ok(s1.length === 1 && s1[0].nickname === 'Ada Lovelace', 'nickname is trimmed and inner whitespace collapsed', JSON.stringify(s1));
ok(s1[0].bio === 'I build APIs for a living.', 'bio whitespace/newlines collapse to single spaces', s1[0].bio);
ok(JSON.stringify(s1[0].categories) === JSON.stringify(['tech_savvy', 'students_learners']), 'categories are de-duplicated and stored in canonical order', JSON.stringify(s1[0].categories));
const g1 = await myProfile(U);
ok(g1.nickname === 'Ada Lovelace' && g1.categories.length === 2, 'get_my_tester_profile returns what was saved');
ok((await q('select count(*)::int n from public.tester_profiles'))[0].n === 1, 'one row per identity');
const s2 = await save(U, 'Ada L.', '', ['founders_builders']);
ok(s2[0].nickname === 'Ada L.' && s2[0].bio === null && JSON.stringify(s2[0].categories) === '["founders_builders"]', 'a second save CORRECTS the profile in place (empty bio becomes NULL)');
ok((await q('select count(*)::int n from public.tester_profiles'))[0].n === 1 && (await q('select (updated_at >= created_at) ok from public.tester_profiles'))[0].ok, 'still one row, updated_at moved forward');
const s3 = await save(U, 'Ada L.', null, []);
ok(s3[0].categories.length === 0 && s3[0].bio === null, 'zero categories and a null bio are allowed (profile is optional, categories are too)');
ok(JSON.stringify((await save(U, 'Ada L.', 'x', ALL))[0].categories) === JSON.stringify(ALL), 'all five categories can be selected');
ok(JSON.stringify((await save(U, 'Ada L.', 'x', null))[0].categories) === '[]', 'NULL categories mean none');
ok((await myProfile(V)) === null, "another identity does NOT see Ada's profile (RPCs only ever read the caller's row)");
const sv = await save(V, 'Grace', 'Compiler person', ['tech_savvy']);
ok(sv[0].nickname === 'Grace' && (await myProfile(U)).nickname === 'Ada L.', 'two identities have independent profiles');
ok((await q('select count(*)::int n from public.tester_profiles'))[0].n === 2, 'exactly two rows exist');

console.log('\n[validation: nothing invalid is stored]');
const rowsBefore = (await q('select count(*)::int n from public.tester_profiles'))[0].n;
for (const [label, args, code] of [
  ['1-char nickname', ['A', 'bio', []], 'invalid_nickname'],
  ['empty nickname', ['', 'bio', []], 'invalid_nickname'],
  ['whitespace-only nickname', ['   \t ', 'bio', []], 'invalid_nickname'],
  ['null nickname', [null, 'bio', []], 'invalid_nickname'],
  ['31-char nickname', ['x'.repeat(31), 'bio', []], 'invalid_nickname'],
  ['control character in nickname', ['Ada\u0007Bee', 'bio', []], 'invalid_nickname'],
  ['281-char bio', ['Nick', 'y'.repeat(281), []], 'invalid_bio'],
  ['control character in bio', ['Nick', 'hi\u0007there', []], 'invalid_bio'],
  ['unknown category', ['Nick', 'bio', ['tech_savvy', 'wizards']], 'invalid_categories'],
  ['wrong case category', ['Nick', 'bio', ['Tech_Savvy']], 'invalid_categories'],
  ['SQL in category', ['Nick', 'bio', ["tech_savvy'; drop table x; --"]], 'invalid_categories'],
  ['NULL element in categories', ['Nick', 'bio', ['tech_savvy', null]], 'invalid_categories'],
]) {
  ok(await failsWith(() => save(U, ...args), code), `rejected: ${label} -> ${code}`);
}
ok((await save(U, 'x'.repeat(30), 'y'.repeat(280), ['tech_savvy']))[0].nickname.length === 30, 'boundary: 30-char nickname and 280-char bio are accepted');
ok((await save(U, 'Ab', 'ok', []))[0].nickname === 'Ab', 'boundary: 2-char nickname accepted');
await save(U, 'Ada L.', null, []);
await save(V, 'Grace', 'Compiler person', ['tech_savvy']);
ok((await q('select count(*)::int n from public.tester_profiles'))[0].n === rowsBefore, 'rejected saves created no extra rows');
const NOPROF = uid(900);
await db.query('insert into auth.users (id) values ($1)', [NOPROF]);
ok(await failsWith(() => save(NOPROF, 'Nick', 'bio', []), 'profile_missing'), 'an identity without a credit profile row cannot save one (profile_missing)');

console.log('\n[delete my profile]');
const W = await mk();
await save(W, 'Temp', 'to be deleted', ['business_office']);
ok((await as(W, () => q('select public.delete_my_tester_profile() r')))[0].r === true, 'delete returns true when something was removed');
ok((await myProfile(W)) === null, 'the profile is gone');
ok((await as(W, () => q('select public.delete_my_tester_profile() r')))[0].r === false, 'deleting again is a harmless no-op (false)');
ok((await myProfile(V)) !== null, "deleting mine never touches anyone else's");
ok((await bal(W)) === 1, 'profile operations never change credits');

console.log('\n[target audience on campaigns]');
const O1 = await mk();
const legacy = await createLegacy(O1, 'Old style');
ok((await q('select target_categories t from public.campaigns where id=$1', [legacy]))[0].t.length === 0, 'a campaign created the OLD way has an empty target (= anyone)');
ok((await bal(O1)) === 0, 'legacy path still spends exactly one credit');
const O2 = await mk();
const tg = await createTargeted(O2, ['students_learners', 'tech_savvy', 'tech_savvy']);
const trow = (await q('select target_categories t from public.campaigns where id=$1', [tg]))[0].t;
ok(JSON.stringify(trow) === JSON.stringify(['tech_savvy', 'students_learners']), 'targets persist, de-duplicated, in canonical order', JSON.stringify(trow));
ok((await bal(O2)) === 0, 'a targeted request spends exactly one credit');
ok((await q(`select count(*)::int n from public.credit_ledger where campaign_id=$1 and reason='campaign_spend'`, [tg]))[0].n === 1, 'with exactly one ledger spend row');
const O3 = await mk();
const tgEmpty = await createTargeted(O3, []);
ok((await q('select target_categories t from public.campaigns where id=$1', [tgEmpty]))[0].t.length === 0, 'an empty selection equals "anyone"');
const O4 = await mk();
const tgNull = await createTargeted(O4, null);
ok((await q('select target_categories t from public.campaigns where id=$1', [tgNull]))[0].t.length === 0, 'NULL selection equals "anyone"');
const O5 = await mk();
const bc = (await q('select count(*)::int n from public.campaigns'))[0].n;
const bp = (await q('select count(*)::int n from public.projects'))[0].n;
ok(await failsWith(() => createTargeted(O5, ['tech_savvy', 'astronauts']), 'invalid_categories'), 'an invalid category is rejected');
ok((await bal(O5)) === 1 && (await q('select count(*)::int n from public.campaigns'))[0].n === bc && (await q('select count(*)::int n from public.projects'))[0].n === bp, 'a rejected request spends NOTHING and creates no project/campaign (atomic)');
ok(await failsWith(() => createTargeted(O5, ['tech_savvy'], 'x'), 'invalid_name'), 'the underlying validation still applies (invalid_name)');
ok((await bal(O5)) === 1, 'and still spends nothing');
const BROKE = await mk();
await createLegacy(BROKE, 'spend the starter');
ok(await failsWith(() => createTargeted(BROKE, ['tech_savvy']), 'insufficient_credits'), 'insufficient credits is still enforced for targeted requests');
ok((await q(`select count(*)::int n from public.campaigns where owner_id=$1`, [BROKE]))[0].n === 1, 'and nothing was created');
ok(await failsWith(() => q(`update public.campaigns set target_categories = '{bogus}' where id = $1`, [tg]), 'invalid_categories'), 'the table constraint independently rejects unknown ids');
ok(await failsWith(() => q(`update public.campaigns set target_categories = '{students_learners,tech_savvy}' where id = $1`, [tg]), 'campaigns_target_categories_canonical'), 'and non-canonical order/duplicates');
ok((await as(O2, () => q('select target_categories t from public.campaigns where id=$1', [tg])))[0].t.length === 2, 'the owner can read their own targets');
ok((await as(U, () => q('select count(*)::int n from public.campaigns where id=$1', [tg])))[0].n === 0, "other identities cannot read someone else's campaign row directly");

console.log('\n[matching: deterministic, explainable ordering]');
// fresh, isolated world so the order is exactly predictable
const h2 = await createHarness({ quiet: true, upTo: '20261115000200_matching_v2.sql' });
const { db: d2, as: as2, q: q2, ok: ok2 } = h2;
let n2 = 1;
const mk2 = async () => { const id = uid(n2++); await d2.query('insert into auth.users (id) values ($1)', [id]); await as2(id, () => q2('select * from public.ensure_profile()')); return id; };
const camp2 = async (owner, cats, minutesOld, name) => {
  const id = cats === undefined
    ? (await as2(owner, () => q2('select public.create_project_with_campaign($1,$2,$3,$4) id', [name, 'https://example.com', 'd', TASK])))[0].id
    : (await as2(owner, () => q2('select public.create_targeted_campaign($1,$2,$3,$4,$5) id', [name, 'https://example.com', 'd', TASK, cats])))[0].id;
  await q2(`update public.campaigns set created_at = now() - make_interval(mins => $2), expires_at = now() - make_interval(mins => $2) + interval '7 days' where id = $1`, [id, minutesOld]);
  return id;
};
const feed2 = (u) => as2(u, () => q2('select * from public.list_matched_campaigns()'));
const old2 = (u) => as2(u, () => q2('select * from public.list_open_campaigns()'));
const nm = (rows) => rows.map((r) => r.project_name);
const T = await mk2();
const A = await camp2(await mk2(), undefined, 50, 'A legacy (oldest)');
const B = await camp2(await mk2(), ['tech_savvy'], 40, 'B tech');
const C = await camp2(await mk2(), ['students_learners'], 30, 'C students');
const D = await camp2(await mk2(), ['tech_savvy', 'founders_builders'], 20, 'D tech+founders');
const E = await camp2(await mk2(), undefined, 10, 'E legacy (newest)');

console.log('  -- no profile --');
let f = await feed2(T);
ok2(JSON.stringify(nm(f)) === JSON.stringify(['A legacy (oldest)', 'B tech', 'C students', 'D tech+founders', 'E legacy (newest)']), 'no profile: oldest-first, exactly the existing Discover order', JSON.stringify(nm(f)));
ok2(f.every((r) => r.is_recommended === false && r.match_categories.length === 0), 'no profile: nothing is recommended');
ok2(JSON.stringify(ids(f)) === JSON.stringify(ids(await old2(T))), 'no profile: identical to list_open_campaigns (same rows, same order)');
ok2(f.find((r) => r.campaign_id === D).target_categories.join() === 'tech_savvy,founders_builders', 'targets are visible to testers (so the UI can say who the task is for)');

console.log('  -- profile with no categories --');
await as2(T, () => q2("select * from public.save_tester_profile('Tess', 'hello', '{}')"));
f = await feed2(T);
ok2(JSON.stringify(ids(f)) === JSON.stringify(ids(await old2(T))) && f.every((r) => !r.is_recommended), 'a profile without categories behaves like no profile');

console.log('  -- one category --');
await as2(T, () => q2("select * from public.save_tester_profile('Tess', 'hello', '{tech_savvy}')"));
f = await feed2(T);
ok2(JSON.stringify(nm(f)) === JSON.stringify(['B tech', 'D tech+founders', 'A legacy (oldest)', 'C students', 'E legacy (newest)']), 'tech_savvy: matches first (older first among equals), the rest keep their old order', JSON.stringify(nm(f)));
ok2(f.filter((r) => r.is_recommended).map((r) => r.project_name).join() === 'B tech,D tech+founders', 'exactly the overlapping campaigns are recommended');
ok2(f.find((r) => r.campaign_id === D).match_categories.join() === 'tech_savvy', "explainable: match_categories = target ∩ MY categories only (D's founders target is not credited to me)");
ok2(f.find((r) => r.campaign_id === A).match_categories.length === 0 && !f.find((r) => r.campaign_id === A).is_recommended, 'a campaign with no target is never "recommended" (it stays available)');
ok2(f.length === 5, 'non-matching campaigns remain available (supply is limited)');

console.log('  -- two categories: more overlap ranks first --');
await as2(T, () => q2("select * from public.save_tester_profile('Tess', 'hello', '{founders_builders,tech_savvy}')"));
f = await feed2(T);
ok2(JSON.stringify(nm(f)) === JSON.stringify(['D tech+founders', 'B tech', 'A legacy (oldest)', 'C students', 'E legacy (newest)']), 'two matching categories outrank one', JSON.stringify(nm(f)));
ok2(f[0].match_categories.join() === 'tech_savvy,founders_builders', 'both overlaps are listed, in canonical order');

console.log('  -- a tester with no overlap --');
const T2 = await mk2();
await as2(T2, () => q2("select * from public.save_tester_profile('Zed', null, '{everyday_nontechnical}')"));
f = await feed2(T2);
ok2(JSON.stringify(ids(f)) === JSON.stringify(ids(await old2(T2))) && f.every((r) => !r.is_recommended), 'no overlap anywhere: the old order, nothing recommended');

console.log('  -- determinism --');
const again = await feed2(T);
ok2(JSON.stringify(again.map((r) => [r.campaign_id, r.match_categories, r.is_recommended])) === JSON.stringify(f.length ? (await feed2(T)).map((r) => [r.campaign_id, r.match_categories, r.is_recommended]) : []), 'the same data always gives the same answer');
// identical timestamps: the id tiebreak makes the order total
const X1 = await camp2(await mk2(), ['students_learners'], 5, 'X1 same time');
const X2 = await camp2(await mk2(), ['students_learners'], 5, 'X2 same time');
await q2(`update public.campaigns set created_at = (select created_at from public.campaigns where id = $1) where id = $2`, [X1, X2]);
const T3 = await mk2();
await as2(T3, () => q2("select * from public.save_tester_profile('Sam', null, '{students_learners}')"));
const tie = ids(await feed2(T3)).filter((i) => i === X1 || i === X2);
ok2(JSON.stringify(tie) === JSON.stringify([X1, X2].sort()), 'equal timestamps break ties by campaign id (total order)');

console.log('  -- visibility rules are the same as before --');
const T4 = await mk2();
await as2(T4, () => q2("select * from public.save_tester_profile('Quinn', null, '{tech_savvy}')"));
const mineT4 = await camp2(T4, ['tech_savvy'], 3, 'mine (tech)'); // T4 has 1 credit, spends it
ok2(!ids(await feed2(T4)).includes(mineT4), 'you never see your own campaign, even when it matches your own categories');
ok2(await (async () => { try { await as2(T4, () => q2('select public.start_test($1)', [mineT4])); return false; } catch (e) { return /own_campaign/.test(e.message); } })(), 'and you cannot start testing it (own_campaign)');
await as2(T, () => q2('select public.start_test($1)', [B]));
ok2(ids(await feed2(T))[0] === B && (await feed2(T))[0].reserved_by_me === true, 'my own live reservation is always first');
ok2(!ids(await feed2(T4)).includes(B), "a task reserved by someone else disappears from other testers' feeds");
await q2(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds', started_at = started_at - interval '61 seconds' where tester_id = $1`, [T]);
const bT = (await as2(T, () => q2('select credit_balance b from public.profiles')))[0].b;
const sub = (await as2(T, () => q2('select public.submit_test($1,true,$2,$3,4,false) r', [B, FB.friction, FB.suggestion])))[0].r;
ok2(sub.credits_awarded === 1 && sub.balance === bT + 1, 'finishing a MATCHED test awards exactly 1 credit as before');
ok2(!ids(await feed2(T)).includes(B), 'a task I already tested disappears from my feed');
// a NON-matching tester completes a targeted campaign and is rewarded normally: matching is a preference, not a gate
const NM = await mk2();
await as2(NM, () => q2("select * from public.save_tester_profile('Nina', null, '{everyday_nontechnical}')"));
await as2(NM, () => q2('select public.start_test($1)', [D]));
await q2(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds', started_at = started_at - interval '61 seconds' where tester_id = $1`, [NM]);
const sub2 = (await as2(NM, () => q2('select public.submit_test($1,true,$2,$3,5,false) r', [D, FB.friction, FB.suggestion])))[0].r;
ok2(sub2.credits_awarded === 1, 'a tester OUTSIDE the target audience can still test a targeted campaign and earns the normal credit');
ok2((await q2(`select status, response_count from public.campaigns where id=$1`, [D]))[0].status === 'completed', 'the campaign completes normally');
// expiry
const stale = await camp2(await mk2(), ['tech_savvy'], 8 * 24 * 60, 'stale tech');
ok2(!ids(await feed2(T)).includes(stale), 'an expired campaign is not shown, matched or not');
// cancelled
const gone = await camp2(await mk2(), ['tech_savvy'], 2, 'to cancel');
const goneOwner = (await q2('select owner_id from public.campaigns where id=$1', [gone]))[0].owner_id;
await as2(goneOwner, () => q2('select public.cancel_campaign($1)', [gone]));
ok2(!ids(await feed2(T)).includes(gone), 'a cancelled campaign is not shown');

console.log('  -- parity with the existing Discover feed (guards against the two queries drifting apart) --');
const everyone = [T, T2, T3, T4, NM];
let parity = true;
for (const u of everyone) {
  const a = ids(await feed2(u)).sort();
  const b = ids(await old2(u)).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) { parity = false; console.log('   drift for', u, a.length, b.length); }
}
ok2(parity, 'for every tester the matched feed contains exactly the rows list_open_campaigns returns');

console.log('  -- limit 50 is applied AFTER ordering --');
const T5 = await mk2();
await as2(T5, () => q2("select * from public.save_tester_profile('Lee', null, '{business_office}')"));
for (let i = 0; i < 52; i++) await camp2(await mk2(), undefined, 600 + i, 'filler ' + i);
const needle = await camp2(await mk2(), ['business_office'], 1, 'needle (newest, matching)');
const top = await feed2(T5);
ok2(top.length === 50, 'the feed is capped at 50 rows');
ok2(top[0].campaign_id === needle && top[0].is_recommended, 'a recommended task that is NEWER than 50 other campaigns is still first');
ok2(!ids(await old2(T5)).includes(needle), 'whereas the old feed (limit applied to oldest-first) would have cut it off');

console.log('\n[existing flows keep working]');
ok((await oldFeed(U)).length >= 0, 'list_open_campaigns still works untouched');
const L1 = await mk();
const L2 = await mk();
const lc = await createLegacy(L1, 'Legacy flow');
await as(L2, () => q('select public.start_test($1)', [lc]));
await q(`update public.test_reservations set first_started_at = first_started_at - interval '61 seconds', started_at = started_at - interval '61 seconds' where tester_id = $1`, [L2]);
const lsub = (await as(L2, () => q('select public.submit_test($1,true,$2,$3,4,true) r', [lc, FB.friction, FB.suggestion])))[0].r;
ok(lsub.credits_awarded === 1, 'legacy campaign: reserve + submit + reward unchanged');
ok((await q(`select count(*)::int n from public.credit_ledger where reason='test_reward' and campaign_id=$1`, [lc]))[0].n === 1, 'exactly one reward row');
ok((await as(L1, () => q('select target_categories t from public.campaigns where id=$1', [lc])))[0].t.length === 0, 'the legacy campaign still has an empty target after completing');
const sumBefore = (await q('select coalesce(sum(credit_balance),0)::int s from public.profiles'))[0].s;
const ledgerSum = (await q('select coalesce(sum(delta),0)::int s from public.credit_ledger'))[0].s;
ok(sumBefore === ledgerSum, 'credit conservation: total balances equal the ledger sum after all of the above');

const a = counts(), b = h2.counts();
console.log(`\n${a.passed + b.passed} passed, ${a.failed + b.failed} failed`);
process.exit(a.failed + b.failed ? 1 : 0);
