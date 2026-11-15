// Phase 1 UI: reservations, minimum testing time, expiry, cancel/refund, daily cap — real Chrome,
// stubbed API (stateful fake in stub.mjs). Verifies what the user SEES and what the client SENDS.
import { CAMP_ID, DAY, HOST, SITE, createReadyBackend as createBackend, dashCampaign, feedRow, iso } from './stub.mjs';
import { SHOTS, launch, newPage, overflowX, reporter, waitUntil } from './lib.mjs';

const ENV = process.env.BASE_ENV;
const browser = await launch();
const { ok, finish } = reporter();
const submitBtn = (page) => page.getByRole('button', { name: /Submit feedback/ });

async function fillForm(page, friction = 'The export button was hard to find.') {
  await page.getByLabel('Yes, I completed it').check();
  await page.getByLabel('What was confusing or caused friction?').fill(friction);
  await page.getByLabel(/one improvement/).fill('Put export in the toolbar.');
  await page.getByLabel(/^4/).check({ force: true });
}

async function reserve(page) {
  await page.getByRole('button', { name: /Reserve task/ }).click();
  await page.getByText('Step 1 — open the website').waitFor();
}

// ───────────── reservation lapses mid-test: nothing lost, can re-reserve ─────────────
console.log('\n[L1] reservation lapses while typing');
{
  const be = createBackend({ holdMs: 5000, minMs: 1500 });
  const { ctx, page, errors } = await newPage(browser, 1280, 1000);
  await be.install(ctx);
  await page.goto(ENV + `/test/${CAMP_ID}`);
  await reserve(page);
  ok(await page.getByText('Reserved for you').isVisible(), 'live reservation banner with countdown is shown');
  await fillForm(page, 'My typed feedback must survive a lapse.');
  ok(await waitUntil(() => page.getByText('Your reservation ran out').isVisible(), 9000), 'banner appears when the reservation runs out');
  ok(await submitBtn(page).isDisabled(), 'submit is disabled once the reservation lapsed');
  ok((await page.getByLabel('What was confusing or caused friction?').inputValue()) === 'My typed feedback must survive a lapse.', 'typed answers are kept after the lapse');
  await page.screenshot({ path: `${SHOTS}/L1-lapsed.png`, fullPage: true });
  await page.getByRole('button', { name: 'Reserve again' }).click();
  ok(await waitUntil(() => page.getByText('Reserved for you').isVisible(), 5000), 're-reserving restores the live state');
  ok(be.called('start_test').length === 2, 'start_test called again for the renewal');
  ok(await waitUntil(() => submitBtn(page).isEnabled(), 3000), 'submit is enabled immediately after renewal (minimum time already served)');
  await submitBtn(page).click();
  await page.getByText('Feedback submitted — thank you!').waitFor();
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await ctx.close();
}

// ───────────── draft survives a reload ─────────────
console.log('\n[L2] draft restore');
{
  const be = createBackend({ minMs: 1000 });
  const { ctx, page } = await newPage(browser, 1280, 1000);
  await be.install(ctx);
  await page.goto(ENV + `/test/${CAMP_ID}`);
  await reserve(page);
  await fillForm(page, 'Draft text that must come back after reload.');
  await page.reload();
  await page.getByText('Step 1 — open the website').waitFor();
  ok((await page.getByLabel('What was confusing or caused friction?').inputValue()) === 'Draft text that must come back after reload.', 'friction text restored after a page reload');
  ok(await page.getByLabel('Yes, I completed it').isChecked(), 'radio answers restored too');
  ok(be.called('start_test').length === 1, 'reload did not re-reserve (reservation is idempotent server-side)');
  await ctx.close();
}

