// Matching v2 UI in real Chrome against the stubbed API: Open vs Targeted testing on "Request a test", the three Discover
// states (Recommended / Eligible / Not eligible), the explanation on a task page, the self-reported screening, a backend
// that predates migration 7, mobile layout. The RULES are enforced and tested in Postgres (supabase/tests/matching_v2.mjs);
// the stub mirrors them so the UI is exercised on realistic data.
import { createBackend, dashCampaign, feedRow, iso, CAMP_ID } from './stub.mjs';
import { SHOTS, launch, newPage, overflowX, reporter, waitUntil } from './lib.mjs';

const ENV = process.env.BASE_ENV;
const browser = await launch();
const { ok, finish } = reporter();
const bodyText = (page) => page.locator('body').innerText();
const titles = (page) => page.locator('ul > li h2').allInnerTexts();
const mins = (m) => iso(Date.now() - m * 60e3);
const ID = (n) => `${n}0000000-0000-0000-0000-00000000000${n}`;
const tester = (cats) => ({ nickname: 'Tess', bio: 'hello', categories: cats, updated_at: iso(Date.now()) });

const row = (n, name, mode, cats, ageMin, extra = {}) =>
  feedRow({ campaign_id: ID(n), project_name: name, created_at: mins(ageMin), testing_mode: mode, target_categories: cats, ...extra });
const feed = () => [
  row(1, 'Alpha open plain', 'open', [], 60),
  row(2, 'Beta open prefers students', 'open', ['students_learners'], 50),
  row(3, 'Gamma targeted students', 'targeted', ['students_learners'], 40),
  row(4, 'Delta targeted tech', 'targeted', ['tech_savvy'], 30),
  row(5, 'Epsilon targeted tech+students', 'targeted', ['tech_savvy', 'students_learners'], 20),
  row(6, 'Zeta open prefers tech', 'open', ['tech_savvy'], 10),
];
const pagesFor = (rows) => Object.fromEntries(rows.map((r) => [r.campaign_id, { available: true, reservedByOther: false }]));
const card = (page, name) => page.locator('ul > li', { hasText: name });

async function fillBasics(page) {
  await page.getByLabel('Project name').fill('Acme Invoicing');
  await page.getByLabel('Website URL').fill('https://acme.example.com');
  await page.getByLabel('The task (2–3 minutes)').fill('Create an invoice for a client and download it as a PDF file.');
}

