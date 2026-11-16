// Tests docs/cancel-demo-campaigns.sql (NOT run in production yet) on real Postgres (PGlite) with ALL migrations: it must call the real
// cancel_campaign() as each owner (superuser session + jwt claim, exactly how `supabase db query` runs it), refund exactly 1 credit each,
// cancel only those campaigns, leave a bystander campaign and everyone else untouched, and be idempotent.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, uid } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SQL0 = readFileSync(join(here, '..', '..', 'docs', 'cancel-demo-campaigns.sql'), 'utf8');
const MAP = [
  ['5abbb472-49d9-4920-a8d7-eada17396228', 'd2a47cc9-83e2-433d-ac52-09644fa3b30c'],
  ['7eb06d6f-0b37-458a-a395-d04f74e51c5c', '54c9593c-93ee-4e6a-934d-87ea246fa9bf'],
  ['939c0dff-c08f-4f1e-9c07-a36dcdb025c7', '66fcf7f4-7238-4701-a6e7-68073da0d42c'],
];
const { db, as, q, ok, summary } = await createHarness({ quiet: true, autoReady: true });
const TASK = 'Demo task. Read the docs, send one request and tell us whether the error messages are clear and useful.';
const mk = async (n) => { const id = uid(n); await db.query('insert into auth.users (id) values ($1)', [id]); await as(id, () => q('select * from public.ensure_profile()')); return id; };
const create = async (o, mode, cats) => (await as(o, () => q('select public.create_campaign_v2($1,$2,$3,$4,$5,$6) id', ['Demo', 'https://example.com', 'd', TASK, mode, cats])))[0].id;

let sql = SQL0;
const owners = []; const camps = [];
for (const [i, [o, c]] of MAP.entries()) {
  const ow = await mk(i + 1); const ca = await create(ow, i === 2 ? 'targeted' : 'open', i === 2 ? ['business_office'] : []);
  owners.push(ow); camps.push(ca); sql = sql.split(o).join(ow).split(c).join(ca);
}
const bystanderOwner = await mk(10); const bystander = await create(bystanderOwner, 'open', []);
const bal = async (u) => (await q('select credit_balance b from public.profiles where id=$1', [u]))[0].b;
ok((await Promise.all(owners.map(bal))).every((b) => b === 0), 'fixture: every owner spent the starter credit on a campaign');
const snapOther = JSON.stringify(await q(`select id, status from public.campaigns where id = $1`, [bystander])) + (await bal(bystanderOwner));

await db.exec(sql);
const st = await q('select id, status from public.campaigns where id = any($1::uuid[])', [camps]);
ok(st.length === 3 && st.every((r) => r.status === 'cancelled'), 'the three demo campaigns are cancelled');
ok((await Promise.all(owners.map(bal))).every((b) => b === 1), 'each owner got exactly 1 credit back');
const refunds = await q(`select user_id, count(*)::int n from public.credit_ledger where reason = 'campaign_refund' group by user_id`);
ok(refunds.length === 3 && refunds.every((r) => r.n === 1), 'exactly one campaign_refund ledger row per owner');
ok(JSON.stringify(await q(`select id, status from public.campaigns where id = $1`, [bystander])) + (await bal(bystanderOwner)) === snapOther, 'a bystander campaign and its owner are untouched');
const bad = await q(`select count(*)::int n from public.profiles p where credit_balance <> (select coalesce(sum(delta),0) from public.credit_ledger l where l.user_id = p.id)`);
ok(bad[0].n === 0, 'every balance still equals its ledger sum');
await db.exec(sql);
ok((await Promise.all(owners.map(bal))).every((b) => b === 1) && (await q(`select count(*)::int n from public.credit_ledger where reason='campaign_refund'`))[0].n === 3, 'idempotent: a second run refunds nothing more');
summary();