// ───────────── server-side rejections are shown, work is kept ─────────────
console.log('\n[L3] server errors on submit');
{
  const be = createBackend({ minMs: 800 });
  const { ctx, page } = await newPage(browser, 1280, 1000);
  await be.install(ctx);
  await page.goto(ENV + `/test/${CAMP_ID}`);
  await reserve(page);
  await fillForm(page, 'Feedback that must not be lost on errors.');
  await waitUntil(() => submitBtn(page).isEnabled(), 5000);

  be.s.forced.submit_test = { message: 'too_fast', details: '12' };
  await submitBtn(page).click();
  await page.getByText(/at least 60 seconds/).waitFor();
  ok(await page.getByText(/12 more seconds/).isVisible(), 'too_fast error shows the seconds left from the server');
  ok((await page.getByLabel('What was confusing or caused friction?').inputValue()).startsWith('Feedback that must not'), 'answers kept after too_fast');

  be.s.forced.submit_test = { message: 'daily_limit' };
  await submitBtn(page).click();
  await page.getByText(/limit of 5 rewarded tests/).waitFor();
  ok(true, 'daily_limit error is explained (5 per rolling 24 hours)');

  be.s.forced.submit_test = { message: 'campaign_closed' };
  await submitBtn(page).click();
  await page.getByText(/no longer open/).first().waitFor();
  ok(true, 'campaign_closed error is explained');
  ok((await page.getByLabel('What was confusing or caused friction?').inputValue()).startsWith('Feedback that must not'), 'answers still kept');
  ok((await page.evaluate((id) => sessionStorage.getItem('pp:draft:' + id), CAMP_ID)) === null, 'the saved draft is dropped once the task is gone (it could never be submitted)');

  // A retry after a LOST response (first submit succeeded server-side): must not claim "no credit earned".
  const profileReads = be.s.calls.filter((c) => c.p === '/rest/v1/profiles').length;
  be.s.forced.submit_test = { message: 'already_tested' };
  await page.getByLabel('What was confusing or caused friction?').fill('Retry after a lost response.');
  await submitBtn(page).click();
  await page.getByText(/already recorded and your credit was awarded/).waitFor();
  ok(!(await page.locator('body').innerText()).includes('No credit was spent or earned'), 'already_tested never says "no credit earned"');
  ok(await waitUntil(() => be.s.calls.filter((c) => c.p === '/rest/v1/profiles').length > profileReads, 3000), 'balance is re-read from the server after already_tested');
  await ctx.close();
}

// ───────────── reserve-time errors and other task states ─────────────
console.log('\n[L4] reserve errors + unavailable states');
{
  const be = createBackend();
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + `/test/${CAMP_ID}`);
  be.s.forced.start_test = { message: 'reservation_exists', details: 'other-campaign' };
  await page.getByRole('button', { name: /Reserve task/ }).click();
  await page.getByText(/already have a test in progress/).waitFor();
  ok((await page.locator('body').innerText()).includes('acme-invoices') === false, 'website still hidden after a failed reservation');
  be.s.forced.start_test = { message: 'daily_limit' };
  await page.getByRole('button', { name: /Reserve task/ }).click();
  await page.getByText(/limit of 5 rewarded tests/).waitFor();
  ok(true, 'daily limit shown when trying to reserve');
  await ctx.close();
}
{
  const be = createBackend({ pages: { [CAMP_ID]: { available: true, reservedByOther: true } } });
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + `/test/${CAMP_ID}`);
  await page.getByText('Someone else is testing this task right now').waitFor();
  ok((await page.locator('body').innerText()).includes('acme-invoices') === false, 'other tester’s task: no website URL shown');
  ok((await page.getByRole('button', { name: /Reserve task/ }).count()) === 0, 'no reserve button while someone else holds it');
  await ctx.close();
}
{
  const be = createBackend({ pages: { [CAMP_ID]: { available: false } } });
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + `/test/${CAMP_ID}`);
  await page.getByText('This task isn’t available').waitFor();
  ok(await page.getByText(/cancelled or expired/).isVisible(), 'expired/cancelled/unavailable task shows an honest empty state');
  await ctx.close();
}

