// Core MVP flows in real Chrome against a STUBBED Supabase API (see stub.mjs).
import { CAMP_ID, SITE, createBackend, dashCampaign, iso, HOST } from './stub.mjs';
import { SHOTS, launch, newPage, overflowX, reporter, waitUntil } from './lib.mjs';

const NOENV = process.env.BASE_NOENV;
const ENV = process.env.BASE_ENV;
const browser = await launch();
const { ok, finish } = reporter();

// ───────────── A. no backend configured (what a deploy without env shows) ─────────────
console.log('\n[A] no Supabase env');
for (const [label, w] of [['desktop', 1280], ['mobile', 390]]) {
  const { ctx, page, errors } = await newPage(browser, w);
  await page.goto(NOENV + '/');
  await page.waitForSelector('h1');
  ok(await page.getByRole('link', { name: 'Get my product tested' }).first().isVisible(), `[${label}] landing CTA visible`);
  ok(!(await overflowX(page)), `[${label}] landing has no horizontal overflow`);
  await page.screenshot({ path: `${SHOTS}/A-landing-${label}.png`, fullPage: true });
  await page.goto(NOENV + '/discover');
  await page.getByText('Backend not configured').waitFor();
  ok(true, `[${label}] /discover shows explicit "Backend not configured" (no fake data)`);
  ok(!(await page.getByText(/login|sign in|password/i).count()), `[${label}] no login wall wording`);
  ok(errors.length === 0, `[${label}] no console errors`, errors.join(' | '));
  await ctx.close();
}

// ───────────── B. configured but broken backend ─────────────
console.log('\n[B] configured but backend unreachable / anonymous auth disabled');
{
  const { ctx, page } = await newPage(browser, 1280);
  await ctx.route(HOST + '/**', (r) => r.abort('failed'));
  await page.goto(ENV + '/discover');
  await page.getByText('Could not start your anonymous session').waitFor();
  ok(await page.getByText(/Could not reach the server/).isVisible(), 'unreachable backend → friendly error');
  ok(await page.getByRole('button', { name: 'Try again' }).isVisible(), 'retry button present');
  await ctx.close();
}
{
  const { ctx, page } = await newPage(browser, 1280);
  await ctx.route(HOST + '/**', (r) =>
    r.fulfill({
      status: 422,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
      body: JSON.stringify({ code: 422, error_code: 'anonymous_provider_disabled', msg: 'Anonymous sign-ins are disabled' }),
    }),
  );
  await page.goto(ENV + '/discover');
  await page.getByText('Could not start your anonymous session').waitFor();
  ok(await page.getByText(/Allow anonymous sign-ins/).isVisible(), 'anonymous auth disabled → actionable setup hint');
  await ctx.close();
}

