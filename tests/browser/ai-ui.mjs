// The AI service in the INTEGRATED UI (real Chrome, stubbed API; no OpenAI is ever contacted). Verified here: the tabbed Discover
// renders the AI service's recommendations (reason + verdict + the tester's own words + what is not covered) inside "Recommended
// for you", keeps "Browse all eligible tests" intact, never shows what the database says is ineligible, degrades honestly for every
// status, calls the service only with consent + a complete profile, withdraws consent / deletes answers together with the AI-derived
// data, and offers the professional assessment ("Check my answers") without ever being able to set a status itself.
// Server rules are tested in tests/unit/ai-engine.test.mjs, ai-assess.test.mjs, supabase/tests/ai_matching.mjs and tests/deno/e2e.mjs.
import { createBackend, feedRow, iso, HOST } from './stub.mjs';
import { SHOTS, launch, newPage, reporter } from './lib.mjs';

const ENV = process.env.BASE_AI; // build with VITE_AI_MATCHING=1
const OFF = process.env.BASE_ENV; // same app, flag unset
const browser = await launch();
const { ok, finish } = reporter();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const ID = (n) => `${n}0000000-0000-0000-0000-00000000000${n}`;
const mins = (m) => iso(Date.now() - m * 60e3);
const tester = (cats) => ({ nickname: 'Tess', bio: 'hello', categories: cats, updated_at: iso(Date.now()) });
const body = (page) => page.locator('body').innerText();
const noise = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));

const row = (n, name, o = {}) => feedRow({ campaign_id: ID(n), project_name: name, created_at: mins(60 - n), testing_mode: 'open', target_categories: [], ...o });
const feed = () => [
  row(1, 'API Debugger', { description: 'A developer tool for REST APIs' }),
  row(2, 'FreshCart', { description: 'Groceries and recipes' }),
  row(3, 'Secret Targeted Tool', { testing_mode: 'targeted', target_categories: ['tech_savvy'] }), // not eligible while tech_savvy is pending
  row(4, 'PlayHub', { description: 'Game launcher' }),
];
const rec = (n, verdict = 'good', o = {}) => ({
  campaign_id: ID(n), reason: `You report building web APIs, which this product needs (${n}).`, verdict,
  evidence: [{ quote: 'I built a Flask API for inventory', relevance: 'Direct hands-on experience.' }], unsupported_requirements: [], ...o,
});
const RES = (o = {}) => ({ status: 'ok', generated_at: iso(Date.now()), profile_etag: 'e'.repeat(64), items: [], evaluated: 3, from_cache: false, understanding: null, ...o });
const ASSESS = (results, status = 'ok') => ({ status, results, generated_at: iso(Date.now()) });
const CRIT = ['Names specific technologies you used.', 'Describes something technical you built.', 'Describes a technical problem you approached.', 'Explains what you can test well.'];
const assessRow = (category, outcome, extra = {}) => ({ category, outcome, message: `Message for ${outcome}. This is based on your self-reported answers, not on verified professional credentials.`, clarification_questions: [], criteria: CRIT, ...extra });

