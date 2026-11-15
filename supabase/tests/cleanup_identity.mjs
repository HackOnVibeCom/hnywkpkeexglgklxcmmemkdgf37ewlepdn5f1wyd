// Tests docs/cleanup-abandoned-test-identity.sql (NOT run in production yet) on a real Postgres (PGlite) with ALL migrations:
// it must withdraw consent exactly like set_ai_consent(false), (optionally) delete the answers like delete_my_experience(NULL),
// make the erasure sweep remove AI-derived rows, and never touch credits, ledger, profile or any other identity.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, uid } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_ORIG = readFileSync(join(here, '..', '..', 'docs', 'cleanup-abandoned-test-identity.sql'), 'utf8');
const TARGET_IN_SQL = 'f6b685d5-111c-43d5-9106-1e227f3f9c9d';
const { db, as, q, ok, summary } = await createHarness({ quiet: true });

const ANS = { q1: 'TypeScript, Node.js, PostgreSQL and Docker every week', q2: 'I built a small API and deployed it myself', q3: 'I found a missing index with EXPLAIN and fixed it', q4: 'Web apps and developer tools because I read network logs' };
async function mk(n) {
  const id = uid(n);
  await db.query('insert into auth.users (id) values ($1)', [id]);
  await as(id, () => q('select * from public.ensure_profile()'));
  await as(id, () => q('select * from public.save_tester_profile($1,$2,$3)', ['Tester', 'I like building and testing developer tools', ['tech_savvy']]));
  await as(id, () => q('select * from public.save_experience_answers($1,$2)', ['tech_savvy', JSON.stringify(ANS)]));
  await as(id, () => q('select public.set_ai_consent(true)'));
  return id;
}
const snap = async (u) => ({
  consent: (await q('select ai_processing from public.ai_consents where user_id=$1', [u]))[0]?.ai_processing,
  answers: Number((await q('select count(*) n from public.experience_answers where user_id=$1', [u]))[0].n),
  ledger: JSON.stringify(await q('select reason, delta from public.credit_ledger where user_id=$1 order by id', [u])),
  profile: JSON.stringify(await q('select id, credit_balance from public.profiles where id=$1', [u])),
  tp: Number((await q('select count(*) n from public.tester_profiles where user_id=$1', [u]))[0].n),
});

const target = await mk(1);
const other = await mk(2); // control: must not change at all
const before = await snap(target);
const otherBefore = await snap(other);
ok(before.consent === true && before.answers === 1 && before.tp === 1, 'fixture: target has consent ON, one answer set and a tester profile');

// seed AI-derived rows for the target and the control (as the Edge Function would have), then run the cleanup + the erasure sweep
const refOf = async (u) => (await q('select subject_ref from public.ai_consents where user_id=$1', [u]))[0].subject_ref;
const seed = async (u) => {
  const ref = await refOf(u);
  await db.query(`insert into public.ai_assessment_notes (user_id, subject_ref, category, answers_hash, outcome, payload, model) values ($1,$2,'tech_savvy',$3,'needs_clarification','{}'::jsonb,'m')`, [u, ref, 'a'.repeat(64)]);
};
await seed(target); await seed(other);
const derived = async (u) => Number((await q('select count(*) n from public.ai_assessment_notes where user_id=$1', [u]))[0].n);
ok((await derived(target)) === 1 && (await derived(other)) === 1, 'fixture: AI-derived rows exist for both');

const sql = SQL_ORIG.split(TARGET_IN_SQL).join(target);
ok(!sql.includes(TARGET_IN_SQL), 'the script is parameterised only by the one identity id');
await db.exec(sql);

const after = await snap(target);
ok(after.consent === false, 'consent withdrawn');
ok(after.answers === 0, 'answers deleted (optional step 2)');
ok(after.ledger === before.ledger && after.profile === before.profile && after.tp === before.tp, 'ledger, credit balance, profile and tester profile are untouched');
ok(JSON.stringify(await snap(other)) === JSON.stringify(otherBefore) && (await derived(other)) === 1, 'the control identity is completely untouched (including its AI-derived row)');
const ev = await q('select reason, category from public.ai_erasure_events order by id');
ok(ev.some((e) => e.reason === 'consent_withdrawn') && ev.some((e) => e.reason === 'answers_deleted'), 'both erasure events were logged', JSON.stringify(ev));

await db.exec('set role service_role');
const n = (await q('select public.ai_apply_erasure_events() as n'))[0].n;
await db.exec('reset role');
ok(n >= 2, `the erasure sweep processed the events (${n})`);
ok((await derived(target)) === 0, 'the AI-derived row of the target is erased by the sweep');
ok((await derived(other)) === 1, 'the control identity (consent still ON) keeps its AI-derived row after the sweep');

// idempotent: running it again changes nothing and adds no events
const evBefore = (await q('select count(*) n from public.ai_erasure_events'))[0].n;
await db.exec(sql);
ok((await q('select count(*) n from public.ai_erasure_events'))[0].n === evBefore, 'idempotent: a second run adds no erasure events');
const again = await snap(target);
ok(again.consent === false && again.answers === 0 && again.ledger === before.ledger && again.profile === before.profile, 'idempotent: state is stable');
summary();
