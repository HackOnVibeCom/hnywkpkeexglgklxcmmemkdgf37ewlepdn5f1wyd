// FIRST LIVE AI RECOMMENDATION in Production: 3 throw-away identities (tester T + owners O1, O2), 2 clearly labelled test campaigns,
// ONE paid recommend request. Staged: the operator controls every paid / irreversible step through gate files in SYNC_DIR.
//   chrome.exe --remote-debugging-port=9223 --user-data-dir=<private folder> --no-first-run about:blank     (a human starts it)
//   SYNC_DIR=<folder> node tests/browser/prod-ai-recommend-live.mjs https://uxbarter.vercel.app
// Humans click the Cloudflare box 3 times (T, O1, O2). Stages:
//   A  T (default Chrome context): profile (Tech-Savvy Users) + four answers + AI consent in the REAL UI.
//      O1 creates the RELEVANT open campaign, O2 the UNRELATED open campaign. A free read of the server's own feed for T
//      (list_campaigns_v2, the eligibility authority) is saved to feed.json.            -> wait GO1
//   B  exactly ONE {"action":"recommend"} request as T (counted)                          -> response.json   -> wait GO2
//   C  T withdraws consent in the REAL UI                                                                      -> wait GO3
//   D  FREE checks (consent_required, no OpenAI call): T after withdrawal and O1 (never consented)            -> wait GO4
//   E  O1 and O2 cancel their test campaigns in the UI (refunds the credits, removes the test tasks from Discover)
// Nothing secret is read or printed: the PUBLIC publishable key comes from the deployed bundle, tokens stay in this process.
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reporter } from './lib.mjs';

const BASE = (process.argv[2] ?? 'https://uxbarter.vercel.app').replace(/\/$/, '');
const SYNC = process.env.SYNC_DIR;
if (!SYNC) throw new Error('SYNC_DIR is required');
const SB = 'https://zrzkacgarquzbemsnosw.supabase.co';
const { ok, finish } = reporter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFile = async (name, ms = 1800000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (existsSync(join(SYNC, name))) return true; await sleep(1500); } return false; };
const save = (name, v) => writeFileSync(join(SYNC, name), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const noise = (errors) => errors.filter((e) => !/Failed to load resource|Content Security Policy|Report-Only|^%c|challenges\.cloudflare|turnstile/i.test(e));

const ANSWERS = [
  'Mostly TypeScript and Node.js, React for front ends, PostgreSQL, Docker, git and GitHub Actions. I also run a small home server with Linux and Nginx and use Postman and browser dev tools daily.',
  'I built a small web app that tracks my open-source reading list. I wrote the REST API in Node with Express and PostgreSQL, the React interface, wrote migrations and set up automatic deploys with GitHub Actions to a small VPS.',
  'Our API became slow after a release. I read the logs, ran EXPLAIN ANALYZE on the slowest query, found a missing index on a join column, added it with a migration and checked the latency again with a load test.',
  'Web apps, developer tools and APIs, because I can read network requests and console errors and describe exactly what broke. I am less comfortable with native mobile apps and hardware products.',
];
const CAMPAIGNS = {
  relevant: {
    name: 'AI-match check A: REST API docs (test, ignore)',
    description: 'Automated Production check, please ignore. A developer tool with a public REST API and documentation.',
    task: 'Automated AI-match test, please ignore. Read the REST API documentation, send one authenticated request with curl or Postman, and tell us whether the error messages and the rate-limit headers are clear.',
  },
  unrelated: {
    name: 'AI-match check B: vegetarian meal planner (test, ignore)',
    description: 'Automated Production check, please ignore. A consumer recipe and meal-planning app for home cooks.',
    task: 'Automated AI-match test, please ignore. Plan one week of vegetarian dinners in the recipe app, add three recipes, build the shopping list and tell us whether the calorie labels and portion sizes are understandable.',
  },
};

const cdp = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9223');
const aiRequests = [];
const watch = (ctx) => ctx.on('request', (r) => { if (/\/functions\/v1\/ai-match/.test(r.url()) && r.method() !== 'OPTIONS') aiRequests.push(`${r.method()} ${new Date().toISOString()}`); });

async function identity(label, ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  console.log(`\n>>> HUMAN STEP (${label}): click the Cloudflare "Verify you are human" box in the Chrome window if it appears. Waiting up to 5 minutes...`);
  let token = null;
  for (const t0 = Date.now(); Date.now() - t0 < 300000 && !token; await sleep(1500)) {
    token = await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^sb-.*-auth-token$/.test(k)) { try { return JSON.parse(localStorage.getItem(k)).access_token ?? null; } catch { return null; } } return null; }).catch(() => null);
  }
  ok(!!token, `${label}: anonymous identity created (Turnstile passed)`);
  if (!token) await finish(cdp)();
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  return { page, errors, token, sub, label };
}
const consentToggle = async (page, want) => {
  const box = page.getByTestId('ai-consent-toggle');
  if ((await box.isChecked()) !== want) await box.click();
  await page.waitForFunction((w) => document.querySelector('[data-testid="ai-consent-toggle"]')?.checked === w, want, { timeout: 15000 });
};
const balance = async (page) => { const m = /(\d+)\s+credit/i.exec(await page.locator('header').innerText()); return m ? Number(m[1]) : null; };
async function createCampaign(O, c) {
  await O.page.goto(BASE + '/create', { waitUntil: 'domcontentloaded' });
  await O.page.getByText('This costs').waitFor({ timeout: 30000 });
  await O.page.getByTestId('mode-open').locator('input').click().catch(() => {});
  await O.page.getByLabel('Project name').fill(c.name);
  await O.page.getByLabel('Website URL').fill('https://uxbarter.vercel.app/');
  await O.page.getByLabel(/What does it do/).fill(c.description);
  await O.page.getByLabel(/The task/).fill(c.task);
  await O.page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await O.page.getByText('Test requested').waitFor({ timeout: 30000 });
  await O.page.waitForURL(/dashboard/, { timeout: 20000 });
  await O.page.getByText(c.name).first().waitFor({ timeout: 20000 });
}

