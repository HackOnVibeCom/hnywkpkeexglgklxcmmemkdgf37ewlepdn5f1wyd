// FIRST LIVE AI ASSESSMENT in Production, one throw-away identity, ONE real call. Staged so a human/operator can verify the database
// between the stages. It attaches (CDP) to a NORMAL Chrome that a human started so Cloudflare Turnstile can be passed by the human:
//   chrome.exe --remote-debugging-port=9223 --user-data-dir=<private folder> --no-first-run
//   SYNC_DIR=<folder> node tests/browser/prod-ai-assess-live.mjs https://uxbarter.vercel.app
// Stages (the script waits for the files GO1 / GO2 in SYNC_DIR, so the operator controls when paid/state-changing steps happen):
//   A  identity -> profile (Tech-Savvy Users) -> four answers -> AI consent switched on in the REAL UI -> state must be "pending assessment".
//   (operator verifies the DB, enables AI_ASSESSMENT_ENABLED, creates GO1)
//   B  exactly ONE {"action":"assess"} request with the identity's own session token (the production UI does not call it while
//      VITE_AI_MATCHING is unset, so this is the same request the UI would send). The number of ai-match requests is counted.
//   (operator verifies response/DB/cost, creates GO2)
//   C  AI consent withdrawn in the REAL UI -> the category must be pending again after a reload.
// No secret is read or printed: the PUBLIC publishable key comes from the deployed bundle; the user token stays in this process.
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reporter } from './lib.mjs';

const BASE = (process.argv[2] ?? 'https://uxbarter.vercel.app').replace(/\/$/, '');
const SYNC = process.env.SYNC_DIR;
if (!SYNC) throw new Error('SYNC_DIR is required');
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9223';
const SB = 'https://zrzkacgarquzbemsnosw.supabase.co';
const { ok, finish } = reporter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFile = async (name, ms = 900000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (existsSync(join(SYNC, name))) return true; await sleep(1500); } return false; };
const noise = (errors) => errors.filter((e) => !/Failed to load resource|Content Security Policy|Report-Only|^%c|challenges\.cloudflare|turnstile/i.test(e));

const ANSWERS = [
  'Mostly TypeScript and Node.js, React for front ends, PostgreSQL, Docker, git and GitHub Actions. I also run a small home server with Linux and Nginx and use Postman and browser dev tools daily.',
  'I built a small web app that tracks my open-source reading list. I wrote the REST API in Node with Express and PostgreSQL, the React interface, wrote migrations and set up automatic deploys with GitHub Actions to a small VPS.',
  'Our API became slow after a release. I read the logs, ran EXPLAIN ANALYZE on the slowest query, found a missing index on a join column, added it with a migration and checked the latency again with a load test.',
  'Web apps, developer tools and APIs, because I can read network requests and console errors and describe exactly what broke. I am less comfortable with native mobile apps and hardware products.',
];

// USE_DEFAULT_CONTEXT=1: use the human's own Chrome profile (its tab already passed Turnstile and holds an identity); otherwise a fresh context.
const cdp = await chromium.connectOverCDP(CDP);
const ctx = process.env.USE_DEFAULT_CONTEXT === '1' && cdp.contexts().length ? cdp.contexts()[0] : await cdp.newContext({ viewport: null });
const consentToggle = async (page, want) => { // the box is controlled: it flips only after the server round-trip, so click and wait
  const box = page.getByTestId('ai-consent-toggle');
  if ((await box.isChecked()) !== want) await box.click();
  await page.waitForFunction((w) => document.querySelector('[data-testid="ai-consent-toggle"]')?.checked === w, want, { timeout: 15000 });
};
const page = await ctx.newPage();
const errors = [];
const aiRequests = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
ctx.on('request', (r) => { if (/\/functions\/v1\/ai-match/.test(r.url()) && r.method() !== 'OPTIONS') aiRequests.push(`${r.method()} ${new Date().toISOString()}`); });