// ───────────── C1. fresh visitor: discover → reserve → test → submit ─────────────
console.log('\n[C1] tester flow (reserve, wait, submit)');
{
  const be = createBackend({ minMs: 2500 });
  const { ctx, page, errors, dialogs } = await newPage(browser, 1280, 1000);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Acme Invoicing').waitFor();
  ok(be.s.signups === 1, `exactly one anonymous sign-up on a fresh visit (got ${be.s.signups})`);
  ok(await page.getByText('1 credit').first().isVisible(), 'header shows starter balance (1 credit) from ensure_profile');
  ok(be.called('ensure_profile').length >= 1, 'ensure_profile RPC called automatically');
  ok(!(await page.locator('body').innerText()).match(/log ?in|sign ?in|password/i), 'no login/registration UI on the Discover page');
  await page.screenshot({ path: `${SHOTS}/C-discover.png` });

  await page.getByRole('link', { name: 'Start test' }).click();
  await page.getByText('Step 1 — reserve this task').waitFor();
  ok((await page.locator('body').innerText()).includes('acme-invoices') === false, 'website URL is NOT in the page before reserving');
  ok(await page.getByText(/Step 2 .* unlocks after you reserve/).isVisible(), 'feedback form is locked until reserved');

  await page.getByRole('button', { name: /Reserve task/ }).click();
  await page.getByText('Step 1 — open the website').waitFor();
  const st = be.called('start_test')[0];
  ok(JSON.stringify(Object.keys(st.body)) === JSON.stringify(['p_campaign_id']) && st.body.p_campaign_id === CAMP_ID, 'start_test payload matches the SQL parameter name');
  const link = page.getByRole('link', { name: /Open acme-invoices/ });
  ok((await link.getAttribute('href')) === SITE, 'reserved tester sees the website link');
  ok((await link.getAttribute('target')) === '_blank' && /noopener/.test(await link.getAttribute('rel')), 'external link opens in a new tab with noopener');
  ok(await page.getByRole('button', { name: /Submit feedback/ }).isDisabled(), 'submit is disabled during the minimum testing time');
  ok(await page.getByText(/you can submit in/).isVisible(), 'countdown to the first possible submit is shown');
  await page.screenshot({ path: `${SHOTS}/C-test-page.png`, fullPage: true });

  await page.getByLabel('Yes, I completed it').check();
  await page.getByLabel('What was confusing or caused friction?').fill('Export button was hard to find.');
  await page.getByLabel(/one improvement/).fill('Put export in the toolbar.');
  await page.getByLabel(/^4/).check({ force: true });
  const enabled = await waitUntil(() => page.getByRole('button', { name: /Submit feedback/ }).isEnabled(), 8000);
  ok(enabled, 'submit becomes enabled once the minimum time has passed');
  await page.getByRole('button', { name: /Submit feedback/ }).click();
  await page.getByText('Feedback submitted — thank you!').waitFor();
  const sub = be.called('submit_test')[0];
  ok(JSON.stringify(Object.keys(sub.body).sort()) === JSON.stringify(['p_campaign_id', 'p_friction', 'p_share_consent', 'p_suggestion', 'p_task_completed', 'p_ux_rating'].sort()), 'submit_test payload keys match the SQL parameter names', JSON.stringify(sub.body));
  ok(sub.body.p_ux_rating === 4 && sub.body.p_task_completed === true && sub.body.p_share_consent === false, 'payload values correct; share consent defaults to false');
  ok(sub.at - st.at >= 2400, `submit_test was sent only after the minimum time (${sub.at - st.at} ms after start)`);
  ok((await page.getByText('Your balance is now').isVisible()) && (await page.getByText('2 credits').first().isVisible()), 'success shows +1 credit and header balance becomes 2');
  ok((await page.evaluate(() => sessionStorage.length)) === 0, 'saved draft is cleared after a successful submit');
  await page.screenshot({ path: `${SHOTS}/C-test-success.png` });
  ok(errors.length === 0, 'no console errors in the tester flow', errors.join(' | '));
  ok(dialogs.n === 0, 'no JS dialogs fired');
  await ctx.close();
}

// ───────────── C2. create a task ─────────────
console.log('\n[C2] request a test');
{
  const be = createBackend({ balance: 1 });
  const { ctx, page, errors } = await newPage(browser, 1280, 1000);
  await be.install(ctx);
  await page.goto(ENV + '/create');
  await page.getByText('This costs').waitFor();
  ok(await page.getByText(/refunded/).first().isVisible(), 'create page explains the 7-day expiry and refund');
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  ok(await page.getByText(/Name must be/).isVisible(), 'empty submit shows validation');
  await page.getByLabel('Project name').fill('Acme');
  await page.getByLabel('Website URL').fill('http://localhost:3000');
  await page.getByLabel(/The task/).fill('short');
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  ok(await page.getByText(/no localhost or IP/).first().isVisible(), 'localhost URL rejected client-side');
  ok(await page.getByText(/Describe the task in 20/).isVisible(), 'short task rejected');
  await page.getByLabel('Website URL').fill('javascript:alert(1)');
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  ok(await page.getByText(/no localhost or IP/).first().isVisible(), 'javascript: URL rejected');
  await page.getByLabel('Website URL').fill('https://acme.example.com/app?x=1');
  await page.getByLabel(/The task/).fill('Sign up for the free plan and export your data as CSV.');
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await page.getByText('Test requested').waitFor();
  const cr = be.called('create_project_with_campaign')[0];
  ok(JSON.stringify(Object.keys(cr.body).sort()) === JSON.stringify(['p_description', 'p_name', 'p_task', 'p_url']), 'create payload keys match the SQL parameter names', JSON.stringify(cr?.body));
  ok(page.url().endsWith('/dashboard'), 'create → redirected to dashboard');
  ok(await page.getByText('0 credits').first().isVisible(), 'header balance re-read after spending (0 credits)');
  ok(errors.length === 0, 'no console errors in the create flow', errors.join(' | '));
  await ctx.close();
}