/** AI stub layered ON TOP of the base stub (later Playwright routes win; everything else falls back to it). */
async function installAi(ctx, ai, be) {
  await ctx.route(HOST + '/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(data) });
    const rpc = p.startsWith('/rest/v1/rpc/') ? p.slice('/rest/v1/rpc/'.length) : null;
    if (req.method() === 'OPTIONS' && (p === '/functions/v1/ai-match' || rpc === 'delete_my_ai_data')) return route.fulfill({ status: 204, headers: CORS });
    let b = null;
    try { b = req.postDataJSON(); } catch { /* none */ }
    if (rpc === 'delete_my_ai_data') { ai.deletes++; return send({ deleted_analyses: 1, deleted_verdicts: 2, deleted_notes: 0 }); }
    if (p === '/functions/v1/ai-match') {
      ai.fnCalls.push({ action: b?.action, body: b, auth: req.headers()['authorization'] ?? null });
      if (ai.fn === 'network') return route.abort();
      if (ai.fn === 'error') return send({ error: 'boom' }, 500);
      if (ai.fn === 'missing') return send({ message: 'Function not found' }, 404);
      if (b?.action === 'assess') {
        if (ai.delay) await new Promise((res) => setTimeout(res, ai.delay));
        const r = typeof ai.assess === 'function' ? ai.assess(be) : ai.assess;
        return send(r);
      }
      return send(typeof ai.result === 'function' ? ai.result() : ai.result);
    }
    return route.fallback();
  });
}
const mkAi = (o = {}) => ({ result: RES(), assess: ASSESS([]), fn: 'ok', fnCalls: [], deletes: 0, ...o });
async function open(width, be, ai, path = '/discover', base = ENV) {
  const t = await newPage(browser, width);
  await be.install(t.ctx);
  await installAi(t.ctx, ai, be);
  await t.page.goto(base + path);
  return t;
}
const recView = async (page) => { await page.getByTestId('tab-recommended').click(); await page.getByTestId('recommended-view').waitFor(); };
const mkBe = (o = {}) => createBackend({ feed: feed(), tester: tester(['students_learners']), consent: true, pages: {}, ...o });

// ───────────── Discover: recommendations inside the tabbed UI ─────────────
console.log('\n[D1] Recommended tab: AI items with reason, verdict, the tester\'s own words and what is not covered');
{
  const be = mkBe();
  // the service also returns an ineligible campaign and an unknown id (a faulty/compromised server): the UI must not show them
  const ai = mkAi({ result: RES({ items: [rec(1, 'strong', { unsupported_requirements: ['mobile testing'] }), rec(3, 'good'), { ...rec(2), campaign_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }], understanding: { summary: 's', areas: ['software development'] } }) });
  const { page, errors, dialogs, ctx } = await open(1280, be, ai);
  await page.getByTestId('recommended-view').waitFor();
  ok(ai.fnCalls.length === 1 && JSON.stringify(ai.fnCalls[0].body) === '{"action":"recommend"}', 'Discover calls the service once with ONLY {"action":"recommend"} (no user id, prompt, model)');
  ok(/^Bearer /.test(ai.fnCalls[0].auth ?? ''), 'with the normal session token in Authorization');
  const cards = page.getByTestId('recommended-view').locator('ul.grid > li');
  ok((await cards.count()) === 1, 'only the eligible, known campaign is rendered (ineligible targeted tool and unknown id are dropped)', String(await cards.count()));
  const ct = await cards.first().innerText();
  ok(/API Debugger/.test(ct) && /Why this fits you:/.test(ct) && /You report building web APIs/.test(ct), 'the contract field `reason` is shown in the existing "Why this fits you" box');
  ok(/Strong match/.test(ct) && /From your profile: .*I built a Flask API for inventory/.test(ct) && /Not clearly covered by your profile: mobile testing/.test(ct), 'plus the verdict, the verbatim quote from the tester\'s own text and what is not covered');
  ok(/AI-suggested/.test(ct) && /Not verified/.test(ct), 'labelled AI-suggested and not verified');
  ok(!/Secret Targeted Tool/.test(await page.getByTestId('recommended-view').innerText()), 'the ineligible Targeted campaign is not in the Recommended tab');
  await page.screenshot({ path: SHOTS + '/ai-discover-desktop.png', fullPage: true });
  await page.getByTestId('tab-browse').click();
  ok((await page.getByTestId('eligible-list').locator('> li').count()) === 3 && /Browse all eligible tests/.test(await page.getByTestId('tab-browse').innerText()), '"Browse all eligible tests" still lists every eligible task');
  ok((await page.getByTestId('not-available').count()) === 1, 'and the not-available section is unchanged');
  ok(dialogs.n === 0 && noise(errors).length === 0, 'no dialogs, no console errors', errors.join(' | '));
  await ctx.close();
}