// ---- A: identity + profile + answers + consent
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
console.log('\n>>> HUMAN STEP: in the Chrome window, click the Cloudflare "Verify you are human" box if it appears. Waiting up to 5 minutes...');
let token = null;
for (const t0 = Date.now(); Date.now() - t0 < 300000 && !token; await sleep(1500)) {
  token = await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^sb-.*-auth-token$/.test(k)) { try { return JSON.parse(localStorage.getItem(k)).access_token ?? null; } catch { return null; } } return null; }).catch(() => null);
}
ok(!!token, 'an anonymous identity was created (Turnstile passed)');
if (!token) await finish(cdp)();
const uid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
await page.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
await page.getByLabel('Nickname').waitFor({ timeout: 30000 });
await page.getByLabel('Nickname').fill('AiAssessCheck');
await page.getByTestId('profile-cat-tech_savvy').locator('input').check();
await page.getByRole('button', { name: 'Save profile' }).click();
await page.getByTestId('experience-section').waitFor({ timeout: 30000 });
await page.getByTestId('answer-tech_savvy').click();
const panel = page.getByTestId('experience-tech_savvy');
await panel.getByTestId('answer-q1').waitFor();
for (const [i, t] of ANSWERS.entries()) await panel.getByTestId(`answer-q${i + 1}`).fill(t);
await panel.getByTestId('save-answers').click();
await panel.getByTestId('experience-saved').waitFor({ timeout: 20000 });
const st0 = await page.getByTestId('status-tech_savvy').getAttribute('data-state');
ok(st0 === 'pending_assessment', `Tech-Savvy is pending assessment before consent (state=${st0})`);
await consentToggle(page, true);
ok(true, 'AI consent switched on through the real consent card');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByTestId('ai-consent-toggle').waitFor({ timeout: 30000 });
ok(await page.getByTestId('ai-consent-toggle').isChecked(), 'consent persisted after reload');
ok((await page.getByTestId('status-tech_savvy').getAttribute('data-state')) === 'pending_assessment', 'still pending assessment (the UI makes no AI call while VITE_AI_MATCHING is unset)');
ok(aiRequests.length === 0, `the browser UI sent no ai-match request by itself (${aiRequests.length})`);
console.log(`\nSTAGE_A_DONE uid=${uid}`);
writeFileSync(join(SYNC, 'uid.txt'), uid);
if (!(await waitFile('GO1'))) { console.log('no GO1 within 15 minutes; stopping before any AI call'); await finish(cdp)(); }

// ---- B: exactly one assessment request
const anon = await (await fetch(BASE + '/')).text().then(async (h) => { const js = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(h)?.[0]; return js ? /sb_publishable_[A-Za-z0-9_-]+/.exec(await (await fetch(`${BASE}/${js}`)).text())?.[0] : null; });
ok(!!anon, 'public publishable key found in the deployed bundle');
const res = await page.evaluate(async ([sb, key, tok]) => {
  const r = await fetch(sb + '/functions/v1/ai-match', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + tok }, body: '{"action":"assess"}' });
  return { status: r.status, text: (await r.text()).slice(0, 4000) };
}, [SB, anon, token]);
writeFileSync(join(SYNC, 'assess-response.json'), JSON.stringify(res, null, 2));
console.log('\nASSESS_HTTP', res.status, '\nASSESS_BODY', res.text);
ok(res.status === 200, 'the assessment request returned HTTP 200', String(res.status));
ok(aiRequests.length === 1, `exactly ONE ai-match request was sent in this run (${aiRequests.length})`);
if (!(await waitFile('GO2'))) { console.log('no GO2 within 15 minutes; consent NOT withdrawn by this script'); await finish(cdp)(); }

// ---- C: withdraw consent in the real UI
await page.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
await page.getByTestId('ai-consent-toggle').waitFor({ timeout: 30000 });
const before = await page.getByTestId('status-tech_savvy').getAttribute('data-state');
console.log('state before withdrawal:', before);
await consentToggle(page, false);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByTestId('status-tech_savvy').waitFor({ timeout: 30000 });
const after = await page.getByTestId('status-tech_savvy').getAttribute('data-state');
ok(!(await page.getByTestId('ai-consent-toggle').isChecked()), 'AI consent is off after withdrawal and reload');
ok(after === 'pending_assessment', `Tech-Savvy is back to pending assessment after withdrawal (state=${after})`);
ok(aiRequests.length === 1, `still only one ai-match request in total (${aiRequests.length})`);
ok(noise(errors).length === 0, 'no console errors', noise(errors).join(' | '));
console.log(`\nSTAGE_C_DONE uid=${uid}`);
await finish(cdp)();
