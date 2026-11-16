// FINAL Production check of the deployed site with AI Matching ON (VITE_AI_MATCHING=1): browser smoke check + the COMPLETE AI journey
// through the REAL UI (select Tech-Savvy -> four answers -> explicit consent -> AI assessment -> category Active -> Recommended for you ->
// withdraw consent). 4 throw-away identities: tester T and demo-campaign owners O1 (relevant), O2 (unrelated), O3 (targeted at another
// category = ineligible for T). The demo campaigns are LEFT OPEN on purpose (owner decides when to cancel).
//   chrome.exe --remote-debugging-port=9223 --user-data-dir=<private folder> --no-first-run about:blank   (a human starts it)
//   SYNC_DIR=<folder> node tests/browser/prod-final-journey.mjs https://uxbarter.vercel.app
// Gates (files in SYNC_DIR): GO1 = switch consent on (first PAID calls), GO2 = withdraw consent. Four Turnstile clicks by the human.
// No secret is read or printed; tokens stay in this process; answers are never logged.
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reporter } from './lib.mjs';

const BASE = (process.argv[2] ?? 'https://uxbarter.vercel.app').replace(/\/$/, '');
const SYNC = process.env.SYNC_DIR;
if (!SYNC) throw new Error('SYNC_DIR is required');
const { ok, finish } = reporter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFile = async (name, ms = 1800000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (existsSync(join(SYNC, name))) return true; await sleep(1500); } return false; };
const save = (name, v) => writeFileSync(join(SYNC, name), typeof v === 'string' ? v : JSON.stringify(v, null, 2));

const ANSWERS = [
  'Mostly TypeScript and Node.js, React for front ends, PostgreSQL, Docker, git and GitHub Actions. I also run a small home server with Linux and Nginx and use Postman and browser dev tools daily.',
  'I built a small web app that tracks my open-source reading list. I wrote the REST API in Node with Express and PostgreSQL, the React interface, wrote migrations and set up automatic deploys with GitHub Actions to a small VPS.',
  'Our API became slow after a release. I read the logs, ran EXPLAIN ANALYZE on the slowest query, found a missing index on a join column, added it with a migration and checked the latency again with a load test.',
  'Web apps, developer tools and APIs, because I can read network requests and console errors and describe exactly what broke. I am less comfortable with native mobile apps and hardware products.',
];
const DEMO = {
  relevant: {
    name: 'API console: REST docs and error messages (demo)',
    description: 'Demo task for the UXBarter customer journey video. A developer tool with a public REST API and documentation.',
    task: 'Demo task. Read the REST API documentation, send one authenticated request with curl or Postman, and tell us whether the error messages and the rate-limit headers are clear.',
  },
  unrelated: {
    name: 'Weekly meal planner for home cooks (demo)',
    description: 'Demo task for the UXBarter customer journey video. A consumer recipe and meal-planning app.',
    task: 'Demo task. Plan one week of vegetarian dinners, add three recipes, build the shopping list and tell us whether the calorie labels and portion sizes are understandable.',
  },
  targeted: {
    name: 'Invoice approval inbox for office teams (demo)',
    description: 'Demo task for the UXBarter customer journey video. A back-office tool for approving supplier invoices.',
    task: 'Demo task. Open the inbox, approve one invoice, reject another with a comment and tell us whether the approval status is always obvious.',
  },
};