// ───────────── Request a test: Open vs Targeted ─────────────
console.log('\n[V1] Request a test: Open vs Targeted testing');
{
  const be = createBackend({ balance: 3 });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/create');
  await page.getByLabel('Project name').waitFor();
  const picker = page.getByTestId('mode-picker');
  ok(await picker.isVisible() && /Open testing/.test(await picker.innerText()) && /Targeted testing/.test(await picker.innerText()), 'the page offers two explicit modes: Open testing and Targeted testing');
  const pt = await picker.innerText();
  ok(/Any eligible tester can take it/.test(pt) && /nobody is excluded/.test(pt), 'open mode is explained: any tester, nobody excluded');
  ok(/Only testers who match at least one category/.test(pt) && /server enforces/.test(pt) && /assessment of their self-reported written experience/.test(pt) && /may take longer/.test(pt), 'targeted mode is explained: only matching testers, enforced by the server, professional categories are assessed from self-reported answers, may take longer');
  ok(await page.getByTestId('mode-open').locator('input').isChecked() && !(await page.getByTestId('mode-targeted').locator('input').isChecked()), 'Open testing is the default (existing behaviour)');
  ok(await page.getByRole('group', { name: 'Recommend it to (optional)' }).isVisible(), 'open mode: categories are an optional recommendation');
  await page.getByTestId('mode-targeted').locator('input').check();
  ok(await page.getByRole('group', { name: 'Required tester categories (choose at least one)' }).isVisible(), 'targeted mode: categories become REQUIRED');
  const hint = await bodyText(page);
  ok(/at least one/.test(hint) && /not a verified credential/.test(hint) && /become active once their answers are saved/.test(hint) && /credit is refunded/.test(hint), 'the targeted hint explains eligibility, that the assessment is of self-reported answers / not a verified credential, which categories are active once answered, and the refund');
  // targeted without categories is stopped on the page and nothing is sent
  await fillBasics(page);
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await page.getByTestId('categories-error').waitFor();
  ok(/at least one tester category/.test(await page.getByTestId('categories-error').innerText()) && be.s.created.length === 0 && be.s.balance === 3, 'targeted with no category: an error on the page, nothing sent, nothing spent');
  // categories survive a mode switch
  await page.getByTestId('target-business_office').locator('input').check();
  await page.getByTestId('mode-open').locator('input').check();
  ok(await page.getByTestId('target-business_office').locator('input').isChecked(), 'switching mode keeps the selected categories');
  await page.getByTestId('mode-targeted').locator('input').check();
  await page.getByTestId('target-tech_savvy').locator('input').check();
  await page.getByTestId('target-students_learners').locator('input').check();
  await page.screenshot({ path: `${SHOTS}/v2-create-1280.png`, fullPage: true });
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await page.waitForURL('**/dashboard');
  const used = be.s.created[0];
  ok(used.rpc === 'create_campaign_v2' && used.body.p_mode === 'targeted' && JSON.stringify(used.body.p_categories) === JSON.stringify(['tech_savvy', 'business_office', 'students_learners']), 'targeted: create_campaign_v2 with mode "targeted" and the REQUIRED categories (canonical order)', JSON.stringify(used));
  ok(used.body.p_task.startsWith('Create an invoice') && be.s.balance === 2, 'rest of the payload unchanged; exactly one credit spent');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();

  // open + preferred categories = the Matching-v1 RPC (so those campaigns stay OPEN); open + none = the original RPC
  const be2 = createBackend({ balance: 3 });
  const c2 = await newPage(browser, 1280);
  await be2.install(c2.ctx);
  await c2.page.goto(ENV + '/create');
  await c2.page.getByLabel('Project name').waitFor();
  await fillBasics(c2.page);
  await c2.page.getByTestId('target-tech_savvy').locator('input').check();
  await c2.page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await c2.page.waitForURL('**/dashboard');
  const u2 = be2.s.created[0];
  ok(u2.rpc === 'create_targeted_campaign' && !('p_mode' in u2.body) && JSON.stringify(u2.body.p_target_categories) === '["tech_savvy"]', 'open + preferred categories: the Matching-v1 RPC (a PREFERENCE only, never a restriction)', JSON.stringify(u2));
  await c2.ctx.close();
  const be3 = createBackend({ balance: 3 });
  const c3 = await newPage(browser, 1280);
  await be3.install(c3.ctx);
  await c3.page.goto(ENV + '/create');
  await c3.page.getByLabel('Project name').waitFor();
  await fillBasics(c3.page);
  await c3.page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await c3.page.waitForURL('**/dashboard');
  ok(be3.s.created[0].rpc === 'create_project_with_campaign' && !('p_target_categories' in be3.s.created[0].body) && !('p_mode' in be3.s.created[0].body), 'open + nothing selected: the ORIGINAL RPC and payload, byte for byte');
  await c3.ctx.close();

  // backend without migration 7
  const be4 = createBackend({ balance: 3, v2: false });
  const c4 = await newPage(browser, 1280);
  await be4.install(c4.ctx);
  await c4.page.goto(ENV + '/create');
  await c4.page.getByLabel('Project name').waitFor();
  await fillBasics(c4.page);
  await c4.page.getByTestId('mode-targeted').locator('input').check();
  await c4.page.getByTestId('target-tech_savvy').locator('input').check();
  await c4.page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await c4.page.getByText('Targeted Tester Matching is not available on this server yet.', { exact: false }).waitFor();
  ok(be4.s.balance === 3 && c4.page.url().endsWith('/create'), 'a backend without targeted testing: one clear message, stays on the form, nothing spent');
  await c4.ctx.close();

  // server rejection surfaces
  const be5 = createBackend({ balance: 3 });
  be5.s.forced.create_campaign_v2 = { message: 'targeted_requires_categories' };
  const c5 = await newPage(browser, 1280);
  await be5.install(c5.ctx);
  await c5.page.goto(ENV + '/create');
  await c5.page.getByLabel('Project name').waitFor();
  await fillBasics(c5.page);
  await c5.page.getByTestId('mode-targeted').locator('input').check();
  await c5.page.getByTestId('target-tech_savvy').locator('input').check();
  await c5.page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await c5.page.getByText('Targeted testing needs at least one tester category', { exact: false }).waitFor();
  ok(be5.s.balance === 3, 'a server-side rejection is shown in plain language and spends nothing');
  await c5.ctx.close();
}

