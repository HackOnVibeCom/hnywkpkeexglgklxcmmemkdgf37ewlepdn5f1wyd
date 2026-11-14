// Phase 2 UI: referral capture/claim, share prompts, results ("proof") card, Cloudflare Turnstile — real Chrome,
// stubbed API. Verifies what the visitor sees and what the client sends; SQL rules live in supabase/tests.
import { CAMP_ID, createBackend, dashCampaign, iso } from './stub.mjs';
import { SHOTS, launch, newPage, overflowX, reporter, waitUntil } from './lib.mjs';

const ENV = process.env.BASE_ENV;
const CAPTCHA = process.env.BASE_CAPTCHA;
const browser = await launch();
const { ok, finish } = reporter();
const submitBtn = (page) => page.getByRole('button', { name: /Submit feedback/ });
const lsGet = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);
const clip = (page) => page.evaluate(() => navigator.clipboard.readText());
const grantClipboard = (ctx, origin) => ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
const signupBody = (be) => be.s.calls.find((c) => c.p === '/auth/v1/signup')?.body;
const hasText = async (page, t) => (await page.locator('body').innerText()).includes(t);

async function fillForm(page) {
  await page.getByLabel('Yes, I completed it').check();
  await page.getByLabel('What was confusing or caused friction?').fill('The export button was hard to find.');
  await page.getByLabel(/one improvement/).fill('Put export in the toolbar.');
  await page.getByLabel(/^4/).check({ force: true });
}

// ───────────── referral link: capture, clean URL, claim once ─────────────
console.log('\n[P1] referral capture + claim');
{
  const be = createBackend();
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/?ref=ABCDEF123456');
  await page.getByTestId('invited-note').waitFor({ timeout: 15000 });
  ok(await page.getByTestId('invited-note').isVisible(), 'landing says plainly that the visitor was invited and what the invitation does');
  ok(await waitUntil(() => be.called('claim_referral').length === 1, 15000), 'claim_referral is called once after the identity exists');
  const names = be.s.calls.map((c) => c.p.split('/').pop());
  ok(names.indexOf('ensure_profile') !== -1 && names.indexOf('ensure_profile') < names.indexOf('claim_referral'), 'the claim happens AFTER ensure_profile (profile exists first)');
  ok(JSON.stringify(be.called('claim_referral')[0].body) === JSON.stringify({ p_code: 'abcdef123456' }), 'payload matches the SQL parameter name; code is lowercased');
  ok(!page.url().includes('ref='), 'the ?ref= parameter is removed from the address bar');
  ok(await waitUntil(async () => (await lsGet(page, 'pp:ref')) === null, 5000), 'the stored code is forgotten after a definitive answer');
  await page.reload();
  await page.getByRole('link', { name: 'Get my product tested' }).first().waitFor();
  await page.waitForTimeout(500);
  ok(be.called('claim_referral').length === 1, 'reloading does not claim again');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await ctx.close();
}
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/?ref=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  await page.getByRole('link', { name: 'Get my product tested' }).first().waitFor();
  await page.waitForTimeout(600);
  ok((await lsGet(page, 'pp:ref')) === null && be.called('claim_referral').length === 0, 'a malformed ?ref= is ignored: nothing stored, nothing sent');
  ok(!page.url().includes('ref='), 'and it is still removed from the address bar');
  ok((await page.getByTestId('invited-note').count()) === 0, 'no "invited" note for a malformed code');
  await ctx.close();
}
{
  const be = createBackend();
  be.s.forced.claim_referral = { message: 'boom', sticky: true };
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/?ref=aaaaaa111111');
  ok(await waitUntil(() => be.called('claim_referral').length >= 1, 15000), 'first attempt made');
  ok((await lsGet(page, 'pp:ref')) === 'aaaaaa111111', 'a failed claim (network/server) keeps the code for the next visit');
  await page.goto(ENV + '/?ref=bbbbbb222222');
  await page.getByRole('link', { name: 'Get my product tested' }).first().waitFor();
  ok((await lsGet(page, 'pp:ref')) === 'aaaaaa111111', 'the FIRST invitation link wins; a later link does not overwrite it');
  delete be.s.forced.claim_referral;
  await page.reload();
  ok(await waitUntil(async () => (await lsGet(page, 'pp:ref')) === null, 15000), 'once the server answers, the pending code is claimed and cleared');
  ok(be.called('claim_referral').at(-1).body.p_code === 'aaaaaa111111', 'the claimed code is the first one');
  await ctx.close();
}
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/');
  await page.getByRole('link', { name: 'Get my product tested' }).first().waitFor();
  await page.waitForTimeout(500);
  ok(be.called('claim_referral').length === 0 && (await page.getByTestId('invited-note').count()) === 0, 'a visit without ?ref= never calls claim_referral');
  await ctx.close();
}