console.log('\n[D2] Honest empty state, browse option stays');
{
  const be = mkBe();
  const ai = mkAi({ result: RES({ items: [] }) });
  const { page, ctx } = await open(1280, be, ai);
  await page.getByTestId('recommended-view').waitFor();
  ok(/No relevant recommendations right now/.test(await page.getByTestId('recommended-view').innerText()), 'an `ok` response with no items shows the honest empty state');
  ok((await page.getByTestId('recommended-view').locator('ul.grid > li').count()) === 0, 'nothing is shown as filler');
  await page.getByRole('button', { name: 'Browse all eligible tests' }).first().click();
  ok((await page.getByTestId('eligible-list').locator('> li').count()) === 3, 'the Browse button opens the full eligible list');
  await ctx.close();
}

console.log('\n[D3] Degradation: every status the service can return');
{
  for (const [label, setup, re] of [
    ['function returns 500', { fn: 'error' }, /not available yet/],
    ['network failure', { fn: 'network' }, /not available yet/],
    ['function not deployed (404)', { fn: 'missing' }, /not available yet/],
    ['status unavailable', { result: { status: 'unavailable' } }, /not available yet/],
    ['malformed response', { result: { totally: 'wrong' } }, /not available yet/],
    ['rate limited', { result: { status: 'rate_limited' } }, /allowance/],
    ['busy', { result: { status: 'busy' } }, /still running/],
    ['budget reached', { result: { status: 'budget_reached' } }, /daily budget/],
  ]) {
    const be = mkBe();
    const ai = mkAi(setup);
    const { page, ctx } = await open(1280, be, ai);
    await page.getByTestId('tab-recommended').waitFor();
    await recView(page);
    ok(re.test(await page.getByTestId('recommended-view').innerText()), `${label}: honest message in the Recommended tab`);
    await page.getByTestId('tab-browse').click();
    ok((await page.getByTestId('eligible-list').locator('> li').count()) === 3, `${label}: Browse all eligible tests still works`);
    await ctx.close();
  }
  const be = mkBe();
  const ai = mkAi({ result: { status: 'profile_incomplete', detail: 'too_little_text' } });
  const { page, ctx } = await open(1280, be, ai);
  await recView(page);
  ok(/little more about yourself|assessed/.test(await page.getByTestId('recommended-view').innerText()), 'profile_incomplete with detail too_little_text explains what to do');
  await ctx.close();
}

console.log('\n[D4] The service is only asked with consent AND a complete profile');
{
  const noConsent = mkBe({ consent: false });
  const a1 = mkAi();
  const o1 = await open(1280, noConsent, a1);
  await o1.page.getByTestId('tab-recommended').waitFor();
  await recView(o1.page);
  ok(a1.fnCalls.length === 0 && /Turn on AI personalization/.test(await o1.page.getByTestId('recommended-view').innerText()), 'no consent: the service is NEVER called and Discover points to the profile settings (one canonical consent card)');
  ok((await o1.page.getByTestId('open-consent').getAttribute('href')) === '/profile', 'link to the Profile consent card');
  await o1.ctx.close();
  const notReady = mkBe({ answered: [] });
  const a2 = mkAi();
  const o2 = await open(1280, notReady, a2);
  await o2.page.getByTestId('tab-recommended').waitFor();
  await recView(o2.page);
  ok(a2.fnCalls.length === 0 && /Complete your tester profile first/.test(await o2.page.getByTestId('recommended-view').innerText()), 'participation_ready is false: the service is never called');
  await o2.ctx.close();
}