// ───────────── Discover: quota, expiry, settlement, resilience ─────────────
console.log('\n[L5] Discover');
{
  const second = '44444444-4444-4444-4444-444444444444';
  const be = createBackend({
    feed: [feedRow(), feedRow({ campaign_id: second, project_name: 'Mine In Progress', reserved_by_me: true, reservation_expires_at: iso(Date.now() + 9 * 60e3) })],
    status: { rewards_24h: 2, daily_limit: 5, next_reward_slot_at: null, active_reservation: null },
  });
  be.s.settled = 1;
  const { ctx, page, errors } = await newPage(browser, 1280, 900);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Acme Invoicing').waitFor();
  const order = be.s.calls.map((c) => c.p.split('/').pop());
  ok(order.indexOf('settle_expired_campaigns') !== -1 && order.indexOf('settle_expired_campaigns') < order.indexOf('list_campaigns_v2'), 'expired campaigns are settled BEFORE the feed is read');
  ok(await waitUntil(() => be.s.calls.some((c, i) => c.p === '/rest/v1/profiles' && i > order.indexOf('settle_expired_campaigns')), 3000), 'balance re-read after a settlement refunded something');
  ok(await page.getByText(/Rewarded tests in the last 24 h/).isVisible() && (await page.locator('strong', { hasText: /^2$/ }).count()) >= 1, 'quota line shows 2 of 5');
  ok(await page.getByText(/days left/).first().isVisible(), 'cards show how long the task stays open');
  ok(await page.getByText('In progress — yours').isVisible() && (await page.getByRole('link', { name: 'Continue test' }).count()) === 1, 'my own in-progress reservation is highlighted with a Continue button');
  ok(!(await page.locator('body').innerText()).match(/log ?in|sign ?in|password/i), 'no login wall wording');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await ctx.close();
}
{
  const second = '44444444-4444-4444-4444-444444444444';
  const be = createBackend({
    feed: [feedRow(), feedRow({ campaign_id: second, project_name: 'Mine In Progress', reserved_by_me: true, reservation_expires_at: iso(Date.now() + 9 * 60e3) })],
    status: { rewards_24h: 5, daily_limit: 5, next_reward_slot_at: iso(Date.now() + 3 * 3600e3 + 60e3), active_reservation: null },
  });
  const { ctx, page } = await newPage(browser, 360, 900);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText(/Daily reward limit reached \(5\/5\)/).waitFor();
  ok(await page.getByText(/next slot opens in 3 h/i).isVisible(), 'cap banner says when the next slot opens');
  ok((await page.getByRole('button', { name: 'Limit reached' }).count()) === 1, 'new tasks are disabled at the cap');
  ok((await page.getByRole('link', { name: 'Continue test' }).count()) === 1, 'but a task already in progress can still be continued');
  ok(!(await overflowX(page)), '[mobile] capped Discover has no horizontal overflow');
  await page.screenshot({ path: `${SHOTS}/L5-capped-mobile.png`, fullPage: true });
  await ctx.close();
}
{
  const be = createBackend();
  be.s.forced.settle_expired_campaigns = { message: 'boom', sticky: true };
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Acme Invoicing').waitFor();
  ok(true, 'a failing settlement call never blocks the feed');
  await ctx.close();
}
{
  const be = createBackend({ feed: [] });
  const { ctx, page } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('No open tasks right now').waitFor();
  ok(await page.getByText(/expired tasks and ones someone else is testing right now are never shown/).isVisible(), 'empty state honestly explains what is hidden');
  await ctx.close();
}