// ───────────── share prompt after earning a credit ─────────────
console.log('\n[P2] invite card after a completed test');
{
  const be = createBackend({ minMs: 1200 });
  const { ctx, page, errors } = await newPage(browser, 1280, 1000);
  await be.install(ctx);
  await grantClipboard(ctx, ENV);
  await page.goto(ENV + '/discover');
  await page.getByRole('link', { name: 'Start test' }).click();
  await page.getByRole('button', { name: /Reserve task/ }).click();
  await page.getByText('Step 1 — open the website').waitFor();
  await fillForm(page);
  await waitUntil(() => submitBtn(page).isEnabled(), 8000);
  await submitBtn(page).click();
  await page.getByText('Feedback submitted — thank you!').waitFor();
  await page.getByText('Know a founder who’d like a free usability test?').waitFor();
  const link = await page.getByLabel('Your invite link').inputValue();
  ok(link.endsWith('/?ref=abcdef123456'), 'the invite link carries the identity’s own code', link);
  ok(await hasText(page, '+1 Test Credit') && await hasText(page, 'finishes their first test'), 'the reward rule is stated plainly (what the sharer gets, and when)');
  await page.getByRole('button', { name: 'Copy invite link' }).click();
  await page.getByText('Copied!').waitFor();
  ok((await clip(page)) === link, 'Copy puts exactly the link on the clipboard');
  const x = page.getByRole('link', { name: 'Post on X' });
  const xh = await x.getAttribute('href');
  ok(xh.startsWith('https://twitter.com/intent/tweet?') && decodeURIComponent(xh).includes(link), 'X share link carries the invite link');
  ok((await x.getAttribute('target')) === '_blank' && /noopener/.test(await x.getAttribute('rel')), 'share links open in a new tab with noopener');
  ok((await page.getByRole('link', { name: 'LinkedIn' }).getAttribute('href')).startsWith('https://www.linkedin.com/sharing/share-offsite/?url='), 'LinkedIn share link');
  await page.screenshot({ path: `${SHOTS}/P2-share-card.png`, fullPage: true });
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await ctx.close();
}

// ───────────── share prompt after requesting a test ─────────────
console.log('\n[P3] invite card after requesting a test');
{
  const be = createBackend({ balance: 1 });
  const { ctx, page } = await newPage(browser, 1280, 1000);
  await be.install(ctx);
  await page.goto(ENV + '/create');
  await page.getByText('This costs').waitFor();
  await page.getByLabel('Project name').fill('Acme');
  await page.getByLabel('Website URL').fill('https://acme.example.com/app');
  await page.getByLabel(/The task/).fill('Sign up for the free plan and export your data as CSV.');
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await page.getByText('Test requested').waitFor();
  await page.getByText('Know a founder who’d like a free usability test?').waitFor();
  ok((await page.getByText('Know a founder who’d like a free usability test?').count()) === 1, 'exactly one invite card (no duplicate with the persistent one)');
  ok((await page.getByLabel('Your invite link').inputValue()).endsWith('/?ref=abcdef123456'), 'invite link carries the code');
  await ctx.close();
}