console.log('\n[D5] Model text is rendered as plain text (no XSS, no links)');
{
  const be = mkBe();
  const evil = '<img src=x onerror=alert(1)> <a href="https://evil.example">click</a> <script>alert(2)</script>';
  const ai = mkAi({ result: RES({ items: [rec(1, 'good', { reason: evil, evidence: [{ quote: evil, relevance: evil }], unsupported_requirements: [evil] })] }) });
  const { page, dialogs, ctx } = await open(1280, be, ai);
  await page.getByTestId('recommended-view').waitFor();
  ok((await page.getByTestId('recommended-view').locator('img, script, a[href*="evil"]').count()) === 0, 'no injected element exists in the Recommended tab');
  ok((await page.getByTestId('rec-why').innerText()).includes('<img src=x'), 'the markup is shown literally as text');
  await new Promise((r) => setTimeout(r, 300));
  ok(dialogs.n === 0, 'nothing executed');
  await ctx.close();
}

// ───────────── Profile: consent withdrawal / deletion go together with AI-derived data ─────────────
console.log('\n[P1] Consent withdrawal erases AI-derived data; the policy about decisions is stated');
{
  const be = mkBe({ answerText: { students_learners: { q1: 'I use apps every single day', q2: 'A small project where I built things', q3: 'Something broke once so I read logs', q4: 'Products that I enjoy testing a lot' } } });
  const ai = mkAi();
  const { page, ctx } = await open(1280, be, ai, '/profile');
  await page.getByTestId('ai-consent-toggle').waitFor();
  const pol = await page.getByTestId('ai-consent-policy').innerText();
  ok(/erases the analysis and recommendations/.test(pol) && /goes back to Pending/.test(pol) && /qualified by an AI assessment/.test(pol) && /still take every\s+open task/.test(pol) && /anonymous account, tester profile, written answers and credits are kept/.test(pol), 'the consent card states exactly what withdrawal does: derived data erased, AI-qualified categories return to Pending, open tasks / account / answers / credits kept');
  await page.getByTestId('ai-consent-toggle').click();
  await page.getByTestId('ai-consent-state').filter({ hasText: 'OFF' }).waitFor();
  ok(be.s.consentCalls.at(-1) === false, 'the canonical consent RPC (set_ai_consent) was called with granted=false');
  ok(ai.deletes === 1, 'and delete_my_ai_data() erased the AI-derived data right away');
  await page.getByTestId('ai-consent-toggle').click();
  await page.getByTestId('ai-consent-state').filter({ hasText: 'ON for your profile' }).waitFor();
  ok(ai.deletes === 1 && be.s.consentCalls.at(-1) === true, 'turning it ON again does not delete anything');
  await page.getByTestId('delete-experience-btn').click();
  await page.getByTestId('confirm-delete-experience').click();
  await page.getByTestId('experience-deleted').waitFor();
  ok(ai.deletes === 2, 'deleting my written answers also erases what the AI derived from them');
  await ctx.close();
}

