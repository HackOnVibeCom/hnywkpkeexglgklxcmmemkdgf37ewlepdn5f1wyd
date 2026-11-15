// LIVE Production check with REAL anonymous identities (headed Chrome; a HUMAN passes the Cloudflare Turnstile check in each window).
// It WRITES to production, minimally and on purpose: two throw-away identities, ONE clearly labelled test campaign ("UXBarter release
// check (ignore)"), ONE feedback, a consent toggle. Nothing is deleted. No AI is involved (the AI flag is off).
//   node tests/browser/prod-e2e.mjs https://uxbarter.vercel.app
// Identity A: general category -> four answers -> Active -> creates the test campaign.
// Identity B (arrives through A's referral link): professional category -> four answers -> stays Pending (no AI) -> still reserves A's
//   open task, keeps the reservation across a reload, completes it, earns the credit; cannot read anybody's private data.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { reporter } from './lib.mjs';

const BASE = (process.argv[2] ?? 'https://uxbarter.vercel.app').replace(/\/$/, '');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const ANON = process.env.PROD_ANON_KEY ?? ''; // the PUBLIC anon key (read from the deployed bundle by the caller); never printed
const SB = process.env.PROD_SUPABASE_URL ?? '';
const { ok, finish } = reporter();
const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--window-size=1280,1000'] });
const NAME = 'UXBarter release check (ignore)';
const noise = (errors) => errors.filter((e) => !/Failed to load resource|Content Security Policy|Report-Only|^%c|challenges\.cloudflare|turnstile/i.test(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function identity(label, path = '/') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  console.log(`\n>>> HUMAN STEP (${label}): a Chrome window is open. If a Cloudflare "Verify you are human" box appears, click it. Waiting up to 4 minutes...`);
  const t0 = Date.now();
  let token = null;
  while (Date.now() - t0 < 240000) {
    token = await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (/^sb-.*-auth-token$/.test(k)) { try { return JSON.parse(localStorage.getItem(k)).access_token ?? null; } catch { return null; } }
      return null;
    }).catch(() => null);
    if (token) break;
    await sleep(1500);
  }
  ok(!!token, `${label}: an anonymous identity was created (Turnstile passed)`);
  if (!token) { await finish(browser)(); }
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  return { ctx, page, errors, token, sub };
}
const balance = async (page) => {
  const t = await page.locator('header').innerText();
  const m = /(\d+)\s+credit/i.exec(t);
  return m ? Number(m[1]) : null;
};
const ANSWERS = (tag) => [
  `I use ${tag} tools almost every single day for my own projects.`,
  `A small project where I built ${tag} things myself over a few weekends.`,
  `Something broke once so I read the ${tag} logs carefully and fixed it.`,
  `Products related to ${tag} are the ones I enjoy testing the most.`,
];
async function answerCategory(page, cat, tag) {
  await page.getByTestId(`answer-${cat}`).click();
  const panel = page.getByTestId(`experience-${cat}`);
  await panel.getByTestId('answer-q1').waitFor();
  for (const [i, t] of ANSWERS(tag).entries()) await panel.getByTestId(`answer-q${i + 1}`).fill(t);
  await panel.getByTestId('save-answers').click();
  await panel.getByTestId('experience-saved').waitFor({ timeout: 20000 });
  return panel.getByTestId('experience-saved').innerText();
}

