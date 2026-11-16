// LIVE Production proof that the referral trigger (migration 11) pays the referrer AT COMPLETION, and a check of the hosted ai-match
// function with a REAL user token. It attaches (CDP) to a NORMAL Chrome window that a human started (so Cloudflare Turnstile can be
// passed by the human; a Playwright-launched Chrome is refused by Turnstile):
//   chrome.exe --remote-debugging-port=9223 --user-data-dir=<private folder> --no-first-run
//   node tests/browser/prod-referral-live.mjs https://uxbarter.vercel.app
// Flow: identity A creates a campaign; identity B joins through A's referral link, completes the profile, reserves and completes A's OWN
// campaign. A's page is NOT opened or refreshed afterwards: the database is checked separately (created_at of A's reward must equal the
// created_at of B's test reward = the same transaction = the trigger). Writes to production on purpose: 2 throw-away identities, ONE
// labelled campaign, ONE feedback. No AI is involved (flags off).
import { chromium } from 'playwright-core';
import { reporter } from './lib.mjs';

const BASE = (process.argv[2] ?? 'https://uxbarter.vercel.app').replace(/\/$/, '');
const SB = process.env.PROD_SUPABASE_URL ?? '';
const ANON = process.env.PROD_ANON_KEY ?? ''; // PUBLIC anon key (from the deployed bundle); never printed
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9223';
const NAME = 'UXBarter live referral check (ignore)';
const { ok, finish } = reporter();
const browser = await chromium.connectOverCDP(CDP);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noise = (errors) => errors.filter((e) => !/Failed to load resource|Content Security Policy|Report-Only|^%c|challenges\.cloudflare|turnstile/i.test(e));

async function identity(label, path = '/') {
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  console.log(`\n>>> HUMAN STEP (${label}): in the Chrome window that just opened, click the Cloudflare "Verify you are human" box if it appears. Waiting up to 5 minutes...`);
  const t0 = Date.now();
  let token = null;
  while (Date.now() - t0 < 300000) {
    token = await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (/^sb-.*-auth-token$/.test(k)) { try { return JSON.parse(localStorage.getItem(k)).access_token ?? null; } catch { return null; } }
      return null;
    }).catch(() => null);
    if (token) break;
    await sleep(1500);
  }
  ok(!!token, `${label}: an anonymous identity was created (Turnstile passed)`);
  if (!token) await finish(browser)();
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  return { ctx, page, errors, token, sub };
}
const balance = async (page) => { const m = /(\d+)\s+credit/i.exec(await page.locator('header').innerText()); return m ? Number(m[1]) : null; };
const ANSWERS = [
  'I use study tools almost every single day for my own projects.',
  'A small project where I built study things myself over a few weekends.',
  'Something broke once so I read the study logs carefully and fixed it.',
  'Products related to study are the ones I enjoy testing the most.',
];

// ============================ A: requester ============================
// RESUME MODE: REF_CODE=<A's public referral code> skips identity A (its campaign already exists) and only runs B + the hosted checks.
const RESUME = process.env.REF_CODE ?? '';
let A = null;
let link = RESUME ? `${BASE}/?ref=${RESUME}` : null;
if (!RESUME) {
console.log('\n[A] creates a campaign and shares the referral link');
A = await identity('identity A');
await A.page.goto(BASE + '/create', { waitUntil: 'domcontentloaded' });
await A.page.getByText('This costs').waitFor({ timeout: 30000 });
const a0 = await balance(A.page);
ok(a0 === 1, `A starts with 1 starter credit (header shows ${a0})`);
await A.page.getByTestId('mode-open').locator('input').check().catch(() => {});
await A.page.getByLabel('Project name').fill(NAME);
await A.page.getByLabel('Website URL').fill('https://uxbarter.vercel.app/');
await A.page.getByLabel(/The task/).fill('Automated live referral check. Open the landing page and tell us what the product promises. Please ignore this task.');
await A.page.getByRole('button', { name: /Spend 1 credit/ }).click();
await A.page.getByText('Test requested').waitFor({ timeout: 30000 });
await A.page.waitForURL(/dashboard/, { timeout: 20000 });
await A.page.getByText(NAME).first().waitFor({ timeout: 20000 });
ok((await balance(A.page)) === 0, 'A spent the starter credit on the campaign (balance 0)');
const vals = await A.page.locator('input, textarea').evaluateAll((els) => els.map((e) => e.value));
link = [...vals, await A.page.locator('body').innerText()].join(' ').match(/https?:\/\/\S+\/\?ref=[A-Za-z0-9_-]+/)?.[0] ?? null;
ok(!!link, 'A has a referral link on the dashboard');
console.log('    (A\'s page stays untouched from here on: no reload, no navigation)');
}