console.log('\n[P2] Professional assessment: the browser only ASKS, the server decides');
{
  const be = mkBe({ tester: tester(['tech_savvy', 'students_learners']), answered: ['tech_savvy', 'students_learners'] });
  const ai = mkAi({ assess: (b) => { b.s.qualified.add('tech_savvy'); return ASSESS([assessRow('tech_savvy', 'qualified')]); } });
  const { page, errors, ctx } = await open(1280, be, ai, '/profile');
  await page.getByTestId('assessment-panel').waitFor();
  const pt = await page.getByTestId('assessment-panel').innerText();
  ok(/Tech-Savvy Users is waiting for an assessment/.test(pt) && /still take every open task/.test(pt), 'a pending professional category shows the panel (and says open tasks stay available)');
  const pr = await page.getByTestId('assessment-principles').innerText();
  ok(/do not need a degree/.test(pr) && /only write what is true/.test(pr) && /not a verification of any credential/.test(pr), 'transparent principles: no degree/title/employer needed, only write what is true, self-reported not verified');
  ok(ai.fnCalls.length === 0, 'a page load never starts an assessment: no request until the tester saves answers or asks');
  await page.screenshot({ path: SHOTS + '/ai-assessment-panel.png', fullPage: true });
  await page.getByTestId('assess-run').click();
  await page.locator('[data-testid="assess-tech_savvy"][data-state="qualified"]').waitFor();
  ok(JSON.stringify(ai.fnCalls[0].body) === '{"action":"assess"}', 'the request is only {"action":"assess"}: no category, no status, no decision');
  const rt = await page.getByTestId('assess-tech_savvy').innerText();
  ok(/Qualified \(self-reported\)/.test(rt) && /self-reported answers, not on verified professional credentials/.test(rt), 'the result is labelled self-reported, not verified');
  const activated = await page.waitForFunction(() => document.querySelector('[data-testid="status-tech_savvy"]')?.getAttribute('data-state') === 'active', null, { timeout: 5000 }).then(() => true).catch(() => false);
  ok(activated, 'the profile reloaded and the category pill shows ACTIVE (the state comes from the server record, not from the AI response)');
  ok(noise(errors).length === 0, 'no console errors', errors.join(' | '));
  await ctx.close();

  for (const [label, resp, re] of [
    ['needs clarification', ASSESS([assessRow('tech_savvy', 'needs_clarification', { clarification_questions: ['Which tools did you use?', 'What did you build yourself?'] })]), /Needs clarification/],
    ['not qualified (kind)', ASSESS([assessRow('tech_savvy', 'not_qualified', { message: 'We could not yet see hands-on experience. That is fine: you can still take open tasks. This is based on your self-reported answers.' })]), /Not qualified yet/],
    ['pending (error)', ASSESS([assessRow('tech_savvy', 'pending')]), /Pending/],
    ['rate limited', ASSESS([], 'rate_limited'), /allowance/],
    ['unavailable', ASSESS([], 'unavailable'), /not available right now/],
  ]) {
    const be2 = mkBe({ tester: tester(['tech_savvy']), answered: ['tech_savvy'] });
    const ai2 = mkAi({ assess: resp });
    const t = await open(1280, be2, ai2, '/profile');
    await t.page.getByTestId('assess-run').click();
    while (ai2.fnCalls.length === 0) await new Promise((r) => setTimeout(r, 50));
    await t.page.getByTestId('assess-run').filter({ hasText: 'Check again' }).waitFor(); // the request finished
    await t.page.getByTestId('assessment-panel').getByText(re).first().waitFor();
    ok(true, `${label}: shown honestly`);
    if (label === 'needs clarification') {
      ok((await t.page.getByTestId('assess-clarify').locator('li').count()) === 2 && (await t.page.getByTestId('assess-tech_savvy').getByText('What we look for').count()) === 1, 'clarification: neutral follow-up questions and the public criteria are shown');
    }
    if (label.startsWith('not qualified')) {
      ok(/open tasks/.test(await t.page.getByTestId('assess-tech_savvy').innerText()) && !/fail|reject/i.test(await t.page.getByTestId('assess-tech_savvy').innerText()), 'not qualified: kind wording, no failure language, open tasks still available');
    }
    await t.ctx.close();
  }
  // hidden when there is nothing to assess / no consent
  const noPending = mkBe({ tester: tester(['students_learners']) });
  const t1 = await open(1280, noPending, mkAi(), '/profile');
  await t1.page.getByTestId('ai-consent-toggle').waitFor();
  ok((await t1.page.getByTestId('assessment-panel').count()) === 0, 'only general categories: no assessment panel (general categories are never assessed)');
  await t1.ctx.close();
  const noConsent = mkBe({ tester: tester(['tech_savvy']), answered: ['tech_savvy'], consent: false });
  const t2 = await open(1280, noConsent, mkAi(), '/profile');
  await t2.page.getByTestId('ai-consent-toggle').waitFor();
  ok((await t2.page.getByTestId('assessment-panel').count()) === 0, 'without consent the panel is not shown');
  await t2.ctx.close();
}