// ============================ Identity A ============================
console.log('\n[A] general category tester + requester');
const A = await identity('identity A');
{
  const { page, errors } = A;
  await page.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Nickname').waitFor({ timeout: 30000 });
  ok((await page.getByTestId('experience-section').count()) === 0, 'A: before saving a profile there is no questions section yet');
  await page.getByLabel('Nickname').fill('ReleaseCheckA');
  await page.getByTestId('profile-cat-students_learners').locator('input').check();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByTestId('experience-section').waitFor({ timeout: 30000 });
  ok(true, 'A: migration 8 is live: saving the profile reveals the four-questions section');
  ok((await page.getByTestId('profile-incomplete').count()) === 1, 'A: the profile is shown as incomplete until the four answers are saved (new gate explained)');
  const msg = await answerCategory(page, 'students_learners', 'study');
  ok(/now active/i.test(msg), 'A: four open-ended answers saved: "this category is now active"', msg);
  await page.getByTestId('profile-complete').waitFor({ timeout: 20000 });
  ok((await page.getByTestId('status-students_learners').getAttribute('data-state')) === 'active', 'A: General category Students & Learners is ACTIVE (no assessment needed)');
  ok((await page.getByTestId('assessment-panel').count()) === 0, 'A: no AI assessment panel is shown (AI flag off)');
  // request a test (open)
  await page.goto(BASE + '/create', { waitUntil: 'domcontentloaded' });
  await page.getByText('This costs').waitFor({ timeout: 30000 });
  const before = await balance(page);
  await page.getByTestId('mode-open').locator('input').check().catch(() => {});
  await page.getByLabel('Project name').fill(NAME);
  await page.getByLabel('Website URL').fill('https://uxbarter.vercel.app/');
  await page.getByLabel(/The task/).fill('This is an automated release check. Open the landing page and tell us what the product promises. Please ignore this task.');
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await page.getByText('Test requested').waitFor({ timeout: 30000 });
  ok(true, `A: campaign creation works (balance before ${before})`);
  await page.waitForURL(/dashboard/, { timeout: 20000 });
  await page.getByText(NAME).first().waitFor({ timeout: 20000 });
  ok(true, 'A: the new campaign is listed on A\'s dashboard');
  ok((await balance(page)) === (before ?? 1) - 1, 'A: exactly one credit was spent', String(await balance(page)));
  A.refLink = (await page.locator('body').innerText()).match(/https?:\/\/\S+\/\?ref=[A-Za-z0-9_-]+/)?.[0] ?? null;
  ok(!!A.refLink, 'A: a referral link is available on the dashboard');
  A.balanceAfterCreate = await balance(page);
  ok(noise(errors).length === 0, 'A: no console errors in the flow', noise(errors).join(' | '));
}

