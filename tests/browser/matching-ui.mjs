// Targeted Tester Matching UI in real Chrome against the stubbed API: tester profile (create / suggest / edit / remove),
// target categories on "Request a test", the matched Discover feed (order, badge, explanation), legacy compatibility,
// a backend that predates the migration, anonymous use, mobile layout. The ranking rules themselves are tested in
// Postgres (supabase/tests/matching.mjs); the stub mirrors them so the UI is exercised on realistic data.
import { createBackend, dashCampaign, feedRow, iso } from './stub.mjs';
import { SHOTS, launch, newPage, overflowX, reporter, waitUntil } from './lib.mjs';

const ENV = process.env.BASE_ENV;
const browser = await launch();
const { ok, finish } = reporter();
const bodyText = (page) => page.locator('body').innerText();
const titles = (page) => page.locator('ul > li h2').allInnerTexts();
const mins = (m) => iso(Date.now() - m * 60e3);

const feed = () => [
  feedRow({ campaign_id: 'a0000000-0000-0000-0000-000000000001', project_name: 'Alpha Legacy', created_at: mins(50), target_categories: [] }),
  feedRow({ campaign_id: 'b0000000-0000-0000-0000-000000000002', project_name: 'Beta Tech', created_at: mins(40), target_categories: ['tech_savvy'] }),
  feedRow({ campaign_id: 'c0000000-0000-0000-0000-000000000003', project_name: 'Gamma Students', created_at: mins(30), target_categories: ['students_learners'] }),
  feedRow({ campaign_id: 'd0000000-0000-0000-0000-000000000004', project_name: 'Delta TechFounders', created_at: mins(20), target_categories: ['tech_savvy', 'founders_builders'] }),
];
const tester = (cats, extra = {}) => ({ nickname: 'Tess', bio: 'hello', categories: cats, updated_at: iso(Date.now()), ...extra });