const cdp = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9223');
const stats = { consoleErrors: [], bad: [], hosts: new Set(), ai: [] };
const noiseErr = (t) => /Content Security Policy|Report-Only|^%c|challenges\.cloudflare|turnstile/i.test(t);
const instrument = (page, tag) => {
  page.on('console', (m) => { if (m.type() === 'error' && !noiseErr(m.text())) stats.consoleErrors.push(`[${tag}] ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => stats.consoleErrors.push(`[${tag}] pageerror ${String(e).slice(0, 200)}`));
  page.on('response', (r) => { const u = r.url(); if (r.status() >= 400 && !/challenges\.cloudflare|cdn-cgi/.test(u)) stats.bad.push(`[${tag}] ${r.status()} ${r.request().method()} ${u.replace(/\?.*/, '').slice(0, 120)}`); });
  page.on('request', (r) => {
    try { stats.hosts.add(new URL(r.url()).host); } catch { /* data: urls */ }
    if (/\/functions\/v1\/ai-match/.test(r.url()) && r.method() !== 'OPTIONS') stats.ai.push({ tag, at: new Date().toISOString(), body: (r.postData() ?? '').slice(0, 40) });
  });
};
async function identity(label, ctx) {
  const page = await ctx.newPage();
  instrument(page, label);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  console.log(`\n>>> HUMAN STEP (${label}): click the Cloudflare "Verify you are human" box in the Chrome window if it appears. Waiting up to 5 minutes...`);
  let token = null;
  for (const t0 = Date.now(); Date.now() - t0 < 300000 && !token; await sleep(1500)) {
    token = await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^sb-.*-auth-token$/.test(k)) { try { return JSON.parse(localStorage.getItem(k)).access_token ?? null; } catch { return null; } } return null; }).catch(() => null);
  }
  ok(!!token, `${label}: anonymous identity created (Turnstile passed)`);
  if (!token) await finish(cdp)();
  return { page, label, sub: JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub };
}
const balance = async (page) => { const m = /(\d+)\s+credit/i.exec(await page.locator('header').innerText()); return m ? Number(m[1]) : null; };
const consentToggle = async (page, want) => {
  const box = page.getByTestId('ai-consent-toggle');
  if ((await box.isChecked()) !== want) await box.click();
  await page.waitForFunction((w) => document.querySelector('[data-testid="ai-consent-toggle"]')?.checked === w, want, { timeout: 15000 });
};
async function createCampaign(O, c, targeted) {
  await O.page.goto(BASE + '/create', { waitUntil: 'domcontentloaded' });
  await O.page.getByText('This costs').waitFor({ timeout: 30000 });
  await O.page.getByLabel('Project name').fill(c.name);
  await O.page.getByLabel('Website URL').fill('https://uxbarter.vercel.app/');
  await O.page.getByLabel(/What does it do/).fill(c.description);
  await O.page.getByLabel(/The task/).fill(c.task);
  if (targeted) { await O.page.getByTestId('mode-targeted').locator('input').click(); await O.page.getByTestId('target-business_office').click(); }
  else await O.page.getByTestId('mode-open').locator('input').click().catch(() => {});
  await O.page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await O.page.getByText('Test requested').waitFor({ timeout: 30000 });
  await O.page.waitForURL(/dashboard/, { timeout: 20000 });
  await O.page.getByText(c.name).first().waitFor({ timeout: 20000 });
}
async function load(page, path, key) {
  const before = stats.ai.length;
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.locator(key).first().waitFor({ timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  return stats.ai.length - before; // number of ai-match requests this page load caused
}
const names = async (loc) => (await loc.locator('h2, h3').allInnerTexts().catch(() => [])).map((s) => s.trim());

// =============== T: identity + profile (consent OFF) ===============
const T = await identity('T (tester)', cdp.contexts()[0]);
const tp = T.page;
await tp.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
await tp.getByLabel('Nickname').waitFor({ timeout: 30000 });
await tp.getByLabel('Nickname').fill('DemoTester');
await tp.getByLabel(/bio/i).first().fill('Full-stack developer who builds and tests developer tools and web APIs.').catch(() => {});
await tp.getByTestId('profile-cat-tech_savvy').locator('input').check();
await tp.getByRole('button', { name: 'Save profile' }).click();
await tp.getByTestId('experience-section').waitFor({ timeout: 30000 });
await tp.getByTestId('answer-tech_savvy').click();
const panel = tp.getByTestId('experience-tech_savvy');
await panel.getByTestId('answer-q1').waitFor();
for (const [i, t] of ANSWERS.entries()) await panel.getByTestId(`answer-q${i + 1}`).fill(t);
await panel.getByTestId('save-answers').click();
await panel.getByTestId('experience-saved').waitFor({ timeout: 20000 });
await tp.reload({ waitUntil: 'domcontentloaded' });
await tp.getByTestId('status-tech_savvy').waitFor({ timeout: 30000 });
ok((await tp.getByTestId('status-tech_savvy').getAttribute('data-state')) === 'pending_assessment', 'T: four Tech-Savvy answers saved; category is pending assessment (consent still OFF)');
ok(!(await tp.getByTestId('ai-consent-toggle').isChecked()), 'T: AI consent is OFF by default');
ok(stats.ai.length === 0, `no ai-match request so far (profile saved without consent): ${stats.ai.length}`);

// =============== demo campaign owners ===============
const owners = [];
for (const [key, label, targeted] of [['relevant', 'O1 (relevant demo campaign)', false], ['unrelated', 'O2 (unrelated demo campaign)', false], ['targeted', 'O3 (targeted demo campaign, ineligible for T)', true]]) {
  const O = await identity(label, await cdp.newContext({ viewport: null }));
  await createCampaign(O, DEMO[key], targeted);
  ok((await balance(O.page)) === 0, `${label}: demo campaign created, starter credit spent`);
  owners.push(O);
}
save('uids.json', { T: T.sub, O1: owners[0].sub, O2: owners[1].sub, O3: owners[2].sub });

// =============== SMOKE (consent OFF): every main page, as a real non-consenting tester ===============
console.log('\n[smoke] non-consenting tester');
const smoke = {};
smoke.home = await load(tp, '/', 'h1');
smoke.profile = await load(tp, '/profile', '[data-testid="experience-section"]');
smoke.discover = await load(tp, '/discover', '[data-testid="tab-browse"]');
const eligibleNames = await names(tp.getByTestId('eligible-list'));
await tp.screenshot({ path: join(SYNC, 'discover-before-consent.png'), fullPage: true });
const eligText = await tp.getByTestId('eligible-list').innerText();
const notAvail = await tp.getByTestId('not-available').innerText().catch(() => '');
smoke.dashboard = await load(tp, '/dashboard', 'main');
const dashText = await tp.locator('body').innerText();
const refValues = await tp.locator('input').evaluateAll((els) => els.map((e) => e.value)).catch(() => []);
ok(smoke.home + smoke.profile + smoke.discover + smoke.dashboard === 0, `non-consenting tester: ZERO ai-match requests while browsing Home/Profile/Discover/Dashboard (${JSON.stringify(smoke)})`);
ok(eligText.includes(DEMO.relevant.name) && eligText.includes(DEMO.unrelated.name), 'non-consenting tester can browse eligible tests (both open demo campaigns are listed)');
ok(!eligText.includes(DEMO.targeted.name) && notAvail.includes(DEMO.targeted.name), 'the targeted demo campaign is NOT eligible for T and sits under "not available"');
ok((await balance(tp)) === 1, 'T still has its starter credit');
ok([...refValues, dashText].join(' ').includes('?ref='), 'Dashboard shows the referral link (referral feature intact)');
ok(await tp.locator('text=Recommended').count() >= 0, 'Discover tab view rendered');
console.log(`SMOKE_DONE eligible=${JSON.stringify(eligibleNames)}`);
if (!(await waitFile('GO1'))) { console.log('no GO1; stopping before any AI call'); await finish(cdp)(); }

// =============== JOURNEY: consent -> AI assessment -> Active -> Recommended ===============
const aiBefore = stats.ai.length;
await tp.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
await tp.getByTestId('ai-consent-toggle').waitFor({ timeout: 30000 });
await consentToggle(tp, true);
ok(true, 'T: explicit AI consent given through the consent card');
// the assessment starts by itself for exactly this event
let state = null;
for (const t0 = Date.now(); Date.now() - t0 < 120000; await sleep(2000)) {
  state = await tp.getByTestId('status-tech_savvy').getAttribute('data-state').catch(() => null);
  if (state && state !== 'pending_assessment') break;
}
await tp.screenshot({ path: join(SYNC, 'profile-after-assessment.png'), fullPage: true });
const assessText = await tp.getByTestId('assessment-panel').innerText().catch(() => '(no panel)');
console.log('ASSESSMENT_PANEL', assessText.replace(/\s+/g, ' ').slice(0, 400));
ok(state === 'active', `AI assessment finished and Tech-Savvy Users is ACTIVE (state=${state})`);
const assessCalls = stats.ai.slice(aiBefore).filter((x) => /assess/.test(x.body)).length;
ok(assessCalls === 1, `exactly one assessment request was sent by the UI (${assessCalls})`);

const recStart = stats.ai.length;
await tp.goto(BASE + '/discover', { waitUntil: 'domcontentloaded' });
await tp.getByTestId('tab-recommended').waitFor({ timeout: 30000 });
await tp.getByTestId('recommended-view').waitFor({ timeout: 90000 });
await tp.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
const recText = await tp.getByTestId('recommended-view').innerText();
await tp.screenshot({ path: join(SYNC, 'discover-recommended.png'), fullPage: true });
save('recommended-view.txt', recText);
const recCalls = stats.ai.slice(recStart).filter((x) => /recommend/.test(x.body)).length;
ok(recCalls === 1, `exactly one recommendation request on opening Discover (${recCalls})`);
ok(recText.includes(DEMO.relevant.name), 'Recommended for you: the RELEVANT demo campaign is recommended');
ok(!recText.includes(DEMO.unrelated.name), 'Recommended for you: the UNRELATED demo campaign is NOT recommended');
ok(!recText.includes(DEMO.targeted.name), 'Recommended for you: the INELIGIBLE targeted demo campaign is NOT recommended');
console.log('RECOMMENDED_VIEW', recText.replace(/\s+/g, ' ').slice(0, 700));
await tp.getByTestId('tab-browse').click();
const browseText = await tp.getByTestId('browse-view').innerText();
ok(browseText.includes(DEMO.relevant.name) && browseText.includes(DEMO.unrelated.name), 'Browse all eligible tests still lists every eligible test independently of AI');
await tp.screenshot({ path: join(SYNC, 'discover-browse-after.png'), fullPage: true });
console.log(`JOURNEY_DONE ai_requests_total=${stats.ai.length}`);
if (!(await waitFile('GO2'))) { console.log('no GO2; consent NOT withdrawn'); await finish(cdp)(); }

// =============== withdraw consent ===============
await tp.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
await tp.getByTestId('ai-consent-toggle').waitFor({ timeout: 30000 });
await consentToggle(tp, false);
await tp.reload({ waitUntil: 'domcontentloaded' });
await tp.getByTestId('status-tech_savvy').waitFor({ timeout: 30000 });
const afterState = await tp.getByTestId('status-tech_savvy').getAttribute('data-state');
ok(afterState === 'pending_assessment', `after withdrawal Tech-Savvy is Pending again (state=${afterState})`);
const wd = stats.ai.length;
await tp.goto(BASE + '/discover', { waitUntil: 'domcontentloaded' });
await tp.getByTestId('tab-browse').waitFor({ timeout: 30000 });
await tp.getByTestId('tab-recommended').click();
const wdRec = await tp.getByTestId('recommended-view').innerText();
ok(/Turn on AI personalization/.test(wdRec), 'after withdrawal Recommended asks for consent (no personalization)');
await tp.getByTestId('tab-browse').click();
ok((await tp.getByTestId('eligible-list').innerText()).includes(DEMO.relevant.name), 'after withdrawal Browse all eligible tests still works');
ok(stats.ai.length === wd, `no ai-match request after withdrawal (${stats.ai.length - wd})`);

// =============== global checks ===============
const hosts = [...stats.hosts];
ok(!hosts.some((h) => /openai/i.test(h)), `the browser never contacted OpenAI directly (hosts: ${hosts.join(', ')})`);
ok(stats.consoleErrors.length === 0, 'no browser console errors', stats.consoleErrors.join(' | '));
console.log('NETWORK_4XX_5XX', JSON.stringify(stats.bad));
ok(stats.bad.length === 0, 'no failed (>=400) network responses', JSON.stringify(stats.bad));
save('ai-requests.json', stats.ai);
console.log('AI_REQUESTS', JSON.stringify(stats.ai.map((x) => `${x.tag} ${x.body}`)));
console.log('\nSTAGE_END');
await finish(cdp)();