// ============================ Identity B ============================
console.log('\n[B] professional-category tester arriving through A\'s referral link');
const B = await identity('identity B', A.refLink ? new URL(A.refLink).pathname + new URL(A.refLink).search : '/');
{
  const { page, errors } = B;
  await page.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Nickname').waitFor({ timeout: 30000 });
  await page.getByLabel('Nickname').fill('ReleaseCheckB');
  await page.getByTestId('profile-cat-tech_savvy').locator('input').check();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByTestId('experience-section').waitFor({ timeout: 30000 });
  // without answers the tester cannot reserve (the new gate), but can browse
  await page.goto(BASE + '/discover', { waitUntil: 'domcontentloaded' });
  const li = page.getByTestId('eligible-list').locator('> li').filter({ hasText: NAME });
  const inList = await li.count().then((n) => n > 0, () => false);
  console.log(`    (B before answers: release-check task visible in the eligible list: ${inList})`);
  await page.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('experience-section').waitFor();
  const msg = await answerCategory(page, 'tech_savvy', 'technical');
  ok(/pending/i.test(msg), 'B: professional answers saved => "pending assessment"', msg);
  ok((await page.getByTestId('status-tech_savvy').getAttribute('data-state')) === 'pending_assessment', 'B: the professional category is PENDING (it is not active without a valid assessment)');
  ok((await page.getByTestId('profile-complete').count()) === 1, 'B: the profile counts as complete for participation');
  ok((await page.getByTestId('assessment-panel').count()) === 0, 'B: no AI panel / no AI request (flag off)');
  // consent toggle round trip (writes one consent row; no AI is called)
  await page.getByTestId('ai-consent-toggle').check();
  await page.getByTestId('ai-consent-state').filter({ hasText: 'ON' }).waitFor({ timeout: 20000 });
  await page.getByTestId('ai-consent-toggle').uncheck();
  await page.getByTestId('ai-consent-state').filter({ hasText: 'OFF' }).waitFor({ timeout: 20000 });
  ok(true, 'B: consent can be switched on and off again (set_ai_consent works; nothing is sent anywhere)');
  // privacy probes with B's own session
  const probe = (path, method = 'GET', body) => page.evaluate(async ([sb, key, tok, path, method, body]) => {
    const r = await fetch(sb + path, { method, headers: { apikey: key, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, text: (await r.text()).slice(0, 160) };
  }, [SB, ANON, B.token, path, method, body]);
  const t1 = await probe('/rest/v1/experience_answers?select=*');
  const t2 = await probe('/rest/v1/category_qualifications?select=*');
  const t3 = await probe('/rest/v1/ai_consents?select=*');
  const t4 = await probe('/rest/v1/rpc/service_get_ai_profile', 'POST', { p_user_id: A.sub });
  const t5 = await probe('/rest/v1/rpc/service_record_qualification', 'POST', { p_user_id: B.sub, p_category: 'tech_savvy', p_question_version: 1, p_answers_hash: 'a'.repeat(64), p_status: 'qualified' });
  const denied = (r) => r.status === 401 || r.status === 403 || r.status === 404;
  ok(denied(t1) && denied(t2) && denied(t3), 'B: the private tables (answers, qualifications, consents) cannot be read through the API', JSON.stringify([t1.status, t2.status, t3.status]));
  ok(denied(t4) && denied(t5), 'B: the server-only AI functions (read another tester\'s profile, record a qualification) are refused for a signed-in user', JSON.stringify([t4.status, t5.status]));
  const own = await probe('/rest/v1/rpc/get_experience_questions', 'POST', { p_category: 'students_learners' });
  ok(own.status === 200 && /"answers":null/.test(own.text.replace(/\s/g, '')), 'B: the answers endpoint returns only B\'s own data (A\'s students answers are not visible: answers null)', own.text);
  // open task is reservable by a PENDING professional
  await page.goto(BASE + '/discover', { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('eligible-list').locator('> li').filter({ hasText: NAME });
  await card.first().waitFor({ timeout: 30000 });
  ok(true, 'B: A\'s existing/new campaign is accessible in "Browse all eligible tests" for a pending professional');
  await card.first().getByRole('link', { name: 'Start test' }).click();
  await page.getByRole('button', { name: /Reserve task/ }).click();
  await page.getByText('Step 1 — open the website').waitFor({ timeout: 30000 });
  ok(true, 'B: a PENDING professional can reserve an open task (nobody is blocked by the missing assessment)');
  const url = page.url();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Step 1 — open the website').waitFor({ timeout: 30000 });
  ok(page.url() === url, 'B: the reservation is still valid after a reload (in-progress reservations are kept)');
  const b0 = await balance(page);
  await page.getByLabel('Yes, I completed it').check();
  await page.getByLabel('What was confusing or caused friction?').fill('RELEASE-CHECK feedback: automated release test, please ignore.');
  await page.getByLabel(/one improvement/).fill('RELEASE-CHECK suggestion: nothing, this is an automated test.');
  await page.getByLabel(/^4/).check({ force: true });
  const btn = page.getByRole('button', { name: /Submit feedback/ });
  const t0 = Date.now();
  while (Date.now() - t0 < 100000 && !(await btn.isEnabled())) await sleep(2000);
  ok(await btn.isEnabled(), 'B: submit becomes enabled after the minimum testing time');
  await btn.click();
  await page.getByText('Feedback submitted — thank you!').waitFor({ timeout: 30000 });
  ok(true, 'B: feedback submitted');
  ok((await balance(page)) === (b0 ?? 1) + 1, `B: the reward credit was awarded exactly once (${b0} -> ${await balance(page)})`);
  ok(noise(errors).length === 0, 'B: no console errors in the flow', noise(errors).join(' | '));
}

// ============================ back to A: feedback + referral ============================
{
  const { page } = A;
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByText('RELEASE-CHECK feedback').first().waitFor({ timeout: 30000 }).catch(() => {});
  ok((await page.locator('body').innerText()).includes('RELEASE-CHECK feedback'), 'A: the founder sees the tester\'s feedback on the dashboard (feedback flow intact)');
  const bal = await balance(page);
  console.log(`    (A balance after creating: ${A.balanceAfterCreate}; after B finished: ${bal}; a referral bonus, if the referral rules grant one, shows as +1)`);
  ok(bal !== null && bal >= (A.balanceAfterCreate ?? 0), 'A: credits did not decrease');
}
console.log(`\nIdentities: A=${A.sub} B=${B.sub} (throw-away anonymous users; campaign "${NAME}")`);
await finish(browser)();