// ───────────── landing + navigation ─────────────
console.log('\n[M0] the capability is explained, not oversold');
{
  const be = createBackend();
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/');
  await page.getByTestId('matching-section').waitFor();
  const t = await page.getByTestId('matching-section').innerText();
  ok(/Targeted Tester Matching/.test(t) && /not an AI model/i.test(t) && /open testing/i.test(t) && /targeted testing/i.test(t) && /self-reported/i.test(t) && /not a verified credential/i.test(t), 'landing names the feature, says it is not an AI model, explains open vs targeted testing and that screening is self-reported, not a verified credential');
  ok(/Tech-Savvy Users/.test(t) && /Everyday & Non-Technical Users/.test(t), 'landing lists the categories');
  ok(await page.getByRole('link', { name: 'Profile', exact: true }).isVisible(), 'the main navigation links to the (optional) tester profile');
  const all = await bodyText(page);
  ok(!/\bAI-powered\b|\bmachine learning model\b|smart AI|our AI\b/i.test(all), 'no AI claims anywhere on the landing page');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── Discover without a profile ─────────────
console.log('\n[M1] Discover with NO profile behaves exactly as before');
{
  const be = createBackend({ feed: feed() });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Beta Tech').waitFor();
  ok(JSON.stringify(await titles(page)) === JSON.stringify(['Alpha Legacy', 'Beta Tech', 'Gamma Students', 'Delta TechFounders']), 'oldest-first order, untouched', JSON.stringify(await titles(page)));
  ok((await page.getByTestId('recommended-badge').count()) === 0, 'nothing is marked "Recommended for you"');
  ok(await page.getByTestId('matching-note').getByText('Want tasks that fit you?').isVisible(), 'a gentle, optional pointer to the tester profile is shown');
  ok(await page.getByRole('link', { name: 'Set up my tester profile' }).isVisible(), 'with a link to /profile');
  ok((await page.getByTestId('looking-for').count()) === 3, 'tasks that name a target audience say who they are looking for (3 of 4)');
  ok(be.called('list_campaigns_v2').length === 1 && be.called('get_my_tester_profile').length === 1, 'the v2 feed and the profile are each read once');
  ok(be.called('list_open_campaigns').length === 0, 'the old feed is not needed when matching is available');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── Discover with a profile ─────────────
console.log('\n[M2] Discover with a profile: recommended first, others kept, explained');
{
  const be = createBackend({ feed: feed(), tester: tester(['tech_savvy']) });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Beta Tech').waitFor();
  const order = await titles(page);
  ok(JSON.stringify(order) === JSON.stringify(['Beta Tech', 'Delta TechFounders', 'Alpha Legacy', 'Gamma Students']), 'matching tasks first (oldest first among equals), the rest keep their old order', JSON.stringify(order));
  ok(order.length === 4, 'non-matching tasks stay available');
  ok((await page.getByTestId('recommended-badge').count()) === 2, 'exactly the two overlapping tasks carry the "Recommended for you" badge');
  const first = page.locator('ul > li').first();
  ok((await first.innerText()).includes('Recommended for you') && (await first.getAttribute('data-recommended')) === 'true', 'the badge sits on the first card');
  ok(/Why: your profile includes Tech-Savvy Users\./.test(await first.innerText()), 'each recommendation explains why (the overlapping category)');
  const delta = page.locator('ul > li', { hasText: 'Delta TechFounders' });
  ok(/Why: your profile includes Tech-Savvy Users\./.test(await delta.innerText()) && !/Why:.*Founders/.test(await delta.innerText()), "only MY overlapping category is credited (the task's other target is not)");
  ok(/Targeted Tester Matching is on/.test(await page.getByTestId('matching-note').innerText()) && /2 tasks are recommended/.test(await page.getByTestId('matching-note').innerText()), 'a summary line says matching is on and how many tasks are recommended');
  ok((await page.locator('ul > li', { hasText: 'Alpha Legacy' }).getByTestId('looking-for').count()) === 0 && (await page.locator('ul > li', { hasText: 'Alpha Legacy' }).getByTestId('recommended-badge').count()) === 0, 'a legacy task (no target) shows neither a badge nor a "looking for" line');
  ok((await page.getByRole('link', { name: 'Start test' }).count()) === 4, 'every task can still be started, matched or not');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await page.screenshot({ path: `${SHOTS}/matching-discover-1280.png`, fullPage: true });
  await ctx.close();

  const be2 = createBackend({ feed: feed(), tester: tester(['everyday_nontechnical']) });
  const c2 = await newPage(browser, 1280);
  await be2.install(c2.ctx);
  await c2.page.goto(ENV + '/discover');
  await c2.page.getByText('Beta Tech').waitFor();
  ok((await c2.page.getByTestId('recommended-badge').count()) === 0 && JSON.stringify(await titles(c2.page)) === JSON.stringify(['Alpha Legacy', 'Beta Tech', 'Gamma Students', 'Delta TechFounders']), 'a profile with no overlapping task: old order, no badges');
  ok(/No task asked for your categories right now/.test(await c2.page.getByTestId('matching-note').innerText()), 'and the page says so honestly');
  await c2.ctx.close();

  const be3 = createBackend({ feed: feed(), tester: tester([]) });
  const c3 = await newPage(browser, 1280);
  await be3.install(c3.ctx);
  await c3.page.goto(ENV + '/discover');
  await c3.page.getByText('Beta Tech').waitFor();
  ok((await c3.page.getByTestId('recommended-badge').count()) === 0 && (await c3.page.getByText('Want tasks that fit you?').count()) === 1, 'a profile without categories is treated like no profile');
  await c3.ctx.close();
}

// ───────────── profile page: create, suggest, correct, remove ─────────────
console.log('\n[M3] tester profile: create / suggest / edit / remove');
{
  const be = createBackend({ feed: feed() });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/profile');
  await page.getByLabel('Nickname').waitFor();
  ok((await page.locator('input[type=password], input[type=email]').count()) === 0, 'anonymous: the profile asks for no email and no password');
  ok(await page.getByRole('group', { name: 'Which kinds of tester are you?' }).isVisible(), 'the categories are an accessible group (fieldset + legend)');
  ok((await page.locator('[data-testid^=profile-cat-] input:checked').count()) === 0, 'nothing is pre-selected');
  ok(/not AI/i.test(await bodyTextOf(page)) && /Nothing is selected for you/.test(await bodyTextOf(page)), 'the suggester is described as keyword matching, not AI, and never selects for you');

  // validation: nothing is sent
  await page.getByRole('button', { name: 'Save profile' }).click();
  ok(await page.getByText('Nickname must be 2–30 characters.').isVisible(), 'a missing nickname is rejected on the page');
  ok(be.called('save_tester_profile').length === 0, 'and nothing is sent to the server');

  // suggestions
  await page.getByLabel('Nickname').fill('Sam');
  await page.getByLabel('Short bio (optional)').fill('Backend developer and part-time student, not a fan of social media');
  await page.getByTestId('suggest-btn').click();
  const sug = await page.getByTestId('suggestions').innerText();
  ok(/Tech-Savvy Users/.test(sug) && /“developer”/.test(sug) && /Students & Learners/.test(sug) && /“student”/.test(sug), 'suggestions list the category AND the exact words that triggered it', sug);
  ok((await page.locator('[data-testid^=profile-cat-] input:checked').count()) === 0, 'suggesting does not select anything');
  await page.getByTestId('add-students_learners').click();
  ok(await page.getByTestId('profile-cat-students_learners').locator('input').isChecked(), 'the user adds a suggestion explicitly');
  await page.getByTestId('profile-cat-tech_savvy').locator('input').check();
  await page.getByTestId('profile-cat-founders_builders').locator('input').check();
  await page.getByTestId('profile-cat-founders_builders').locator('input').uncheck();
  ok(!(await page.getByTestId('profile-cat-founders_builders').locator('input').isChecked()), 'a category can be selected and corrected again');

  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByText('Profile saved').waitFor();
  const save1 = be.called('save_tester_profile')[0].body;
  ok(save1.p_nickname === 'Sam' && save1.p_bio.startsWith('Backend developer') && JSON.stringify(save1.p_categories) === JSON.stringify(['tech_savvy', 'students_learners']), 'the payload matches the SQL parameters; categories are in canonical order', JSON.stringify(save1));
  ok(/Discover will recommend tasks for Tech-Savvy Users, Students & Learners/.test(await bodyTextOf(page)), 'the confirmation says exactly what will change');
  ok(await page.getByRole('button', { name: 'Save changes' }).isVisible() && await page.getByRole('button', { name: 'Remove my profile' }).isVisible(), 'the form now offers Save changes / Remove');

  // the saved profile drives Discover
  await page.getByRole('link', { name: 'See recommended tasks' }).click();
  await page.getByText('Beta Tech').waitFor();
  ok(JSON.stringify(await titles(page)) === JSON.stringify(['Beta Tech', 'Gamma Students', 'Delta TechFounders', 'Alpha Legacy']), 'right after saving, Discover is re-ordered for the new categories', JSON.stringify(await titles(page)));

  // reload: persisted
  await page.goto(ENV + '/profile');
  await page.getByLabel('Nickname').waitFor();
  ok((await page.getByLabel('Nickname').inputValue()) === 'Sam' && await page.getByTestId('profile-cat-students_learners').locator('input').isChecked(), 'the profile is loaded back after a reload');

  // correct it
  await page.getByLabel('Nickname').fill('Sam B.');
  await page.getByTestId('profile-cat-students_learners').locator('input').uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Profile saved').waitFor();
  ok(be.s.tester.nickname === 'Sam B.' && JSON.stringify(be.s.tester.categories) === '["tech_savvy"]', 'editing replaces the profile in place');

  // server-side validation message
  be.s.forced.save_tester_profile = { message: 'invalid_categories' };
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('One of the selected categories is not valid.', { exact: false }).waitFor();
  ok(true, 'a server-side rejection is shown as a plain-language message');

  // remove (two-step)
  await page.getByRole('button', { name: 'Remove my profile' }).click();
  ok(await page.getByText('Delete nickname, bio and categories?').isVisible() && be.called('delete_my_tester_profile').length === 0, 'removal asks for confirmation first');
  await page.getByRole('button', { name: 'Keep it' }).click();
  ok(be.called('delete_my_tester_profile').length === 0, '"Keep it" cancels');
  await page.getByRole('button', { name: 'Remove my profile' }).click();
  await page.getByTestId('confirm-remove').click();
  await page.getByText('Profile removed').waitFor();
  ok(be.s.tester === null && (await page.getByLabel('Nickname').inputValue()) === '', 'the profile is deleted and the form is empty');
  await page.getByRole('link', { name: 'Discover' }).first().click();
  await page.getByText('Beta Tech').waitFor();
  ok((await page.getByTestId('recommended-badge').count()) === 0 && JSON.stringify(await titles(page)) === JSON.stringify(['Alpha Legacy', 'Beta Tech', 'Gamma Students', 'Delta TechFounders']), 'after removal Discover is back to the default order');
  ok(be.s.balance === 1, 'profile actions never touch credits');
  ok(errors.filter((e) => !/status of 400/.test(e)).length === 0, 'no console errors (apart from the one deliberately forced 400)', errors.join('|'));
  await ctx.close();
}
async function bodyTextOf(page) {
  return page.locator('body').innerText();
}

// ───────────── request a test with a target audience ─────────────
console.log('\n[M4] Request a test: target categories');
{
  const fillBasics = async (page) => {
    await page.getByLabel('Project name').fill('Acme Invoicing');
    await page.getByLabel('Website URL').fill('https://acme.example.com');
    await page.getByLabel('The task (2–3 minutes)').fill('Create an invoice for a client and download it as a PDF file.');
  };
  const be = createBackend({ balance: 2 });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/create');
  await page.getByLabel('Project name').waitFor();
  ok(await page.getByRole('group', { name: 'Recommend it to (optional)' }).isVisible(), 'the audience picker is optional and labelled as such');
  ok(/preference, not a restriction/.test(await bodyTextOf(page)), 'it says honestly that matching is a preference');
  ok((await page.locator('[data-testid^=target-] input:checked').count()) === 0, 'nothing is selected by default');
  await fillBasics(page);
  await page.getByTestId('target-students_learners').locator('input').check();
  await page.getByTestId('target-tech_savvy').locator('input').check();
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await page.waitForURL('**/dashboard');
  const used = be.s.created[0];
  ok(used.rpc === 'create_targeted_campaign' && JSON.stringify(used.body.p_target_categories) === JSON.stringify(['tech_savvy', 'students_learners']), 'with categories: create_targeted_campaign gets them (canonical order)', JSON.stringify(used));
  ok(used.body.p_task.startsWith('Create an invoice') && used.body.p_url === 'https://acme.example.com', 'the rest of the payload is unchanged');
  ok(be.s.balance === 1, 'one credit was spent');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();

  const be2 = createBackend({ balance: 2 });
  const c2 = await newPage(browser, 1280);
  await be2.install(c2.ctx);
  await c2.page.goto(ENV + '/create');
  await c2.page.getByLabel('Project name').waitFor();
  await fillBasics(c2.page);
  await c2.page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await c2.page.waitForURL('**/dashboard');
  ok(be2.s.created[0].rpc === 'create_project_with_campaign' && !('p_target_categories' in be2.s.created[0].body), 'with NO categories the original RPC and payload are used (legacy behaviour byte for byte)', JSON.stringify(be2.s.created[0]));
  await c2.ctx.close();

  const be3 = createBackend({ balance: 2 });
  const c3 = await newPage(browser, 1280);
  await be3.install(c3.ctx);
  be3.s.forced.create_targeted_campaign = { message: 'invalid_categories' };
  await c3.page.goto(ENV + '/create');
  await c3.page.getByLabel('Project name').waitFor();
  await fillBasics(c3.page);
  await c3.page.getByTestId('target-business_office').locator('input').check();
  await c3.page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await c3.page.getByText('One of the selected categories is not valid.', { exact: false }).waitFor();
  ok(be3.s.balance === 2 && c3.page.url().endsWith('/create'), 'a rejected targeted request shows the message, stays on the form and spends nothing');
  await c3.ctx.close();
}

// ───────────── dashboard ─────────────
console.log('\n[M5] Dashboard shows the audience of my requests');
{
  const be = createBackend({
    dashCampaigns: [
      dashCampaign({ id: 'cT', project: { name: 'Targeted app', url: 'https://t.example.com', description: null }, target_categories: ['tech_savvy', 'students_learners'] }),
      dashCampaign({ id: 'cL', project: { name: 'Legacy app', url: 'https://l.example.com', description: null } }),
    ],
  });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/dashboard');
  await page.getByText('Targeted app').waitFor();
  ok((await page.getByTestId('dash-targets').count()) === 1, 'only the targeted request lists preferred testers');
  ok(/Tech-Savvy Users/.test(await page.getByTestId('dash-targets').innerText()) && /Students & Learners/.test(await page.getByTestId('dash-targets').innerText()), 'with readable category names');
  ok(await page.getByText('Legacy app').isVisible(), 'a legacy request renders as before');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── backend without the migration ─────────────
console.log('\n[M6] UI deployed before the migration: everything still works');
{
  const be = createBackend({ matching: false, feed: feed(), balance: 2, dashCampaigns: [dashCampaign({ id: 'cL', project: { name: 'Legacy app', url: 'https://l.example.com', description: null } })] });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByText('Beta Tech').waitFor();
  ok(JSON.stringify(await titles(page)) === JSON.stringify(['Alpha Legacy', 'Beta Tech', 'Gamma Students', 'Delta TechFounders']), 'Discover falls back to the plain feed');
  ok((await page.getByTestId('matching-note').count()) === 0 && (await page.getByTestId('recommended-badge').count()) === 0 && (await page.getByTestId('looking-for').count()) === 0, 'and shows no matching UI at all (nothing half-working)');
  ok(be.called('list_open_campaigns').length === 1, 'the old RPC served the feed');
  await page.goto(ENV + '/dashboard');
  await page.getByText('Legacy app').waitFor();
  ok(be.s.calls.filter((c) => c.p === '/rest/v1/campaigns').length === 3, 'Dashboard retried with fewer columns until the backend accepted it');
  await page.goto(ENV + '/create');
  await page.getByLabel('Project name').waitFor();
  await page.getByLabel('Project name').fill('Acme Invoicing');
  await page.getByLabel('Website URL').fill('https://acme.example.com');
  await page.getByLabel('The task (2–3 minutes)').fill('Create an invoice for a client and download it as a PDF file.');
  await page.getByRole('button', { name: /Spend 1 credit/ }).click();
  await page.waitForURL('**/dashboard');
  ok(be.s.created[0].rpc === 'create_project_with_campaign', 'creating a request without categories works on the old backend');
  await page.goto(ENV + '/profile');
  await page.getByLabel('Nickname').waitFor();
  await page.getByLabel('Nickname').fill('Sam');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByText('Targeted Tester Matching is not available on this server yet.', { exact: false }).waitFor();
  ok(true, 'saving a profile there gives one clear message instead of a raw error');
  ok(!(await bodyTextOf(page)).includes('schema cache'), 'no raw PostgREST text reaches the user');
  ok(errors.filter((e) => !/404|400/.test(e)).length === 0, 'no unexpected console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── mobile ─────────────
console.log('\n[M7] mobile (360 px)');
{
  const be = createBackend({ feed: feed(), tester: tester(['tech_savvy', 'founders_builders']), balance: 2, dashCampaigns: [dashCampaign({ id: 'cT', project: { name: 'Targeted app', url: 'https://t.example.com', description: null }, target_categories: ['tech_savvy', 'students_learners', 'everyday_nontechnical'] })] });
  const { ctx, page, errors } = await newPage(browser, 360, 800);
  await be.install(ctx);
  for (const [path, wait, shot] of [
    ['/', 'matching-section', 'landing'],
    ['/discover', 'matching-note', 'discover'],
    ['/profile', 'profile-form', 'profile'],
    ['/create', null, 'create'],
    ['/dashboard', 'dash-targets', 'dashboard'],
  ]) {
    await page.goto(ENV + path);
    if (wait) await page.getByTestId(wait).waitFor();
    else await page.getByLabel('Project name').waitFor();
    ok(!(await overflowX(page)), `[360px] ${path}: no horizontal overflow`);
    await page.screenshot({ path: `${SHOTS}/matching-${shot}-360.png`, fullPage: true });
  }
  await page.goto(ENV + '/profile');
  await page.getByTestId('profile-form').waitFor();
  await page.getByLabel('Short bio (optional)').fill('Founder of a small startup and software developer');
  await page.getByTestId('suggest-btn').click();
  await page.getByTestId('suggestions').waitFor();
  ok(!(await overflowX(page)), '[360px] /profile with suggestions: no horizontal overflow');
  const tap = await page.getByTestId('profile-cat-business_office').boundingBox();
  ok(tap && tap.height >= 44, `[360px] category options are comfortable tap targets (${tap && Math.round(tap.height)}px high)`);
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();

  const wide = await newPage(browser, 1280, 900);
  await createBackend({ feed: feed(), tester: tester(['tech_savvy']) }).install(wide.ctx);
  await wide.page.goto(ENV + '/profile');
  await wide.page.getByTestId('profile-form').waitFor();
  await wide.page.screenshot({ path: `${SHOTS}/matching-profile-1280.png`, fullPage: true });
  await wide.ctx.close();
}

await finish(browser)();
