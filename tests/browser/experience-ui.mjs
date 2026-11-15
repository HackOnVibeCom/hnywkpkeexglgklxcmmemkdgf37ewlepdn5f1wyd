// Experience profile (migration 8) in real Chrome against the stubbed API: four open-ended answers per category, general vs professional
// activation, pending assessment, independent categories, editing / deleting answers, AI consent, the two Discover views, a backend
// without migration 8, mobile. The RULES are enforced and tested in Postgres (supabase/tests/experience.mjs); the stub mirrors them.
import { createBackend, feedRow, iso } from './stub.mjs';
import { SHOTS, launch, newPage, overflowX, reporter, waitUntil } from './lib.mjs';

const ENV = process.env.BASE_ENV;
const browser = await launch();
const { ok, finish } = reporter();
const bodyText = (page) => page.locator('body').innerText();
const mins = (m) => iso(Date.now() - m * 60e3);
const ID = (n) => `${n}0000000-0000-0000-0000-00000000000${n}`;
const tester = (cats) => ({ nickname: 'Tess', bio: 'hello', categories: cats, updated_at: iso(Date.now()) });
const row = (n, name, mode, cats, ageMin) => feedRow({ campaign_id: ID(n), project_name: name, created_at: mins(ageMin), testing_mode: mode, target_categories: cats });
const rows = () => [
  row(1, 'Alpha open plain', 'open', [], 60),
  row(2, 'Beta open prefers tech', 'open', ['tech_savvy'], 50),
  row(3, 'Gamma targeted tech', 'targeted', ['tech_savvy'], 40),
  row(4, 'Delta targeted students', 'targeted', ['students_learners'], 30),
];
const pagesFor = (rs) => Object.fromEntries(rs.map((r) => [r.campaign_id, { available: true, reservedByOther: false }]));
const GOOD = (tag) => ({
  q1: `I use ${tag} tools almost every single day`,
  q2: `A small project where I built ${tag} things myself`,
  q3: `Something broke once so I read the ${tag} logs carefully`,
  q4: `Products related to ${tag} are the ones I enjoy testing`,
});
async function fill(panel, a) {
  for (const id of ['q1', 'q2', 'q3', 'q4']) await panel.getByTestId(`answer-${id}`).fill(a[id]);
}
const status = (page, cat) => page.getByTestId(`status-${cat}`);
const badge = (page, cat) => page.getByTestId(`profile-cat-badge-${cat}`);
const settle = (page, fn, t = 6000) => waitUntil(fn, t);