// ───────────── C3. zero balance ─────────────
{
  const be = createBackend({ balance: 0 });
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/create');
  await page.getByText('You have 0 credits').waitFor();
  ok(await page.getByRole('button', { name: /Spend 1 credit/ }).isDisabled(), 'create button disabled at 0 credits');
  await ctx.close();
}

// ───────────── C4. dashboard render + XSS-safe feedback ─────────────
console.log('\n[C4] dashboard');
for (const [label, w] of [['desktop', 1280], ['mobile', 360]]) {
  const done = dashCampaign({ id: 'c1', status: 'completed', response_count: 1, completed_at: iso(Date.now()), project: { name: 'My SaaS', url: 'https://my-saas.example.com', description: null } });
  const waiting = dashCampaign({ id: 'c2' });
  const be = createBackend({
    balance: 2,
    dashCampaigns: [done, waiting],
    submissions: [{ id: 's9', campaign_id: 'c1', task_completed: false, friction: 'The pricing link was hidden in the footer.\n<img src=x onerror=alert(1)>', suggestion: 'Add pricing to the top navigation.', ux_rating: 3, share_consent: false, created_at: iso(Date.now()) }],
  });
  const { ctx, page, errors, dialogs } = await newPage(browser, w, 900);
  await be.install(ctx);
  await page.goto(ENV + '/dashboard');
  await page.getByText('Your test requests & results').waitFor();
  ok(await page.getByText('Could not complete the task').isVisible(), `[${label}] dashboard shows real feedback fields`);
  ok(await page.getByText('Private — tester did not allow public sharing').isVisible(), `[${label}] private feedback is labelled private`);
  ok(await page.getByText('No feedback yet.').isVisible(), `[${label}] pending campaign shows an honest empty state`);
  ok((await page.locator('img[src="x"]').count()) === 0 && dialogs.n === 0, `[${label}] HTML in feedback is rendered as text (no XSS)`);
  ok(!(await overflowX(page)), `[${label}] dashboard has no horizontal overflow`);
  await page.screenshot({ path: `${SHOTS}/C-dashboard-${label}.png`, fullPage: true });
  ok(errors.length === 0, `[${label}] no console errors`, errors.join(' | '));
  await ctx.close();
}

// ───────────── C5. mobile layout of the other screens ─────────────
{
  const be = createBackend({ balance: 1 });
  const { ctx, page } = await newPage(browser, 360, 800);
  await be.install(ctx);
  for (const path of ['/discover', '/create', `/test/${CAMP_ID}`]) {
    await page.goto(ENV + path);
    await page.waitForSelector('h1');
    await page.waitForTimeout(400);
    ok(!(await overflowX(page)), `[mobile] ${path.split('/')[1]} has no horizontal overflow`);
  }
  await ctx.close();
}

// ───────────── C6. session persists across reloads ─────────────
{
  const be = createBackend({ balance: 1 });
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Acme Invoicing').waitFor();
  await page.reload();
  await page.getByText('Acme Invoicing').waitFor();
  ok(be.s.signups === 1, `reload reuses the stored anonymous session (sign-ups: ${be.s.signups})`);
  await ctx.close();
}

await finish(browser)();