// ---------------- A ----------------
const ctxT = cdp.contexts()[0];
watch(ctxT);
const T = await identity('T (tester)', ctxT);
await T.page.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
await T.page.getByLabel('Nickname').waitFor({ timeout: 30000 });
await T.page.getByLabel('Nickname').fill('AiMatchCheck');
await T.page.getByLabel(/bio/i).first().fill('Full-stack developer who builds and tests developer tools and web APIs.').catch(() => {});
await T.page.getByTestId('profile-cat-tech_savvy').locator('input').check();
await T.page.getByRole('button', { name: 'Save profile' }).click();
await T.page.getByTestId('experience-section').waitFor({ timeout: 30000 });
await T.page.getByTestId('answer-tech_savvy').click();
const panel = T.page.getByTestId('experience-tech_savvy');
await panel.getByTestId('answer-q1').waitFor();
for (const [i, t] of ANSWERS.entries()) await panel.getByTestId(`answer-q${i + 1}`).fill(t);
await panel.getByTestId('save-answers').click();
await panel.getByTestId('experience-saved').waitFor({ timeout: 20000 });
await T.page.reload({ waitUntil: 'domcontentloaded' });
await T.page.getByTestId('ai-consent-toggle').waitFor({ timeout: 30000 });
ok((await T.page.getByTestId('status-tech_savvy').getAttribute('data-state')) === 'pending_assessment', 'T: Tech-Savvy answers saved (pending assessment; T is NOT qualified, so only OPEN tasks are eligible)');
await consentToggle(T.page, true);
await T.page.reload({ waitUntil: 'domcontentloaded' });
await T.page.getByTestId('ai-consent-toggle').waitFor({ timeout: 30000 });
ok(await T.page.getByTestId('ai-consent-toggle').isChecked(), 'T: AI consent ON through the real consent card and persisted');
console.log('T READY', T.sub);
save('uids.json', { T: T.sub });

const ctxO1 = await cdp.newContext({ viewport: null }); watch(ctxO1);
const O1 = await identity('O1 (owner of the RELEVANT campaign)', ctxO1);
await createCampaign(O1, CAMPAIGNS.relevant);
ok((await balance(O1.page)) === 0, 'O1 spent its starter credit on the relevant campaign');
const ctxO2 = await cdp.newContext({ viewport: null }); watch(ctxO2);
const O2 = await identity('O2 (owner of the UNRELATED campaign)', ctxO2);
await createCampaign(O2, CAMPAIGNS.unrelated);
ok((await balance(O2.page)) === 0, 'O2 spent its starter credit on the unrelated campaign');
save('uids.json', { T: T.sub, O1: O1.sub, O2: O2.sub });