// ============================ B: joins via the link ============================
console.log('\n[B] joins through A\'s link, completes the profile and A\'s campaign');
const B = await identity('identity B', new URL(link).pathname + new URL(link).search);
await B.page.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
await B.page.getByLabel('Nickname').waitFor({ timeout: 30000 });
await B.page.getByLabel('Nickname').fill('LiveReferralB');
await B.page.getByTestId('profile-cat-students_learners').locator('input').check();
await B.page.getByRole('button', { name: 'Save profile' }).click();
await B.page.getByTestId('experience-section').waitFor({ timeout: 30000 });
await B.page.getByTestId('answer-students_learners').click();
const panel = B.page.getByTestId('experience-students_learners');
await panel.getByTestId('answer-q1').waitFor();
for (const [i, t] of ANSWERS.entries()) await panel.getByTestId(`answer-q${i + 1}`).fill(t);
await panel.getByTestId('save-answers').click();
await panel.getByTestId('experience-saved').waitFor({ timeout: 20000 });
await B.page.getByTestId('profile-complete').waitFor({ timeout: 20000 });
ok(true, 'B completed the four-question profile (general category active)');
await B.page.goto(BASE + '/discover', { waitUntil: 'domcontentloaded' });
const card = B.page.getByTestId('eligible-list').locator('> li').filter({ hasText: NAME });
await card.first().waitFor({ timeout: 30000 });
await card.first().getByRole('link', { name: 'Start test' }).click();
await B.page.getByRole('button', { name: /Reserve task/ }).click();
await B.page.getByText('Step 1 — open the website').waitFor({ timeout: 30000 });
const b0 = await balance(B.page);
await B.page.getByLabel('Yes, I completed it').check();
await B.page.getByLabel('What was confusing or caused friction?').fill('LIVE-REFERRAL-CHECK feedback: automated test, please ignore.');
await B.page.getByLabel(/one improvement/).fill('LIVE-REFERRAL-CHECK suggestion: nothing, automated test.');
await B.page.getByLabel(/^4/).check({ force: true });
const btn = B.page.getByRole('button', { name: /Submit feedback/ });
const t0 = Date.now();
while (Date.now() - t0 < 100000 && !(await btn.isEnabled())) await sleep(2000);
ok(await btn.isEnabled(), 'B: submit enabled after the minimum testing time');
await btn.click();
await B.page.getByText('Feedback submitted — thank you!').waitFor({ timeout: 30000 });
ok((await balance(B.page)) === (b0 ?? 1) + 1, `B earned the test credit (${b0} -> ${await balance(B.page)})`);
console.log(`\n>>> BROWSER PART DONE. A's page was not touched after B's completion.\n    A_SUB=${A?.sub ?? '(resumed)'}\n    B_SUB=${B.sub}`);
const U = A ?? B; // the identity whose token is used for the hosted-function checks

// ============================ hosted ai-match with REAL user tokens ============================
console.log('\n[hosted ai-match with a real user token (AI flags are off)]');
const fn = (page, token, body, extra = {}) => page.evaluate(async ([sb, key, tok, body, extra]) => {
  const r = await fetch(sb + '/functions/v1/ai-match', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...extra }, body });
  return { status: r.status, text: (await r.text()).slice(0, 200) };
}, [SB, ANON, token, body, extra]);
const r1 = await fn(U.page, U.token, '{"action":"recommend"}');
const r2 = await fn(U.page, U.token, '{"action":"assess"}');
ok(r1.status === 200 && /"status":"unavailable"/.test(r1.text) && r2.status === 200 && /"status":"unavailable"/.test(r2.text), 'a REAL user token passes the gateway and the function: both actions answer "unavailable" (disabled), nothing is processed', JSON.stringify([r1, r2]));
const bad = await Promise.all([fn(U.page, U.token, '{"action":"other"}'), fn(U.page, U.token, '{"action":"recommend","userId":"x"}'), fn(U.page, U.token, 'not json'), fn(U.page, U.token, '{"action":"recommend","pad":"' + 'x'.repeat(3000) + '"}')]);
ok(bad[0].status === 400 && bad[1].status === 400 && bad[2].status === 400 && bad[3].status === 413, 'request validation: unknown action / extra field / invalid JSON -> 400, oversized body -> 413', JSON.stringify(bad.map((x) => x.status)));
const forged = await fn(A.page, U.token.slice(0, -4) + 'AAAA', '{"action":"recommend"}');
ok(forged.status === 401, 'a token with a tampered signature is rejected (401)', JSON.stringify(forged));
const evil = await fn(U.page, U.token, '{"action":"recommend"}', { Origin: 'https://evil.example' });
ok(evil.status === 200 || evil.status === 403, '(browser forbids overriding Origin; informational)');
ok(noise(B.errors).length === 0 && (!A || noise(A.errors).length === 0), 'no console errors in the browser identities', noise(B.errors).join(' | '));
await finish(browser)();