// ───────────── Discover: Recommended / Eligible / Not eligible ─────────────
console.log('\n[V2] Discover: matches, eligible, not available');
{
  const rows = feed();
  const be = createBackend({ feed: rows, pages: pagesFor(rows), tester: tester(['students_learners']) });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Beta open prefers students').waitFor();
  await page.getByTestId('not-available').evaluate((el) => { el.open = true; });
  const order = await titles(page);
  ok(JSON.stringify(order) === JSON.stringify(['Beta open prefers students', 'Gamma targeted students', 'Epsilon targeted tech+students', 'Alpha open plain', 'Zeta open prefers tech', 'Delta targeted tech']), 'order: matches, then eligible, then not available (the server decides)', JSON.stringify(order));
  ok((await page.getByTestId('match-badge').count()) === 3, 'three tasks "Match your profile"');
  ok((await page.getByTestId('eligible-badge').count()) === 2, 'two are plainly Eligible (open tasks without overlap)');
  ok((await page.getByTestId('not-eligible-badge').count()) === 1 && /Not eligible: your profile does not match/.test(await page.getByTestId('not-eligible-badge').innerText()), 'one is Not eligible, with the reason on the badge');
  ok((await page.getByTestId('mode-badge').count()) === 6 && (await page.locator('[data-mode=targeted]').count()) === 3, 'every card says Open testing or Targeted testing');
  ok((await page.getByTestId('eligible-list').locator(':scope > li').count()) === 5 && (await page.getByTestId('not-available').locator(':scope > ul > li').count()) === 1, 'five actionable tasks in "Browse all eligible tests", the sixth under "Not available to you yet"');
  const d = card(page, 'Delta targeted tech');
  ok((await d.getAttribute('data-fit')) === 'not_eligible', 'the not-eligible task is still LISTED (a tester may view it)');
  ok(/Why not: your tester profile does not include any of these categories/.test(await d.getByTestId('why-not').innerText()), 'and explains why');
  ok((await d.getByRole('link', { name: 'Start test' }).count()) === 0 && (await d.getByRole('link', { name: 'See requirements' }).getAttribute('href')) === `/test/${ID(4)}`, 'no Start button on it: "See requirements" opens the task page instead');
  ok(/Required testers \(at least one\)/i.test(await d.getByTestId('looking-for').innerText()), 'a targeted card says its categories are REQUIRED');
  ok(/Looking for testers like/i.test(await card(page, 'Beta open prefers students').getByTestId('looking-for').innerText()), 'an open card says its categories are a preference ("looking for testers like")');
  ok((await card(page, 'Alpha open plain').getByRole('link', { name: 'Start test' }).count()) === 1 && (await card(page, 'Gamma targeted students').getByRole('link', { name: 'Start test' }).count()) === 1, 'eligible tasks (open or targeted) have a Start button');
  ok(/1 task is not available to you yet/.test(await page.getByTestId('not-eligible-note').innerText()) && /Open testing/.test(await page.getByTestId('modes-legend').innerText()), 'a legend explains open vs targeted and counts the unavailable tasks');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await page.screenshot({ path: `${SHOTS}/v2-discover-1280.png`, fullPage: true });
  // the not-eligible card leads to the explanation
  await d.getByRole('link', { name: 'See requirements' }).click();
  await page.getByTestId('eligibility-panel').waitFor();
  ok(/Your tester profile does not match this task/.test(await page.getByTestId('eligibility-panel').innerText()), 'the task page explains the mismatch');
  await ctx.close();

  // tech-savvy with the four answers but NOT assessed: pending assessment
  const be2 = createBackend({ feed: feed(), pages: pagesFor(rows), tester: tester(['tech_savvy']) });
  const c2 = await newPage(browser, 1280);
  await be2.install(c2.ctx);
  await c2.page.goto(ENV + '/discover');
  await c2.page.getByText('Delta targeted tech').waitFor({ state: 'attached' });
  await c2.page.getByTestId('not-available').evaluate((el) => { el.open = true; });
  const dd = card(c2.page, 'Delta targeted tech');
  ok(/Not eligible: qualification required/.test(await dd.getByTestId('not-eligible-badge').innerText()) && /Tech-Savvy Users is not active yet/.test(await dd.getByTestId('why-not').innerText()), 'a tech_savvy tester WITHOUT an assessment: not eligible for the tech task, and the category is named');
  ok((await c2.page.getByTestId('not-eligible-badge').count()) === 3 && (await dd.getByRole('link', { name: 'Start test' }).count()) === 0, 'and for every task that needs the assessment (Delta, Epsilon) or another category (Gamma)');
  ok((await card(c2.page, 'Zeta open prefers tech').getByTestId('match-badge').count()) === 0 && (await card(c2.page, 'Zeta open prefers tech').getByRole('link', { name: 'Start test' }).count()) === 1, 'the OPEN task that prefers Tech-Savvy is startable but is not "matched" through a pending category');
  await c2.ctx.close();
  // assessed
  const be3 = createBackend({ feed: feed(), pages: pagesFor(rows), tester: tester(['tech_savvy']), screened: ['tech_savvy'] });
  const c3 = await newPage(browser, 1280);
  await be3.install(c3.ctx);
  await c3.page.goto(ENV + '/discover');
  await c3.page.getByText('Delta targeted tech').waitFor({ state: 'attached' });
  await c3.page.getByTestId('not-available').evaluate((el) => { el.open = true; });
  ok(JSON.stringify(await titles(c3.page)) === JSON.stringify(['Delta targeted tech', 'Epsilon targeted tech+students', 'Zeta open prefers tech', 'Alpha open plain', 'Beta open prefers students', 'Gamma targeted students']), 'after the assessment the tech tasks match and rise to the top; the students-only task is last (not available)', JSON.stringify(await titles(c3.page)));
  await c3.ctx.close();
  // no profile
  const be4 = createBackend({ feed: feed(), pages: pagesFor(rows) });
  const c4 = await newPage(browser, 1280);
  await be4.install(c4.ctx);
  await c4.page.goto(ENV + '/discover');
  await c4.page.getByTestId('profile-needed').waitFor();
  ok((await c4.page.getByTestId('match-badge').count()) === 0 && (await c4.page.locator('[data-fit=not_eligible]').count()) === 6, 'no profile: nothing matches and every task (open ones included) waits for a completed profile');
  ok(/complete your profile first/.test(await c4.page.getByTestId('not-eligible-badge').first().innerText()), 'reason: complete your profile first');
  await c4.ctx.close();
}