console.log('\n[P3] Automatic assessment after saving four answers (only with consent), clear states, no repeats')
{
  const answerAll = async (page, cat) => {
    const panel = page.getByTestId('experience-' + cat);
    await panel.getByTestId('answer-q1').waitFor();
    const texts = ['I use Python, git and VS Code every day for my own projects.', 'I built a small Flask API for my football league and deployed it.', 'The site returned errors, I read the logs and fixed an environment variable.', 'I enjoy testing developer tools and web apps because I use them daily.'];
    for (const [i, t] of texts.entries()) await panel.getByTestId('answer-q' + (i + 1)).fill(t);
    await panel.getByTestId('save-answers').click();
    await panel.getByTestId('experience-saved').waitFor();
  };
  const stateOf = (page, cat) => page.getByTestId('assess-state-' + cat).innerText();

  // 1. consent ON: saving starts ONE automatic check, no click needed; Processing is shown, then Qualified
  const be = mkBe({ tester: tester(['tech_savvy', 'students_learners']), answered: ['students_learners'] });
  const ai = mkAi({ delay: 700, assess: (b) => { b.s.qualified.add('tech_savvy'); return ASSESS([assessRow('tech_savvy', 'qualified')]); } });
  const t = await open(1280, be, ai, '/profile?answers=tech_savvy');
  await answerAll(t.page, 'tech_savvy');
  await t.page.locator('[data-testid="assess-tech_savvy"][data-state="processing"]').waitFor({ timeout: 4000 });
  ok(/Processing/.test(await stateOf(t.page, 'tech_savvy')), 'while the check runs the category shows PROCESSING');
  await t.page.screenshot({ path: SHOTS + '/ai-assessment-processing.png', fullPage: true });
  await t.page.locator('[data-testid="assess-tech_savvy"][data-state="qualified"]').waitFor({ timeout: 6000 });
  ok(/Qualified/.test(await stateOf(t.page, 'tech_savvy')), 'then QUALIFIED (self-reported)');
  ok(ai.fnCalls.length === 1 && JSON.stringify(ai.fnCalls[0].body) === '{"action":"assess"}', 'exactly ONE automatic request, carrying only {"action":"assess"} (no category, hash, status or consent flag from the browser)');
  await t.page.waitForFunction(() => document.querySelector('[data-testid="status-tech_savvy"]')?.getAttribute('data-state') === 'active', null, { timeout: 5000 });
  ok(true, 'the category pill is ACTIVE because the reloaded server state says so');
  await t.page.screenshot({ path: SHOTS + '/ai-assessment-qualified.png', fullPage: true });
  // a page reload never repeats a paid request
  await t.page.reload();
  await t.page.getByTestId('ai-consent-toggle').waitFor();
  await new Promise((r) => setTimeout(r, 600));
  ok(ai.fnCalls.length === 1, 'reloading the page does NOT start another assessment');
  ok(noise(t.errors).length === 0, 'no console errors', t.errors.join(' | '));
  await t.ctx.close();

  // 2. needs clarification: shown clearly; a reload does not call again; the manual button does
  const be2 = mkBe({ tester: tester(['business_office']), answered: [] });
  const ai2 = mkAi({ assess: ASSESS([assessRow('business_office', 'needs_clarification', { clarification_questions: ['Which tools do you use daily?'] })]) });
  const t2 = await open(1280, be2, ai2, '/profile?answers=business_office');
  await answerAll(t2.page, 'business_office');
  await t2.page.locator('[data-testid="assess-business_office"][data-state="needs_clarification"]').waitFor({ timeout: 6000 });
  ok(/Needs clarification/.test(await stateOf(t2.page, 'business_office')) && (await t2.page.getByTestId('assess-clarify').locator('li').count()) === 1, 'NEEDS CLARIFICATION is shown with the follow-up question');
  ok((await t2.page.getByTestId('status-business_office').getAttribute('data-state')) === 'pending_assessment', 'and the category itself stays Pending (nothing was invented)');
  await t2.page.reload();
  await t2.page.getByTestId('assess-run').waitFor();
  await new Promise((r) => setTimeout(r, 600));
  ok(ai2.fnCalls.length === 1 && /Pending/.test(await stateOf(t2.page, 'business_office')), 'after a reload the category shows PENDING and no extra request was made');
  await t2.page.getByTestId('assess-run').click();
  await t2.page.waitForFunction(() => document.querySelector('[data-testid="assess-business_office"]')?.getAttribute('data-state') === 'needs_clarification');
  ok(ai2.fnCalls.length === 2, 'the manual "Check again" button asks once more');
  await t2.ctx.close();

  // 3. consent OFF: saving never calls the AI; turning consent on afterwards checks the waiting category once
  const be3 = mkBe({ tester: tester(['tech_savvy']), answered: [], consent: false });
  const ai3 = mkAi({ assess: (b) => { b.s.qualified.add('tech_savvy'); return ASSESS([assessRow('tech_savvy', 'qualified')]); } });
  const t3 = await open(1280, be3, ai3, '/profile?answers=tech_savvy');
  await answerAll(t3.page, 'tech_savvy');
  await new Promise((r) => setTimeout(r, 600));
  ok(ai3.fnCalls.length === 0 && (await t3.page.getByTestId('assessment-panel').count()) === 0, 'consent OFF: saving four answers sends NOTHING to the AI service and shows no assessment panel');
  ok(/allow AI processing/.test(await t3.page.getByTestId('experience-saved').innerText()), 'the tester is told that AI processing must be allowed for the assessment');
  await t3.page.getByTestId('ai-consent-toggle').click();
  await t3.page.locator('[data-testid="assess-tech_savvy"][data-state="qualified"]').waitFor({ timeout: 6000 });
  ok(ai3.fnCalls.length === 1, 'turning AI processing ON checks the waiting professional category once, automatically');
  await t3.ctx.close();

  // 4. a general category never triggers an assessment
  const be4 = mkBe({ tester: tester(['students_learners']), answered: [] });
  const ai4 = mkAi();
  const t4 = await open(1280, be4, ai4, '/profile?answers=students_learners');
  await answerAll(t4.page, 'students_learners');
  await new Promise((r) => setTimeout(r, 600));
  ok(ai4.fnCalls.length === 0 && (await t4.page.getByTestId('status-students_learners').getAttribute('data-state')) === 'active', 'a general category becomes active on its answers alone and is never assessed');
  await t4.ctx.close();

  // 5. several professional categories: each shown with its own state
  const be5 = mkBe({ tester: tester(['tech_savvy', 'founders_builders', 'business_office']), answered: ['tech_savvy', 'founders_builders', 'business_office'] });
  const ai5 = mkAi({ assess: (b) => { b.s.qualified.add('tech_savvy'); return ASSESS([assessRow('tech_savvy', 'qualified'), assessRow('founders_builders', 'needs_clarification', { clarification_questions: ['What did you build yourself?'] }), assessRow('business_office', 'not_qualified')]); } });
  const t5 = await open(1280, be5, ai5, '/profile');
  await t5.page.getByTestId('assess-run').click();
  await t5.page.locator('[data-testid="assess-business_office"][data-state="not_qualified"]').waitFor();
  ok(/Qualified/.test(await stateOf(t5.page, 'tech_savvy')) && /Needs clarification/.test(await stateOf(t5.page, 'founders_builders')) && /Not qualified yet/.test(await stateOf(t5.page, 'business_office')), 'three professional categories each show their own independent state');
  await t5.ctx.close();

  // 6. withdrawing consent: AI-qualified category goes back to Pending, open tasks stay
  const be6 = mkBe({ tester: tester(['tech_savvy', 'students_learners']), answered: ['tech_savvy', 'students_learners'], qualified: ['tech_savvy'] });
  const ai6 = mkAi();
  const t6 = await open(1280, be6, ai6, '/profile');
  await t6.page.getByTestId('ai-consent-toggle').waitFor();
  ok((await t6.page.getByTestId('status-tech_savvy').getAttribute('data-state')) === 'active', 'precondition: the professional category is active');
  await t6.page.getByTestId('ai-consent-toggle').click();
  await t6.page.getByTestId('ai-consent-state').filter({ hasText: 'OFF' }).waitFor();
  await t6.page.waitForFunction(() => document.querySelector('[data-testid="status-tech_savvy"]')?.getAttribute('data-state') === 'pending_assessment', null, { timeout: 5000 });
  ok(true, 'after withdrawal the professional category shows PENDING again (the server removed the decision)');
  ok((await t6.page.getByTestId('status-students_learners').getAttribute('data-state')) === 'active' && /open task|Every open task|every open task/i.test(await body(t6.page)), 'the general category stays active and open tasks are still offered');
  ok(ai6.fnCalls.length === 0 && ai6.deletes === 1, 'withdrawing sends nothing to the AI service and erases the AI-derived data');
  await t6.ctx.close();
}