const anon = await fetch(BASE + '/').then((r) => r.text()).then(async (h) => { const js = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(h)?.[0]; return js ? /sb_publishable_[A-Za-z0-9_-]+/.exec(await (await fetch(`${BASE}/${js}`)).text())?.[0] : null; });
ok(!!anon, 'public publishable key found in the deployed bundle');
const call = (page, tok, path, body) => page.evaluate(async ([sb, key, tok, path, body]) => {
  const r = await fetch(sb + path, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + tok }, body });
  return { status: r.status, text: (await r.text()).slice(0, 12000) };
}, [SB, anon, tok, path, body]);
// FREE read of the server's own eligibility verdict for T (the authority the AI path must respect)
const feed = await call(T.page, T.token, '/rest/v1/rpc/list_campaigns_v2', '{}');
save('feed.json', feed);
let rows = []; try { rows = JSON.parse(feed.text); } catch { /* reported below */ }
ok(feed.status === 200 && Array.isArray(rows), `T's server-side campaign feed read (${rows.length ?? '?'} rows)`);
console.log(`\nSTAGE_A_DONE T=${T.sub} O1=${O1.sub} O2=${O2.sub}`);
if (!(await waitFile('GO1'))) { console.log('no GO1; stopping before any AI call'); await finish(cdp)(); }

// ---------------- B: exactly ONE paid recommend request ----------------
const res = await call(T.page, T.token, '/functions/v1/ai-match', '{"action":"recommend"}');
save('response.json', res);
console.log('\nRECOMMEND_HTTP', res.status, '\nRECOMMEND_BODY', res.text);
ok(res.status === 200, 'the recommendation request returned HTTP 200', String(res.status));
ok(aiRequests.length === 1, `exactly ONE ai-match request was sent in this run (${aiRequests.length})`);
if (!(await waitFile('GO2'))) { console.log('no GO2; consent NOT withdrawn'); await finish(cdp)(); }

// ---------------- C: withdraw consent in the real UI ----------------
await T.page.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
await T.page.getByTestId('ai-consent-toggle').waitFor({ timeout: 30000 });
await consentToggle(T.page, false);
await T.page.reload({ waitUntil: 'domcontentloaded' });
await T.page.getByTestId('ai-consent-toggle').waitFor({ timeout: 30000 });
ok(!(await T.page.getByTestId('ai-consent-toggle').isChecked()), 'T: AI consent is OFF after withdrawal and reload');
console.log('\nSTAGE_C_DONE');
if (!(await waitFile('GO3'))) { console.log('no GO3'); await finish(cdp)(); }

// ---------------- D: free checks (no consent => no OpenAI call) ----------------
const d1 = await call(T.page, T.token, '/functions/v1/ai-match', '{"action":"recommend"}');
const d2 = await call(O1.page, O1.token, '/functions/v1/ai-match', '{"action":"recommend"}');
save('free-checks.json', { T_after_withdrawal: d1, O1_never_consented: d2 });
console.log('\nFREE_CHECKS', JSON.stringify({ T: d1, O1: d2 }));
ok(d1.status === 200 && /consent_required/.test(d1.text), 'T after withdrawal: consent_required (profile data not used)');
ok(d2.status === 200 && /consent_required/.test(d2.text), 'O1 (never consented): consent_required (profile data not used)');
if (!(await waitFile('GO4'))) { console.log('no GO4; test campaigns NOT cancelled'); await finish(cdp)(); }

// ---------------- E: cancel the two test campaigns (refund) ----------------
for (const O of [O1, O2]) {
  await O.page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
  await O.page.getByRole('button', { name: 'Cancel & refund' }).first().click();
  await O.page.getByRole('button', { name: 'Yes, cancel & refund' }).click();
  await O.page.getByText('Cancelled — credit refunded').first().waitFor({ timeout: 20000 });
  ok((await balance(O.page)) === 1, `${O.label}: test campaign cancelled, credit refunded (balance 1)`);
}
ok(aiRequests.length === 3, `ai-match requests in total: 1 paid + 2 free consent checks (${aiRequests.length})`);
ok([T, O1, O2].every((x) => noise(x.errors).length === 0), 'no console errors', [T, O1, O2].flatMap((x) => noise(x.errors)).join(' | '));
console.log('\nSTAGE_E_DONE');
await finish(cdp)();