// ───────────── the task page: explanation instead of Reserve ─────────────
console.log('\n[V3] Task page: why a tester cannot start, and what to do');
{
  const rows = [row(4, 'Delta targeted tech', 'targeted', ['tech_savvy'], 30), row(1, 'Alpha open plain', 'open', [], 60)];
  const variants = [
    ['no profile', {}, /Complete your tester profile first/, 'edit-profile'],
    ['category mismatch', { tester: tester(['students_learners']) }, /does not include any of these categories/, 'edit-profile'],
    ['screening required', { tester: tester(['tech_savvy']) }, /Qualification required/, 'answer-questions'],
  ];
  for (const [label, opts, re, cta] of variants) {
    const be = createBackend({ feed: rows, pages: pagesFor(rows), ...opts });
    const { ctx, page, errors } = await newPage(browser, 1280);
    await be.install(ctx);
    await page.goto(ENV + `/test/${ID(4)}`);
    await page.getByTestId('eligibility-panel').waitFor();
    const pt = await page.getByTestId('eligibility-panel').innerText();
    ok(re.test(pt) || re.test(await bodyText(page)), `[${label}] the panel explains the reason`, pt.slice(0, 160));
    ok(/Required \(at least one\)/i.test(pt) && /Tech-Savvy Users/i.test(pt), `[${label}] it lists the required categories`);
    ok((await page.getByRole('button', { name: /Reserve task/ }).count()) === 0, `[${label}] there is no Reserve button`);
    ok((await page.getByTestId(cta).count()) === 1, `[${label}] the call to action is ${cta}`);
    ok(await page.getByTestId('targeted-info').isVisible() && /Targeted testing/.test(await page.getByTestId('targeted-info').innerText()), `[${label}] the page labels the task as targeted and shows who it is for`);
    ok(/only open to eligible testers/.test(await bodyText(page)), `[${label}] the feedback column says it is only open to eligible testers`);
    if (label === 'screening required') {
      ok((await page.getByTestId('answer-questions').getAttribute('href')) === '/profile?answers=tech_savvy', 'the link deep-links to the questions of the right category');
      ok(/self-reported/.test(pt) && /not a verified credential/.test(pt), 'and says the screening is self-reported, not a verified credential');
    }
    ok(be.called('start_test').length === 0, `[${label}] nothing was sent to start_test`);
    ok(errors.length === 0, `[${label}] no console errors`, errors.join('|'));
    if (label === 'screening required') await page.screenshot({ path: `${SHOTS}/v2-ineligible-1280.png`, fullPage: true });
    await ctx.close();
  }

  // open tasks are untouched
  // a tester WITHOUT a completed profile cannot reserve even an open task: the page explains it
  const beN = createBackend({ feed: rows, pages: pagesFor(rows) });
  const nn = await newPage(browser, 1280);
  await beN.install(nn.ctx);
  await nn.page.goto(ENV + `/test/${ID(1)}`);
  await nn.page.getByTestId('eligibility-panel').waitFor();
  ok(/Complete your tester profile first/.test(await nn.page.getByTestId('eligibility-panel').innerText()) && (await nn.page.getByRole('button', { name: /Reserve task/ }).count()) === 0 && (await nn.page.getByTestId('edit-profile').getAttribute('href')) === '/profile', 'an OPEN task for a tester without a completed profile: panel, link to the profile, no Reserve button');
  await nn.ctx.close();
  const beO = createBackend({ feed: rows, pages: pagesFor(rows), tester: tester(['students_learners']) });
  const o = await newPage(browser, 1280);
  await beO.install(o.ctx);
  await o.page.goto(ENV + `/test/${ID(1)}`);
  await o.page.getByRole('button', { name: /Reserve task/ }).waitFor();
  ok((await o.page.getByTestId('eligibility-panel').count()) === 0 && (await o.page.getByTestId('targeted-info').count()) === 0, 'an OPEN task page has no eligibility panel and no targeted label');
  await o.ctx.close();

  // eligible: reserve works
  const beE = createBackend({ feed: rows, pages: pagesFor(rows), tester: tester(['tech_savvy']), screened: ['tech_savvy'] });
  const e = await newPage(browser, 1280);
  await beE.install(e.ctx);
  await e.page.goto(ENV + `/test/${ID(4)}`);
  await e.page.getByTestId('eligible-note').waitFor();
  ok(/You’re eligible/.test(await e.page.getByTestId('eligible-note').innerText()) && (await e.page.getByTestId('eligibility-panel').count()) === 0, 'an eligible tester sees "You’re eligible" and no blocking panel');
  await e.page.getByRole('button', { name: /Reserve task/ }).click();
  await e.page.getByText('Step 1 — open the website').waitFor();
  ok(beE.called('start_test').length === 1, 'and can reserve it');
  await e.ctx.close();

  // the SERVER refuses even if the page thought it was fine (stale page): the real reason is shown, nothing is spent
  const beS = createBackend({ feed: rows, pages: pagesFor(rows), tester: tester(['tech_savvy']), screened: ['tech_savvy'] });
  const s = await newPage(browser, 1280);
  await beS.install(s.ctx);
  await s.page.goto(ENV + `/test/${ID(4)}`);
  await s.page.getByRole('button', { name: /Reserve task/ }).waitFor();
  beS.s.forced.start_test = { message: 'not_eligible', details: 'qualification_required' };
  beS.s.qualified.delete('tech_savvy'); // the assessment decision became stale meanwhile (e.g. the answers were edited)
  await s.page.getByRole('button', { name: /Reserve task/ }).click();
  await s.page.getByTestId('eligibility-panel').waitFor();
  ok((await s.page.getByTestId('answer-questions').count()) === 1 && beS.s.balance === 1, 'a stale page: the server refuses, the panel appears with the real reason, credits untouched');
  await s.ctx.close();

  // in-progress test is never interrupted by a profile edit
  const rowsIP = [row(4, 'Delta targeted tech', 'targeted', ['tech_savvy'], 30)];
  const beP = createBackend({ feed: rowsIP, pages: pagesFor(rowsIP), tester: tester(['students_learners']) });
  beP.s.reservation = { campaign_id: ID(4), firstAt: Date.now() - 90e3, startedAt: Date.now() - 90e3, expiresAt: Date.now() + 10 * 60e3 };
  const p = await newPage(browser, 1280);
  await beP.install(p.ctx);
  await p.page.goto(ENV + `/test/${ID(4)}`);
  await p.page.getByText('Step 1 — open the website').waitFor();
  ok((await p.page.getByTestId('eligibility-panel').count()) === 0 && /Your reservation is in progress/.test(await p.page.getByTestId('eligible-note').innerText()), 'with a LIVE reservation the page keeps working even though the profile no longer matches (in-progress test protected)');
  ok(await p.page.getByRole('button', { name: /Submit feedback/ }).isVisible(), 'and the feedback form is there');
  await p.ctx.close();
}