// ───────────── E1: general category: tick, save, answer four questions → active ─────────────
console.log('\n[E1] a general category: four written answers make it active');
{
  const be = createBackend({});
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/profile');
  await page.getByLabel('Nickname').waitFor();
  ok((await page.getByTestId('profile-incomplete').count()) === 1 && /Complete your tester profile to start testing/.test(await page.getByTestId('profile-incomplete').innerText()), 'a new identity sees "Complete your tester profile to start testing" (and nothing blocks entering the app)');
  ok((await page.locator('input[type=password], input[type=email]').count()) === 0, 'anonymous: no email, no password');
  await page.getByLabel('Nickname').fill('Sam');
  await page.getByTestId('profile-cat-students_learners').locator('input').check();
  ok(/Save your profile, then answer its four questions/.test(await badge(page, 'students_learners').innerText()), 'a ticked but unsaved category says what to do next');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByText('Profile saved').waitFor();
  ok(/answer the four questions/i.test(await page.getByTestId('saved-next').innerText()), 'saving is instant and says the next step');
  await settle(page, async () => (await page.getByTestId('experience-row-students_learners').count()) === 1);
  ok(/Incomplete · four answers needed/.test(await status(page, 'students_learners').innerText()), 'the category shows as incomplete until its answers exist');
  ok(/Browsing and requesting tests needs no profile/.test(await bodyText(page)), 'the page says browsing / requesting needs no profile');
  await page.getByTestId('answer-students_learners').click();
  const panel = page.getByTestId('experience-students_learners');
  await panel.getByTestId('answer-q1').waitFor();
  ok((await panel.locator('textarea').count()) === 4 && (await panel.locator('input[type=checkbox], input[type=radio]').count()) === 0, 'exactly four free-text boxes: no checkboxes, no radio buttons, no multiple choice');
  const pt = await panel.innerText();
  ok(/Question 1 for students_learners/.test(pt) && /Question 4 for students_learners/.test(pt), 'the four category questions are shown in order');
  ok(/sensitive personal details/.test(pt) && /private to you/.test(pt) && /nobody is assumed to be a beginner/.test(pt), 'privacy, no-sensitive-details and no-skill-assumption notes are visible');
  ok(/become[s]? <?\s*active|active/i.test(await panel.getByTestId('general-note').innerText()) && /no skills exam, no credentials/.test(await panel.getByTestId('general-note').innerText()), 'a general category says: active once saved, no exam, no credentials');
  // client-side validation: nothing is sent
  await panel.getByTestId('answer-q1').fill('short');
  await panel.getByTestId('save-answers').click();
  ok(/Write at least 15 characters/.test(await panel.innerText()) && be.called('save_experience_answers').length === 0, 'too-short / missing answers are explained on the page and nothing is sent');
  await fill(panel, { q1: 'Same words repeated here', q2: 'Same words repeated here', q3: GOOD('x').q3, q4: GOOD('x').q4 });
  await panel.getByTestId('save-answers').click();
  ok(/must be different from each other/.test(await panel.innerText()) && be.called('save_experience_answers').length === 0, 'four identical answers are refused on the page too');
  const a = GOOD('study');
  await fill(panel, a);
  await panel.getByTestId('save-answers').click();
  await panel.getByTestId('experience-saved').waitFor();
  const sent = be.called('save_experience_answers')[0].body;
  ok(sent.p_category === 'students_learners' && JSON.stringify(sent.p_answers) === JSON.stringify(a), 'the payload is {q1..q4} strings for the right category');
  ok(/this category is now active/.test(await panel.getByTestId('experience-saved').innerText()), 'saving makes a general category ACTIVE straight away (no assessment)');
  await settle(page, async () => /^Active/.test(await status(page, 'students_learners').innerText().catch(() => '')));
  ok(/^Active$/.test(await status(page, 'students_learners').innerText()), 'the row status is Active');
  ok((await page.getByTestId('profile-complete').count()) === 1 && /You can take tests and earn credits/.test(await page.getByTestId('profile-complete').innerText()), 'the profile is complete: the banner says tests can be taken');
  ok(be.s.balance === 1, 'credits untouched');
  const txt = (await bodyText(page)).replace(/not a verified credential/gi, '').replace(/does not verify/gi, '').replace(/UXBarter does not verify[^.]*\./gi, '');
  ok(!/\b(verified|certified|accredited|validated)\b/i.test(txt), 'nothing on the page claims verification');
  await page.screenshot({ path: `${SHOTS}/exp-general-1280.png`, fullPage: true });
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── E2: professional category: answers → pending assessment, never active by themselves ─────────────
console.log('\n[E2] a professional category: pending assessment until a decision exists');
{
  const rs = rows();
  const be = createBackend({ feed: rs, pages: pagesFor(rs), tester: tester(['tech_savvy']), answered: [] });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/profile?answers=tech_savvy');
  const panel = page.getByTestId('experience-tech_savvy');
  await panel.getByTestId('answer-q1').waitFor();
  ok(/Incomplete/.test(await status(page, 'tech_savvy').innerText()), 'tech-savvy starts incomplete');
  ok(/stays <?\s*pending|pending/i.test(await panel.getByTestId('assessment-note').innerText()) && /does not verify employment, identity or qualifications/.test(await panel.getByTestId('assessment-note').innerText()), 'the panel says the category stays pending until assessed and that nothing is verified');
  await fill(panel, GOOD('qa'));
  await panel.getByTestId('save-answers').click();
  await panel.getByTestId('experience-saved').waitFor();
  const saved = await panel.getByTestId('experience-saved').innerText();
  ok(/pending assessment/i.test(saved) && /allow AI processing/i.test(saved) && !/now active/.test(saved), 'after saving: PENDING assessment, asks for AI permission, never "active"');
  await settle(page, async () => /Pending assessment/.test(await status(page, 'tech_savvy').innerText().catch(() => '')));
  ok(/Pending assessment · needs your AI permission/.test(await status(page, 'tech_savvy').innerText()) && (await status(page, 'tech_savvy').getAttribute('data-state')) === 'pending_assessment', 'the status is "Pending assessment · needs your AI permission"');
  ok((await page.getByTestId('profile-complete').count()) === 1 && /None of your categories is active yet/.test(await page.getByTestId('profile-complete').innerText()), 'profile completion is satisfied (tests can be taken) but no category is active yet');
  // consent turns it into "answers received"
  await page.getByTestId('ai-consent-toggle').click();
  await settle(page, async () => /answers received/.test(await status(page, 'tech_savvy').innerText().catch(() => '')));
  ok(/Pending assessment · answers received/.test(await status(page, 'tech_savvy').innerText()) && be.s.consent === true, 'with AI permission the status says the answers are received and waiting');
  ok(/ON/.test(await page.getByTestId('ai-consent-state').innerText()), 'the consent card reflects it');
  await page.screenshot({ path: `${SHOTS}/exp-pro-pending-1280.png`, fullPage: true });
  // the open task works, the targeted one does not (server)
  await page.goto(ENV + '/discover');
  await page.getByText('Alpha open plain').waitFor();
  const eligible = page.getByTestId('eligible-list');
  ok((await eligible.getByRole('link', { name: 'Start test' }).count()) === 2 && (await eligible.getByTestId('match-badge').count()) === 0, 'open tasks can be started; none "matches" through the pending category');
  await page.getByTestId('not-available').evaluate((el) => { el.open = true; });
  ok(/Not eligible: qualification required/.test(await page.getByTestId('not-eligible-badge').first().innerText()) && (await page.getByTestId('not-available').getByRole('link', { name: 'Start test' }).count()) === 0, 'the targeted tech task is "qualification required" and cannot be started');
  // a decision arrives (simulated server decision) -> active
  be.s.qualified.add('tech_savvy');
  await page.goto(ENV + '/profile');
  await settle(page, async () => /Active/.test(await status(page, 'tech_savvy').innerText().catch(() => '')));
  ok(/Active · qualified by assessment/.test(await status(page, 'tech_savvy').innerText()), 'once the server records a qualified decision the category is "Active · qualified by assessment"');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();

  // not qualified: a way forward
  const be2 = createBackend({ tester: tester(['founders_builders']), notQualified: ['founders_builders'], consent: true, answerText: { founders_builders: GOOD('product') } });
  const c2 = await newPage(browser, 1280);
  await be2.install(c2.ctx);
  await c2.page.goto(ENV + '/profile');
  await c2.page.getByTestId('status-founders_builders').waitFor();
  ok(/Not qualified yet · edit your answers to be assessed again/.test(await status(c2.page, 'founders_builders').innerText()) && (await c2.page.getByTestId('answer-founders_builders').innerText()) === 'Edit my answers', 'not_qualified: says so, offers "Edit my answers" to be assessed again');
  await c2.ctx.close();

  // somebody who passed the retired multiple-choice screening earlier gets NO shortcut: complete answers, still pending assessment
  const be3 = createBackend({ tester: tester(['business_office']), answerText: { business_office: GOOD('office') } });
  const c3 = await newPage(browser, 1280);
  await be3.install(c3.ctx);
  await c3.page.goto(ENV + '/profile');
  await c3.page.getByTestId('status-business_office').waitFor();
  ok(/Pending assessment/.test(await status(c3.page, 'business_office').innerText()) && !/Active/.test(await status(c3.page, 'business_office').innerText()), 'there is no shortcut for earlier multiple-choice passes: pending assessment like everybody else');
  await c3.ctx.close();
}

// ───────────── E3: independent categories ─────────────
console.log('\n[E3] categories are independent');
{
  const be = createBackend({ tester: tester(['tech_savvy', 'founders_builders', 'students_learners']), answered: ['students_learners'] });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/profile');
  await page.getByTestId('experience-row-students_learners').waitFor();
  ok(/^Active/.test(await status(page, 'students_learners').innerText()) && /Incomplete/.test(await status(page, 'tech_savvy').innerText()) && /Incomplete/.test(await status(page, 'founders_builders').innerText()), 'students Active; tech and founders Incomplete (nothing is silently activated)');
  ok(/^Active/.test(await badge(page, 'students_learners').innerText()) && /Incomplete/.test(await badge(page, 'tech_savvy').innerText()), 'the category picker shows the same statuses');
  ok((await page.getByTestId('profile-complete').count()) === 1, 'one completed category is enough to take tests');
  await page.getByTestId('answer-tech_savvy').click();
  const panel = page.getByTestId('experience-tech_savvy');
  await panel.getByTestId('answer-q1').waitFor();
  ok((await page.getByTestId('experience-founders_builders').count()) === 0, 'only the opened category shows its questions');
  await fill(panel, GOOD('devtools'));
  await panel.getByTestId('save-answers').click();
  await panel.getByTestId('experience-saved').waitFor();
  await settle(page, async () => /Pending assessment/.test(await status(page, 'tech_savvy').innerText().catch(() => '')));
  ok(/^Active/.test(await status(page, 'students_learners').innerText()) && /Pending assessment/.test(await status(page, 'tech_savvy').innerText()) && /Incomplete/.test(await status(page, 'founders_builders').innerText()), 'completing one category changes only that one: students still Active, founders still Incomplete');
  // un-ticking a pending category and the "save first" hint for a new one
  await page.getByTestId('profile-cat-business_office').locator('input').check();
  ok(/Save your profile, then answer its four questions/.test(await badge(page, 'business_office').innerText()), 'a newly ticked category asks to be saved first');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── E4: edit, rate limit, delete ─────────────
console.log('\n[E4] editing, the save limit and deleting my answers');
{
  const saved = { q1: 'My earlier first answer here', q2: 'My earlier second answer here', q3: 'My earlier third answer here', q4: 'My earlier fourth answer here' };
  const be = createBackend({ tester: tester(['students_learners']), answerText: { students_learners: saved }, saves: { students_learners: 2 } });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/profile');
  await page.getByTestId('answer-students_learners').waitFor();
  ok((await page.getByTestId('answer-students_learners').innerText()) === 'Edit my answers', 'an existing set of answers is offered for editing');
  await page.getByTestId('answer-students_learners').click();
  const panel = page.getByTestId('experience-students_learners');
  await panel.getByTestId('answer-q1').waitFor();
  await settle(page, async () => (await panel.getByTestId('answer-q1').inputValue()) === saved.q1);
  ok((await panel.getByTestId('answer-q1').inputValue()) === saved.q1 && (await panel.getByTestId('answer-q4').inputValue()) === saved.q4, 'MY stored answers are loaded back for editing');
  ok(/3 of 5 saves left/.test(await panel.innerText()), 'the remaining saves in the 24-hour window are shown');
  await panel.getByTestId('answer-q2').fill('A new and better second answer here');
  await panel.getByTestId('save-answers').click();
  await panel.getByTestId('experience-saved').waitFor();
  ok(be.s.expSaves.length === 1 && be.s.expSaves[0].answers.q2.startsWith('A new and better') && be.s.expSaves[0].answers.q1 === saved.q1, 'only the edited text changed; the rest is preserved');
  ok(/^Active$/.test(await status(page, 'students_learners').innerText()), 'editing a general category keeps it active');
  // rate limit surfaces in plain language
  be.s.saves.students_learners = 5;
  await panel.getByTestId('answer-q3').fill('Yet another version of the third answer');
  await panel.getByTestId('save-answers').click();
  await page.getByText('You have saved this category 5 times in the last 24 hours.', { exact: false }).waitFor();
  ok(true, 'the server-side save limit is shown as a plain message');
  // delete everything
  await page.getByTestId('delete-experience-btn').click();
  ok(/Delete all four-question answers/.test(await page.getByTestId('delete-experience').innerText()) && be.s.deleteCalls.length === 0, 'deleting asks for confirmation first');
  await page.getByRole('button', { name: 'Keep them' }).click();
  ok(be.s.deleteCalls.length === 0, '"Keep them" cancels');
  await page.getByTestId('delete-experience-btn').click();
  await page.getByTestId('confirm-delete-experience').click();
  await page.getByTestId('experience-deleted').waitFor();
  ok(be.s.deleteCalls.length === 1 && be.s.deleteCalls[0] === null && Object.keys(be.s.answerText).length === 0, 'all written answers are deleted');
  await settle(page, async () => (await page.getByTestId('profile-incomplete').count()) === 1);
  ok((await page.getByTestId('profile-incomplete').count()) === 1 && /Incomplete/.test(await status(page, 'students_learners').innerText()), 'afterwards the profile is incomplete again; the category itself stays selected');
  ok(be.s.balance === 1, 'credits untouched');
  ok(errors.filter((e) => !/status of 400/.test(e)).length === 0, 'no console errors (apart from the deliberate rate-limit 400)', errors.join('|'));
  await ctx.close();
}

// removing the tester profile also removes the written answers
console.log('\n[E4b] removing my profile also deletes my written answers');
{
  const be = createBackend({ tester: tester(['students_learners']), answerText: { students_learners: GOOD('study') } });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/profile');
  await page.getByRole('button', { name: 'Remove my profile' }).click();
  ok(/Delete nickname, bio, categories and your written answers?/.test(await bodyText(page)), 'the confirmation says the written answers are deleted too');
  await page.getByTestId('confirm-remove').click();
  await page.getByText('Profile removed').waitFor();
  ok(be.s.tester === null && be.s.deleteCalls.length === 1 && be.s.deleteCalls[0] === null && Object.keys(be.s.answerText).length === 0, 'the profile AND all written answers are gone (delete_my_experience() was called)');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── E5: consent ─────────────
console.log('\n[E5] AI permission is explicit and revocable');
{
  const be = createBackend({ tester: tester(['students_learners']) });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/profile');
  await page.getByTestId('ai-consent').waitFor();
  const t = await page.getByTestId('ai-consent').innerText();
  ok(/off by default/.test(t) && /nothing is sent anywhere until you turn it on/.test(t) && /nickname and account id are never sent/.test(t) && /never see your answers/.test(t), 'the consent card says: off by default, nothing sent until opted in, what is not sent, who never sees answers');
  ok(!(await page.getByTestId('ai-consent-toggle').isChecked()) && /OFF/.test(await page.getByTestId('ai-consent-state').innerText()) && be.s.consentCalls.length === 0, 'it is OFF initially and nothing was sent');
  await page.getByTestId('ai-consent-toggle').click();
  await settle(page, async () => be.s.consent === true);
  await settle(page, async () => /ON/.test(await page.getByTestId('ai-consent-state').innerText().catch(() => '')));
  ok(be.s.consent === true && JSON.stringify(be.s.consentCalls) === '[true]', 'opting in calls set_ai_consent(true) once');
  await page.getByTestId('ai-consent-toggle').click();
  await settle(page, async () => be.s.consent === false);
  ok(JSON.stringify(be.s.consentCalls) === '[true,false]', 'and it can be switched off again');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── E6: Discover views ─────────────
console.log('\n[E6] Discover: recommended view and browse-all view');
{
  const rs = rows();
  // complete profile, no consent
  const be = createBackend({ feed: rs, pages: pagesFor(rs), tester: tester(['students_learners']) });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/discover');
  await page.getByTestId('tab-browse').waitFor();
  ok((await page.getByTestId('tab-browse').getAttribute('aria-selected')) === 'true' && (await page.getByTestId('browse-view').count()) === 1, 'with no recommendations available the page opens on "Browse all eligible tests"');
  ok(/Browse all eligible tests \(\d+\)/.test(await page.getByTestId('tab-browse').innerText()), 'the tab shows how many tests are eligible');
  const el = page.getByTestId('eligible-list');
  ok((await el.locator(':scope > li').count()) === 3 && JSON.stringify(await el.locator(':scope > li h2').allInnerTexts()) === JSON.stringify(['Delta targeted students', 'Alpha open plain', 'Beta open prefers tech']), 'only eligible tests are listed as actionable (the tech targeted task is not)');
  await page.getByTestId('tab-recommended').click();
  const rv = await page.getByTestId('recommended-view').innerText();
  ok(/Turn on AI personalization to get recommendations/.test(rv) && (await page.getByTestId('open-consent').getAttribute('href')) === '/profile', 'without AI permission the Recommended view asks for it (and links to the profile), it does not guess');
  ok((await page.getByTestId('recommended-view').locator('li').count()) === 0, 'and lists nothing');
  await page.screenshot({ path: `${SHOTS}/exp-discover-reco-1280.png`, fullPage: true });
  // consent but the service is not there yet
  be.s.consent = true;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await settle(page, async () => /not available yet/.test(await page.getByTestId('recommended-view').innerText().catch(() => '')));
  ok(/Personalized recommendations are not available yet/.test(await page.getByTestId('recommended-view').innerText()), 'with permission but no AI service yet, it says honestly that recommendations are not available yet');
  await page.getByRole('button', { name: 'Browse all eligible tests' }).click();
  ok((await page.getByTestId('browse-view').count()) === 1, 'and offers the browse-all view');
  ok(!/\b(AI-powered|machine learning model|smart AI)\b/i.test(await bodyText(page)), 'no invented AI claims');
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();

  // incomplete profile
  const be2 = createBackend({ feed: rs, pages: pagesFor(rs), tester: tester(['students_learners']), answered: [] });
  const c2 = await newPage(browser, 1280);
  await be2.install(c2.ctx);
  await c2.page.goto(ENV + '/discover');
  await c2.page.getByTestId('profile-needed').waitFor();
  ok((await c2.page.getByTestId('eligible-list').count()) === 0 && /Nothing you can take right now/.test(await c2.page.getByTestId('browse-view').innerText()), 'incomplete profile: no actionable tests, an honest empty state');
  await c2.page.getByTestId('tab-recommended').click();
  ok(/Complete your tester profile first/.test(await c2.page.getByTestId('recommended-view').innerText()) && (await c2.page.getByTestId('open-profile').getAttribute('href')) === '/profile', 'and the Recommended view points to the profile');
  ok(be2.called('start_test').length === 0, 'nothing was reserved');
  await c2.ctx.close();
}

// ───────────── E7: backend without migration 8 ─────────────
console.log('\n[E7] UI deployed before migration 8: nothing is invented');
{
  const rs = rows();
  const be = createBackend({ feed: rs, pages: pagesFor(rs), tester: tester(['tech_savvy']), v3: false });
  const { ctx, page, errors } = await newPage(browser, 1280);
  await be.install(ctx);
  await page.goto(ENV + '/profile');
  await page.getByTestId('profile-form').waitFor();
  ok((await page.getByTestId('experience-section').count()) === 0 && (await page.getByTestId('ai-consent').count()) === 0 && (await page.getByTestId('profile-incomplete').count()) === 0, 'the profile page shows no experience section, no consent card and no completion banner');
  ok(be.called('get_my_experience').length >= 1, 'the UI asked the server first');
  await page.goto(ENV + '/discover');
  await page.getByText('Alpha open plain').waitFor();
  ok((await page.getByTestId('tab-recommended').count()) === 0 && (await page.getByTestId('profile-needed').count()) === 0, 'Discover shows the plain list: no tabs, no profile banner');
  ok(errors.filter((e) => !/404|PGRST202|Failed to load resource/i.test(e)).length === 0, 'no unexpected console errors', errors.join('|'));
  await ctx.close();
}

// ───────────── E8: mobile ─────────────
console.log('\n[E8] mobile (360 px)');
{
  const rs = rows();
  const be = createBackend({ feed: rs, pages: pagesFor(rs), tester: tester(['tech_savvy', 'students_learners']), answered: ['students_learners'] });
  const { ctx, page, errors } = await newPage(browser, 360, 800);
  await be.install(ctx);
  await page.goto(ENV + '/profile?answers=tech_savvy');
  await page.getByTestId('experience-tech_savvy').getByTestId('answer-q1').waitFor();
  ok(!(await overflowX(page)), 'profile with the four questions open: no horizontal overflow');
  const box = await page.getByTestId('experience-tech_savvy').getByTestId('answer-q1').boundingBox();
  ok(box && box.height >= 60 && box.width >= 250, `the answer boxes are comfortable to type in (${box && Math.round(box.width)}x${box && Math.round(box.height)}px)`);
  const btn = await page.getByTestId('save-answers').boundingBox();
  ok(btn && btn.height >= 36, `the Save button is a comfortable tap target (${btn && Math.round(btn.height)}px high)`);
  await page.screenshot({ path: `${SHOTS}/exp-profile-360.png`, fullPage: true });
  await page.goto(ENV + '/discover');
  await page.getByTestId('tab-browse').waitFor();
  ok(!(await overflowX(page)), 'Discover with its two tabs: no horizontal overflow');
  const tabs = await page.getByTestId('tab-recommended').boundingBox();
  ok(tabs && tabs.height >= 36, `the tabs are comfortable tap targets (${tabs && Math.round(tabs.height)}px high)`);
  await page.getByTestId('tab-recommended').click();
  ok(!(await overflowX(page)), 'and so is the recommended view');
  await page.screenshot({ path: `${SHOTS}/exp-discover-360.png`, fullPage: true });
  ok(errors.length === 0, 'no console errors', errors.join('|'));
  await ctx.close();
}

await finish(browser)();