console.log('\n[M1] Mobile layout');
{
  const be = mkBe();
  const ai = mkAi({ result: RES({ items: [rec(1, 'strong')] }) });
  const { page, ctx } = await open(375, be, ai);
  await page.getByTestId('recommended-view').waitFor();
  await page.screenshot({ path: SHOTS + '/ai-discover-mobile.png', fullPage: true });
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no horizontal overflow at 375px');
  await ctx.close();
}

console.log('\n[F0] Flag off (default build): the app is exactly as before');
{
  const be = mkBe({ tester: tester(['tech_savvy']), answered: ['tech_savvy'] });
  const ai = mkAi({ result: RES({ items: [rec(1)] }) });
  const t = await open(1280, be, ai, '/discover', OFF);
  await t.page.getByTestId('tab-recommended').waitFor();
  await recView(t.page);
  ok(/not available yet/.test(await t.page.getByTestId('recommended-view').innerText()), 'Discover says personalization is not available (their original behaviour)');
  await t.page.goto(OFF + '/profile');
  await t.page.getByTestId('ai-consent-toggle').waitFor();
  ok((await t.page.getByTestId('assessment-panel').count()) === 0, 'no assessment panel');
  await t.page.getByTestId('ai-consent-toggle').click();
  await t.page.getByTestId('ai-consent-state').filter({ hasText: 'OFF' }).waitFor();
  ok(ai.fnCalls.length === 0 && ai.deletes === 0, 'not a single AI request and no AI RPC (not even a withdrawal erase)');
  ok(t.errors.length === 0, 'zero console errors (not even a 404)', t.errors.join(' | '));
  await t.ctx.close();
}

console.log('\n[C1] No secrets in the shipped bundle');
{
  const t = await newPage(browser, 1280);
  const be = createBackend({ feed: feed(), pages: {} });
  await be.install(t.ctx);
  const srcs = [];
  t.page.on('response', (r) => { if (/[.]js([?]|$)/.test(r.url())) srcs.push(r.url()); });
  await t.page.goto(ENV + '/discover');
  await t.page.locator('body').waitFor();
  await new Promise((r) => setTimeout(r, 500));
  let all = '';
  for (const u of new Set(srcs)) all += await (await fetch(u)).text();
  ok(all.length > 1000, 'bundle inspected', String(all.length));
  ok(!/OPENAI_API_KEY|sk-proj-|sk-[A-Za-z0-9]{20,}|SUPABASE_SERVICE_ROLE_KEY|AI_MATCHING_ENABLED|AI_ASSESSMENT_ENABLED/.test(all), 'no OpenAI key, service-role key or server-only setting in the browser bundle');
  ok(/ai-match/.test(all) && !/api[.]openai[.]com/.test(all), 'the browser only knows the Edge Function name and never talks to api.openai.com');
  await t.ctx.close();
}

await finish(browser)();