// ───────────── dashboard ─────────────
console.log('\n[V5] Dashboard shows the mode of my requests');
{
  const be = createBackend({
    dashCampaigns: [
      dashCampaign({ id: 'cT', project: { name: 'Targeted app', url: 'https://t.example.com', description: null }, testing_mode: 'targeted', target_categories: ['tech_savvy'] }),
      dashCampaign({ id: 'cO', project: { name: 'Open app', url: 'https://o.example.com', description: null }, testing_mode: 'open', target_categories: ['students_learners'] }),
      dashCampaign({ id: 'cL', project: { name: 'Legacy app', url: 'https://l.example.com', description: null } }),
    ],
  });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/dashboard');
  await page.getByText('Targeted app').waitFor();
  const t = await page.locator('li', { hasText: 'Targeted app' }).getByTestId('dash-targets').innerText();
  ok(/Required testers \(at least one\)/i.test(t) && /Targeted testing/i.test(t) && /Tech-Savvy Users/i.test(t), 'a targeted request shows "Required testers" and its mode');
  const o = await page.locator('li', { hasText: 'Open app' }).getByTestId('dash-targets').innerText();
  ok(/Preferred testers/i.test(o) && /Open testing/i.test(o) && !/Required/i.test(o), 'an open request with categories shows "Preferred testers" (a recommendation, not a restriction)');
  ok((await page.locator('li', { hasText: 'Legacy app' }).getByTestId('dash-targets').count()) === 0, 'a legacy request renders as before');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── backend without migration 7 ─────────────
console.log('\n[V6] UI deployed before migration 7: everything still works');
{
  const rows = feed().map((r) => ({ ...r, testing_mode: undefined }));
  const be = createBackend({ v2: false, feed: rows, pages: pagesFor(rows), tester: tester(['students_learners']) });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Beta open prefers students').waitFor();
  ok((await page.getByTestId('mode-badge').count()) === 0 && (await page.getByTestId('modes-legend').count()) === 0 && (await page.getByTestId('not-eligible-badge').count()) === 0, 'Discover falls back to the Matching-v1 feed: no mode badges, no legend, nothing "not eligible"');
  ok((await page.getByTestId('match-badge').count()) > 0 && be.called('list_matched_campaigns').length === 1, 'the v1 matching still works');
  await page.goto(ENV + `/test/${ID(1)}`);
  await page.getByRole('button', { name: /Reserve task/ }).waitFor();
  ok((await page.getByTestId('eligibility-panel').count()) === 0, 'a task page has no eligibility UI');
  await page.goto(ENV + '/profile');
  await page.getByTestId('profile-form').waitFor();
  ok((await page.getByTestId('experience-section').count()) === 0 && (await page.getByTestId('ai-consent').count()) === 0, 'the profile page has no experience section and no consent card (the server cannot store them yet)');
  ok(errors.filter((e) => !/404|400/.test(e)).length === 0, 'no unexpected console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── mobile ─────────────
console.log('\n[V7] mobile (360 px)');
{
  const rows = feed();
  const be = createBackend({ feed: rows, pages: pagesFor(rows), tester: tester(['tech_savvy']), balance: 2 });
  const { ctx, page, errors } = await newPage(browser, 360, 800);
  await be.install(ctx);
  const stops = [
    ['/create', async () => { await page.getByLabel('Project name').waitFor(); await page.getByTestId('mode-targeted').locator('input').check(); }, 'create'],
    ['/discover', async () => { await page.getByTestId('modes-legend').waitFor(); }, 'discover'],
    [`/test/${ID(4)}`, async () => { await page.getByTestId('eligibility-panel').waitFor(); }, 'ineligible'],
    ['/profile?answers=tech_savvy', async () => { await page.getByTestId('experience-tech_savvy').getByTestId('answer-q1').waitFor(); }, 'experience'],
    ['/', async () => { await page.getByTestId('matching-section').waitFor(); }, 'landing'],
  ];
  for (const [path, wait, shot] of stops) {
    await page.goto(ENV + path);
    await wait();
    ok(!(await overflowX(page)), `[360px] ${path}: no horizontal overflow`);
    await page.screenshot({ path: `${SHOTS}/v2-${shot}-360.png`, fullPage: true });
  }
  await page.goto(ENV + '/profile?answers=tech_savvy');
  await page.getByTestId('experience-tech_savvy').getByTestId('answer-q1').waitFor();
  const first = await page.getByTestId('experience-tech_savvy').getByTestId('answer-q1').boundingBox();
  ok(first && first.height >= 36, `[360px] answer boxes are comfortable tap targets (${first && Math.round(first.height)}px high)`);
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

await finish(browser)();