// ───────────── Dashboard: statuses, cancel, refund ─────────────
console.log('\n[L6] Dashboard lifecycle');
for (const [label, w] of [['desktop', 1280], ['mobile', 360]]) {
  const waiting = dashCampaign({ id: 'w1', task_description: 'WAITING task: sign up and export data as CSV.' });
  const busy = dashCampaign({ id: 'b1', task_description: 'BUSY task: someone is testing this one now.' });
  const pending = dashCampaign({ id: 'p1', task_description: 'PENDING task: past its deadline, refund not yet settled.', created_at: iso(Date.now() - 8 * DAY), expires_at: iso(Date.now() - DAY) });
  const expired = dashCampaign({ id: 'e1', status: 'expired', closed_at: iso(Date.now() - 1e6), task_description: 'EXPIRED task that was refunded.', created_at: iso(Date.now() - 9 * DAY), expires_at: iso(Date.now() - 2 * DAY) });
  const cancelled = dashCampaign({ id: 'x1', status: 'cancelled', closed_at: iso(Date.now() - 1e6), task_description: 'CANCELLED task that was refunded.' });
  const done = dashCampaign({ id: 'd1', status: 'completed', response_count: 1, completed_at: iso(Date.now()), task_description: 'DONE task with feedback.' });
  const be = createBackend({
    balance: 1,
    dashCampaigns: [waiting, busy, pending, expired, cancelled, done],
    dashReservations: [{ campaign_id: 'b1', expires_at: iso(Date.now() + 10 * 60e3), consumed_at: null }],
    submissions: [{ id: 's1', campaign_id: 'd1', task_completed: true, friction: 'Friction text for the done campaign.', suggestion: 'Suggestion text for the done campaign.', ux_rating: 5, share_consent: true, created_at: iso(Date.now()) }],
  });
  const { ctx, page, errors } = await newPage(browser, w, 1000);
  await be.install(ctx);
  await page.goto(ENV + '/dashboard');
  await page.getByText('Your test requests & results').waitFor();
  const text = await page.locator('body').innerText();
  ok(be.s.calls.findIndex((c) => c.p.endsWith('settle_expired_campaigns')) < be.s.calls.findIndex((c) => c.p === '/rest/v1/campaigns'), `[${label}] dashboard settles expired campaigns before loading them`);
  ok(text.includes('Waiting for a tester'), `[${label}] waiting campaign status`);
  ok(text.includes('A tester is working on this'), `[${label}] campaign being tested is flagged`);
  ok(text.includes('Expired — refund pending'), `[${label}] overdue campaign shows refund pending`);
  ok(text.includes('Expired — credit refunded') && text.includes('Cancelled — credit refunded') && text.includes('Tested'), `[${label}] expired / cancelled / tested statuses`);
  ok(text.includes('Friction text for the done campaign.'), `[${label}] existing feedback is still shown on completed campaigns`);
  ok((await page.getByRole('button', { name: 'Cancel & refund' }).count()) === 2, `[${label}] Cancel is offered only for waiting + overdue campaigns (not busy/closed/completed)`);
  ok(text.includes('can’t be cancelled until their reservation ends'), `[${label}] busy campaign explains why it cannot be cancelled`);
  ok(/refunded if nobody tests it in 7 days/.test(text), `[${label}] waiting campaign states the refund rule`);

  // Keep it → nothing sent
  const waitingCard = page.locator('li', { hasText: 'WAITING task' });
  await waitingCard.getByRole('button', { name: 'Cancel & refund' }).click();
  await page.getByText('Cancel this request and get your 1 credit back?').waitFor();
  if (label === 'mobile') {
    ok(!(await overflowX(page)), '[mobile] dashboard with the confirm prompt has no horizontal overflow');
    await page.screenshot({ path: `${SHOTS}/L6-confirm-mobile.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Keep it' }).click();
  ok(be.called('cancel_campaign').length === 0, `[${label}] "Keep it" sends nothing`);

  // Server refuses (a tester just reserved it)
  be.s.forced.cancel_campaign = { message: 'campaign_reserved' };
  await waitingCard.getByRole('button', { name: 'Cancel & refund' }).click();
  await waitingCard.getByRole('button', { name: 'Yes, cancel & refund' }).click();
  await page.getByText(/Another tester is working on this task/).waitFor();
  ok(true, `[${label}] cancel refused by the server → clear message`);
  ok(be.s.balance === 1, `[${label}] no refund on a refused cancel`);

  // Real cancel
  // (the confirm prompt stays open after a refused cancel, so confirm again)
  await waitingCard.getByRole('button', { name: 'Yes, cancel & refund' }).click();
  ok(await waitUntil(() => page.getByText('2 credits').first().isVisible(), 5000), `[${label}] header balance shows the refund (2 credits)`);
  const cc = be.called('cancel_campaign').at(-1);
  ok(JSON.stringify(cc.body) === JSON.stringify({ p_campaign_id: 'w1' }), `[${label}] cancel payload matches the SQL parameter name`);
  ok(await waitUntil(async () => (await page.getByText('Cancelled — credit refunded').count()) === 2, 5000), `[${label}] cancelled campaign now shows as refunded`);
  ok(await page.getByText('Refunded — request cancelled or expired with no feedback').isVisible(), `[${label}] credit history lists the refund`);
  ok(!(await overflowX(page)), `[${label}] dashboard has no horizontal overflow`);
  await page.screenshot({ path: `${SHOTS}/L6-dashboard-${label}.png`, fullPage: true });
  const nonForced = errors.filter((e) => !/400|Failed to load resource/.test(e));
  ok(nonForced.length === 0, `[${label}] no unexpected console errors`, nonForced.join(' | '));
  await ctx.close();
}

// ───────────── mobile layout of the reserved test page ─────────────
console.log('\n[L7] mobile test page');
{
  const be = createBackend({ minMs: 60e3 });
  const { ctx, page } = await newPage(browser, 360, 900);
  await be.install(ctx);
  await page.goto(ENV + `/test/${CAMP_ID}`);
  ok(!(await overflowX(page)), '[mobile] reserve panel has no horizontal overflow');
  await reserve(page);
  ok(!(await overflowX(page)), '[mobile] reserved page (timers + form) has no horizontal overflow');
  await page.screenshot({ path: `${SHOTS}/L7-reserved-mobile.png`, fullPage: true });
  ok(HOST.startsWith('https://') && SITE.startsWith('https://'), 'test fixtures are https');
  await ctx.close();
}

await finish(browser)();