// ───────────── results / proof card + referral stats on the dashboard ─────────────
console.log('\n[P4] dashboard: results card + referral stats');
{
  const done = dashCampaign({ id: 'c1', status: 'completed', response_count: 1, completed_at: iso(Date.now()) });
  const waiting = dashCampaign({ id: 'c2' });
  const submissions = [
    { id: 's1', campaign_id: 'c1', task_completed: true, friction: 'Great flow but the export button is hidden in a submenu.', suggestion: 'Move export to the toolbar.', ux_rating: 5, share_consent: true, created_at: iso(Date.now()) },
    { id: 's2', campaign_id: 'c1', task_completed: false, friction: 'PRIVATE-NOTE: I could not find the pricing page at all.', suggestion: 'Add a pricing link.', ux_rating: 3, share_consent: false, created_at: iso(Date.now()) },
  ];
  const be = createBackend({ balance: 2, dashCampaigns: [done, waiting], submissions, referrals: { code: 'abcdef123456', cap: 3, invited: 3, converted: 2, rewarded: 1 } });
  const { ctx, page, errors } = await newPage(browser, 1280, 1000);
  await be.install(ctx);
  await grantClipboard(ctx, ENV);
  await page.goto(ENV + '/dashboard');
  await page.getByText('Share your results').waitFor();
  const names = be.s.calls.map((c) => c.p.split('/').pop());
  ok(names.indexOf('settle_referral_rewards') !== -1 && names.indexOf('settle_referral_rewards') < names.indexOf('campaigns'), 'referral rewards are settled before the dashboard data is read');
  const card = page.getByTestId('proof-card');
  const ct = await card.innerText();
  ok(/2\s+real tests/i.test(ct) && /1 of 2/.test(ct) && /4 \/ 5/.test(ct), 'card shows the REAL numbers: 2 tests, 1 of 2 completed, average 4 / 5', ct);
  ok(ct.includes('Great flow but the export button'), 'a quote appears only because that tester allowed public quoting');
  ok(!ct.includes('PRIVATE-NOTE'), 'private feedback never appears on the card');
  await page.getByRole('button', { name: 'Copy message' }).click();
  await page.getByText('Copied!').waitFor();
  let c1 = await clip(page);
  ok(c1.includes('2 testers just tested my product') && c1.includes('1/2 completed') && c1.includes('4/5') && c1.includes('/?ref=abcdef123456'), 'copied message has the stats and the invite link', c1);
  ok(c1.includes('Great flow') && !c1.includes('PRIVATE-NOTE'), 'copied message quotes only the consented feedback');
  await page.getByLabel(/Include a quote/).uncheck();
  ok(!(await card.innerText()).includes('Great flow'), 'unticking "include a quote" removes it from the card');
  await page.getByRole('button', { name: 'Copy message' }).click();
  await page.waitForTimeout(300);
  c1 = await clip(page);
  ok(!c1.includes('Great flow') && c1.includes('2 testers'), 'and from the copied message');
  const stats = await page.getByTestId('referral-stats').innerText();
  ok(/Invited:\s*3/.test(stats) && /finished a first test:\s*2/.test(stats) && /1 of 3/.test(stats), 'referral stats are the server’s real counts', stats);
  ok(await hasText(page, 'Earned — a friend you invited finished their first test') === false, 'no fake ledger lines (none in this data)');
  await page.screenshot({ path: `${SHOTS}/P4-dashboard.png`, fullPage: true });
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await ctx.close();
}
{
  const be = createBackend({ balance: 1, dashCampaigns: [dashCampaign({ id: 'only-open' })] });
  const { ctx, page } = await newPage(browser, 1280, 900);
  await be.install(ctx);
  await page.goto(ENV + '/dashboard');
  await page.getByText('Your test requests & results').waitFor();
  ok((await page.getByText('Share your results').count()) === 0 && (await page.getByTestId('proof-card').count()) === 0, 'no feedback yet -> NO results card (nothing is invented)');
  await ctx.close();
}
{
  const be = createBackend({ balance: 1, dashCampaigns: [dashCampaign({ id: 'only-open' })] });
  be.s.forced.get_my_referrals = { message: 'not_available', sticky: true };
  const { ctx, page } = await newPage(browser, 1280, 900);
  await be.install(ctx);
  await page.goto(ENV + '/dashboard');
  await page.getByText('Your test requests & results').waitFor();
  ok((await page.getByTestId('referral-stats').count()) === 0 && (await page.getByText('Know a founder who’d like a free usability test?').count()) === 1, 'if referral data is unavailable the dashboard still works and shows no fake numbers');
  await ctx.close();
}
{
  const done = dashCampaign({ id: 'c1', status: 'completed', response_count: 1, completed_at: iso(Date.now()) });
  const be = createBackend({ balance: 2, dashCampaigns: [done], submissions: [{ id: 's1', campaign_id: 'c1', task_completed: true, friction: 'Great flow but the export button is hidden in a submenu of the app.', suggestion: 'Move export.', ux_rating: 5, share_consent: true, created_at: iso(Date.now()) }] });
  const { ctx, page } = await newPage(browser, 360, 900);
  await be.install(ctx);
  await page.goto(ENV + '/dashboard');
  await page.getByText('Share your results').waitFor();
  ok(!(await overflowX(page)), '[mobile 360px] dashboard with results card + invite card has no horizontal overflow');
  await page.screenshot({ path: `${SHOTS}/P4-dashboard-mobile.png`, fullPage: true });
  await ctx.close();
}

// ───────────── Cloudflare Turnstile ─────────────
console.log('\n[P5] Turnstile on first sign-in');
const FAKE_OK = `window.turnstile = { render(el, o) { window.__rendered = { sitekey: o.sitekey, appearance: o.appearance }; setTimeout(() => o.callback('TURNSTILE-TEST-TOKEN'), 40); return 'w1'; }, remove(id) { window.__removed = id; }, reset() { window.__resets = (window.__resets || 0) + 1; } };`;
// Cloudflare "generic challenge failure" every time, even after reset()
const FAKE_FAIL = `window.turnstile = { render(el, o) { window.__o = o; window.__resets = 0; setTimeout(() => o['error-callback']('600010'), 40); return 'w2'; }, reset() { window.__resets++; setTimeout(() => window.__o['error-callback']('600010'), 40); }, remove() {} };`;
// fails once with 600010, passes after the automatic reset()
const FAKE_FLAKY = `window.turnstile = { render(el, o) { window.__o = o; window.__resets = 0; setTimeout(() => o['error-callback']('600010'), 40); return 'w3'; }, reset() { window.__resets++; setTimeout(() => window.__o.callback('TURNSTILE-RETRY-TOKEN'), 40); }, remove() {} };`;
// configuration error: hostname not allowed
const FAKE_CONFIG = `window.turnstile = { render(el, o) { window.__resets = 0; setTimeout(() => o['error-callback']('110200'), 40); return 'w4'; }, reset() { window.__resets++; }, remove() {} };`;
// never answers (visitor has not ticked the box yet)
const FAKE_PENDING = `window.turnstile = { render() { return 'w5'; }, reset() {}, remove() {} };`;
const fulfillJs = (body) => (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body });
{
  const be = createBackend();
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  let hits = 0;
  await ctx.route('https://challenges.cloudflare.com/**', (r) => { hits++; return fulfillJs(FAKE_OK)(r); });
  await page.goto(CAPTCHA + '/discover');
  await page.getByText('Acme Invoicing').waitFor({ timeout: 20000 });
  ok(hits === 1, 'the Turnstile script is loaded exactly once, from challenges.cloudflare.com');
  const body = signupBody(be);
  ok(body?.gotrue_meta_security?.captcha_token === 'TURNSTILE-TEST-TOKEN', 'the token is sent with the anonymous sign-up (gotrue_meta_security.captcha_token)', JSON.stringify(body));
  const rendered = await page.evaluate(() => window.__rendered);
  ok(rendered?.sitekey === '1x00000000000000000000AA' && rendered?.appearance === 'interaction-only', 'widget uses the PUBLIC site key and stays invisible unless interaction is needed', JSON.stringify(rendered));
  ok((await page.getByTestId('turnstile-host').count()) === 0 && (await page.evaluate(() => window.__removed)) === 'w1', 'the widget is removed once the token is obtained');
  await page.reload();
  await page.getByText('Acme Invoicing').waitFor();
  ok(be.s.signups === 1 && hits === 1, 'a returning visitor (stored session) is NOT challenged again and signs up nothing');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await ctx.close();
}
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await ctx.route('https://challenges.cloudflare.com/**', (r) => r.abort('failed'));
  await page.goto(CAPTCHA + '/discover');
  await page.getByText('Could not start your anonymous session').waitFor({ timeout: 20000 });
  ok(await page.getByText(/Could not load the human check/).isVisible(), 'a blocked Turnstile script shows an actionable message');
  ok(be.s.signups === 0, 'no anonymous account is created without the human check');
  await ctx.unroute('https://challenges.cloudflare.com/**');
  await ctx.route('https://challenges.cloudflare.com/**', fulfillJs(FAKE_OK));
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByText('Acme Invoicing').waitFor({ timeout: 20000 });
  ok(be.s.signups === 1, 'Try again works once the script can load');
  await ctx.close();
}
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await ctx.route('https://challenges.cloudflare.com/**', fulfillJs(FAKE_FAIL));
  await page.goto(CAPTCHA + '/discover');
  await page.getByText('Could not start your anonymous session').waitFor({ timeout: 20000 });
  ok(await page.getByText(/could not be completed \(Cloudflare code 600010\)/).isVisible() && be.s.signups === 0, 'a failing challenge ends in a clear error that includes Cloudflare’s code, and creates no account', (await page.locator('body').innerText()).slice(0, 300));
  ok((await page.evaluate(() => window.__resets)) === 2, 'it retried exactly twice with turnstile.reset() before giving up (3 attempts)');
  ok((await page.getByRole('button', { name: 'Try again' }).count()) === 1 && (await page.getByTestId('turnstile-host').count()) === 0, 'the Try again button is offered and the widget is cleaned up');
  ok(!(await page.locator('body').innerText()).includes('The human check failed'), 'the old generic message is gone');
  await ctx.close();
}
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await ctx.route('https://challenges.cloudflare.com/**', fulfillJs(FAKE_FLAKY));
  await page.goto(CAPTCHA + '/discover');
  await page.getByText('Acme Invoicing').waitFor({ timeout: 20000 });
  ok(be.s.signups === 1 && signupBody(be)?.gotrue_meta_security?.captcha_token === 'TURNSTILE-RETRY-TOKEN', 'a transient 600010 is retried automatically and the second token signs the visitor in');
  ok((await page.evaluate(() => window.__resets)) === 1, 'exactly one reset() was needed');
  await ctx.close();
}
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await ctx.route('https://challenges.cloudflare.com/**', fulfillJs(FAKE_CONFIG));
  await page.goto(CAPTCHA + '/discover');
  await page.getByText('Could not start your anonymous session').waitFor({ timeout: 20000 });
  ok(await page.getByText(/not set up correctly for this website \(Cloudflare code 110200\)/).isVisible(), 'a configuration error (110200 hostname not allowed) is reported as such, with its code', (await page.locator('body').innerText()).slice(0, 300));
  ok((await page.evaluate(() => window.__resets)) === 0 && be.s.signups === 0, 'configuration errors are NOT retried and create no account');
  await ctx.close();
}
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await ctx.route('https://challenges.cloudflare.com/**', fulfillJs(FAKE_PENDING));
  await page.goto(CAPTCHA + '/discover');
  await page.getByTestId('captcha-hint').waitFor({ timeout: 20000 });
  ok(/Verify you are human/.test(await page.getByTestId('captcha-hint').innerText()) && (await page.getByText('Setting up your anonymous session…').isVisible()), 'while the check is pending the visitor is told to tick the box at the bottom of the page');
  ok(be.s.signups === 0, 'no account exists until the check is passed');
  await ctx.close();
}
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Acme Invoicing').waitFor();
  ok((await page.getByTestId('captcha-hint').count()) === 0, 'without a site key the hint never appears');
  await ctx.close();
}
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  be.s.signupReject = true;
  let hits = 0;
  await ctx.route('https://challenges.cloudflare.com/**', (r) => { hits++; return r.abort('failed'); });
  await page.goto(ENV + '/discover');
  await page.getByText('Acme Invoicing').waitFor();
  ok(hits === 0, 'WITHOUT a site key (the current production build) Cloudflare is never contacted');
  ok(signupBody(be)?.gotrue_meta_security?.captcha_token === undefined, 'and the sign-up carries no captcha token — behaviour is unchanged until CAPTCHA is switched on');
  await ctx.close();
}

await finish(browser)();
