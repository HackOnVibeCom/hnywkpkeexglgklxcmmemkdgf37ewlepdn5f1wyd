// AI-personalised Discover in real Chrome against the STUBBED API. The Edge Function and the AI RPCs are stubbed here (no
// OpenAI is ever contacted); what is verified is the UI contract: opt-in, honest empty state, graceful degradation, display of
// server-vetted recommendations as plain text, "Browse all eligible tests" always present, flag-off = unchanged app, no secrets
// in the bundle. The rules themselves are tested in tests/unit/ai-engine.test.mjs and supabase/tests/ai_matching.mjs.
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

const row = (n, name, o = {}) => feedRow({ campaign_id: ID(n), project_name: name, created_at: mins(60 - n), testing_mode: 'open', target_categories: [], ...o });
const feed = () => [
  row(1, 'API Debugger', { description: 'A developer tool for REST APIs' }),
  row(2, 'FreshCart', { description: 'Groceries and recipes' }),
  row(3, 'Secret Targeted Tool', { testing_mode: 'targeted', target_categories: ['tech_savvy'] }), // tester has no screening => not eligible
  row(4, 'PlayHub', { description: 'Game launcher' }),
];
const rec = (n, verdict = 'good', o = {}) => ({
  campaign_id: ID(n), verdict, explanation: `You mention building a Flask API, which is what this product needs (${n}).`,
  evidence: [{ quote: 'I built a Flask API for inventory', relevance: 'Direct hands-on experience.' }], unsupported_requirements: [], ...o,
});
const RES = (o = {}) => ({ status: 'ok', recommendations: [], evaluated: 3, from_cache: false, understanding: { summary: 'The tester reports building APIs.', areas: ['software development'] }, ...o });
const CONSENT_REQUIRED = { status: 'consent_required', recommendations: [], evaluated: 0, from_cache: false, understanding: null };

/**
 * AI stub layered ON TOP of the base stub (later Playwright routes win; everything else falls back).
 * Consent lives here like on the server: the function answers consent_required until set_ai_consent(p_granted:true).
 */
async function installAi(ctx, ai) {
  await ctx.route(HOST + '/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(data) });
    const rpc = p.startsWith('/rest/v1/rpc/') ? p.slice('/rest/v1/rpc/'.length) : null;
    const AIRPC = ['set_ai_consent', 'delete_my_ai_data'];
    if (req.method() === 'OPTIONS' && (p === '/functions/v1/ai-match' || (rpc && AIRPC.includes(rpc)))) return route.fulfill({ status: 204, headers: CORS });
    let b = null;
    try { b = req.postDataJSON(); } catch { /* none */ }
    if (rpc && AIRPC.includes(rpc)) {
      ai.rpcs.push({ rpc, body: b });
      if (rpc === 'set_ai_consent') {
        if (ai.consentError) return send({ code: 'P0001', details: null, hint: null, message: ai.consentError }, 400);
        ai.consent = b.p_granted === true;
        return send({ granted: ai.consent, policy_version: 1, updated_at: iso(Date.now()) });
      }
      return send({ deleted_analyses: 1, deleted_verdicts: 2 });
    }
    if (p === '/functions/v1/ai-match') {
      ai.fnCalls.push({ body: b, auth: req.headers()['authorization'] ?? null });
      if (ai.fn === 'network') return route.abort();
      if (ai.fn === 'error') return send({ error: 'boom' }, 500);
      if (ai.fn === 'missing') return send({ message: 'Function not found' }, 404);
      if (!ai.consent) return send(CONSENT_REQUIRED);
      return send(typeof ai.result === 'function' ? ai.result() : ai.result);
    }
    return route.fallback();
  });
}
const mkAi = (o = {}) => ({ consent: false, result: RES(), fn: 'ok', rpcs: [], fnCalls: [], ...o });
async function open(width, be, ai, path = '/discover') {
  const t = await newPage(browser, width);
  await be.install(t.ctx);
  await installAi(t.ctx, ai);
  await t.page.goto(ENV + path);
  return t;
}
const noise = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));

// ───────────── Discover: opt-in ─────────────
console.log('\n[A1] Not opted in: clear consent, nothing personal is sent');
{
  const be = createBackend({ feed: feed(), tester: tester(['students_learners']), pages: {} });
  const ai = mkAi();
  const { page, errors, ctx } = await open(1280, be, ai);
  await page.getByTestId('ai-optin').waitFor();
  const t = await page.getByTestId('ai-optin').innerText();
  ok(/OpenAI/.test(t) && /do not send your account ID, nickname or sign-in token/.test(t) && /self-reported/.test(t) && /server still decides/.test(t) && /turn this off at any time/.test(t), 'the opt-in explains: OpenAI processes the text, no ids/tokens, self-reported, the server still authorizes, can be turned off');
  ok(/do not write sensitive personal information/.test(t), 'and asks people not to write sensitive personal information');
  ok(ai.fnCalls.length === 1 && JSON.stringify(ai.fnCalls[0].body) === '{"action":"recommend"}' && ai.rpcs.length === 0, 'the only thing the browser sent is the bare {"action":"recommend"} question (the SERVER answers consent_required and never calls the model)');
  ok(await page.getByTestId('browse-all').isVisible() && (await page.locator('ul > li h2').count()) === 4, '"Browse all eligible tests" shows every task as before (incl. the not-eligible one, marked)');
  ok(await page.getByTestId('not-eligible-badge').count() === 1, 'the existing eligibility UI is unchanged');
  ok(noise(errors).length === 0, 'no console errors', errors.join(' | '));
  await ctx.close();
}

console.log('\n[A2] Opt in -> server-vetted recommendations are shown with reasons');
{
  const be = createBackend({ feed: feed(), tester: tester(['students_learners']), pages: {} });
  // the function returns an ineligible campaign and an unknown id too (a buggy/compromised server): the UI must not show them
  const ai = mkAi({ result: RES({ recommendations: [rec(1, 'strong', { unsupported_requirements: ['mobile testing'] }), rec(3, 'good'), { ...rec(2), campaign_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }] }) });
  const { page, errors, dialogs, ctx } = await open(1280, be, ai);
  await page.getByTestId('ai-on').click();
  await page.getByTestId('ai-list').waitFor();
  ok(ai.rpcs.some((r) => r.rpc === 'set_ai_consent' && r.body.p_granted === true), 'consent is recorded through the profile workstream RPC set_ai_consent(p_granted := true)');
  ok(ai.fnCalls.length === 2 && ai.fnCalls.every((c) => JSON.stringify(c.body) === '{"action":"recommend"}'), 'the function is only ever sent {"action":"recommend"} (no user id, no prompt, no model)');
  ok(/^Bearer /.test(ai.fnCalls[1].auth ?? ''), 'with the normal session token (JWT) in Authorization');
  const items = await page.getByTestId('ai-list').locator('> li').count();
  ok(items === 1, 'only the eligible, known campaign is rendered (ineligible Targeted tool and unknown id are dropped by the UI too)', String(items));
  await page.screenshot({ path: SHOTS + '/ai-discover-desktop.png', fullPage: true });
  const card = page.getByTestId('ai-list').locator('> li').first();
  const ct = await card.innerText();
  ok(/Strong match/.test(ct) && /API Debugger/.test(ct), 'verdict badge + campaign name');
  ok(/You mention building a Flask API/.test(ct) && /From your profile: .*I built a Flask API for inventory/.test(ct), 'explanation and the verbatim quote from the tester\'s own profile are shown');
  ok(/Not clearly covered by your profile: mobile testing/.test(ct), 'unsupported requirements are shown honestly');
  ok(/AI-suggested/.test(await body(page)) && /Not verified/.test(await body(page)), 'labelled as AI-suggested and not verified');
  ok(await page.getByTestId('ai-understanding').isVisible(), 'shows what was understood from the profile');
  ok((await card.getByRole('link', { name: 'Start test' }).getAttribute('href')) === `/test/${ID(1)}`, 'Start goes to the normal test page (server authorizes there)');
  ok((await page.getByTestId('ai-list').innerText()).includes('Secret') === false, 'the ineligible Targeted campaign is not in the AI block');
  ok((await page.locator('ul > li h2').count()) === 4 && await page.getByTestId('browse-all').isVisible(), 'the full browse list is still below');
  ok(dialogs.n === 0 && noise(errors).length === 0, 'no dialogs, no console errors', errors.join(' | '));
  await page.reload();
  await page.getByTestId('ai-list').waitFor();
  ok(ai.fnCalls.length === 3, 'on reload the function is asked again (the SERVER decides whether that costs anything: cached)');
  await ctx.close();
}

console.log('\n[A3] Honest empty state, browse option stays');
{
  const be = createBackend({ feed: feed(), tester: tester(['students_learners']), pages: {} });
  const ai = mkAi({ consent: true, result: RES({ recommendations: [] }) });
  const { page, ctx } = await open(1280, be, ai);
  await page.getByTestId('ai-empty').waitFor();
  const t = await page.getByTestId('ai-empty').innerText();
  ok(/No highly relevant tests found yet\./.test(t), 'exact empty-state wording');
  ok(await page.getByTestId('ai-list').count() === 0, 'nothing is shown as a filler recommendation');
  ok(await page.getByTestId('browse-all').isVisible() && (await page.locator('ul > li h2').count()) === 4, '"Browse all eligible tests" still lists everything');
  ok((await page.getByRole('link', { name: 'Add more about my experience' }).getAttribute('href')) === '/profile', 'links to the profile where the experience answers live');
  await ctx.close();
}

console.log('\n[A4] Degradation: provider down / rate limit / busy / thin profile / function missing');
{
  for (const [label, setup, expectTid, expectText] of [
    ['function returns 500', { fn: 'error' }, 'ai-unavailable', /not available right now/],
    ['network failure', { fn: 'network' }, 'ai-unavailable', /not available right now/],
    ['function not deployed (404)', { fn: 'missing' }, 'ai-unavailable', /not available right now/],
    ['status unavailable', { result: RES({ status: 'unavailable' }) }, 'ai-unavailable', /not available right now/],
    ['malformed response', { result: { totally: 'wrong' } }, 'ai-unavailable', /not available right now/],
    ['rate limited', { result: RES({ status: 'rate_limited' }) }, 'ai-unavailable', /allowance/],
    ['busy (previous request still running)', { result: RES({ status: 'busy' }) }, 'ai-unavailable', /Still working on your previous request/],
    ['budget reached', { result: RES({ status: 'budget_reached' }) }, 'ai-unavailable', /not available right now/],
    ['thin profile', { result: RES({ status: 'insufficient_profile' }) }, 'ai-insufficient', /Add a few lines/],
  ]) {
    const be = createBackend({ feed: feed(), tester: tester(['students_learners']), pages: {} });
    const ai = mkAi({ consent: true, ...setup });
    const { page, ctx } = await open(1280, be, ai);
    await page.getByTestId(expectTid).waitFor();
    ok(expectText.test(await page.getByTestId(expectTid).innerText()), `${label}: friendly message`);
    ok(await page.getByTestId('browse-all').isVisible() && (await page.locator('ul > li h2').count()) === 4, `${label}: the full list of tests still works`);
    await ctx.close();
  }
}

console.log('\n[A5] Consent errors are shown, nothing breaks');
{
  const be = createBackend({ feed: feed(), tester: tester(['students_learners']), pages: {} });
  const ai = mkAi({ consentError: 'profile_missing' });
  const { page, ctx } = await open(1280, be, ai);
  await page.getByTestId('ai-on').click();
  await page.getByRole('alert').waitFor();
  ok(/account is still being set up/.test(await page.getByRole('alert').innerText()), 'a failing consent RPC shows a friendly error');
  ok(await page.getByTestId('ai-optin').isVisible() && ai.consent === false, 'the opt-in stays and nothing is turned on');
  await ctx.close();
}

console.log('\n[A6] Model/provider text is rendered as plain text (no XSS, no links)');
{
  const be = createBackend({ feed: feed(), tester: tester(['students_learners']), pages: {} });
  const evil = '<img src=x onerror=alert(1)> <a href="https://evil.example">click</a> <script>alert(2)</script>';
  const ai = mkAi({ consent: true, result: RES({ recommendations: [rec(1, 'good', { explanation: evil, evidence: [{ quote: evil, relevance: evil }], unsupported_requirements: [evil] })] }) });
  const { page, dialogs, ctx } = await open(1280, be, ai);
  await page.getByTestId('ai-list').waitFor();
  ok((await page.getByTestId('ai-list').locator('img, script, a[href*="evil"]').count()) === 0, 'no injected element exists in the AI block');
  ok((await page.getByTestId('ai-explanation').innerText()).includes('<img src=x'), 'the markup is shown literally as text');
  await new Promise((r) => setTimeout(r, 300));
  ok(dialogs.n === 0, 'nothing executed');
  await ctx.close();
}

console.log('\n[A7] Turning AI off erases what the AI derived');
{
  const be = createBackend({ feed: feed(), tester: tester(['students_learners']), pages: {} });
  const ai = mkAi({ consent: true, result: RES({ recommendations: [rec(1)] }) });
  const { page, ctx } = await open(1280, be, ai);
  await page.getByTestId('ai-list').waitFor();
  await page.screenshot({ path: SHOTS + '/ai-discover-on.png' });
  await page.getByTestId('ai-off').click();
  await page.getByTestId('ai-optin').waitFor();
  ok(ai.rpcs.some((r) => r.rpc === 'set_ai_consent' && r.body.p_granted === false) && ai.consent === false, 'set_ai_consent(p_granted := false) is called');
  ok(ai.rpcs.some((r) => r.rpc === 'delete_my_ai_data'), 'and delete_my_ai_data() erases the stored analysis and verdicts');
  ok(await page.getByTestId('browse-all').isVisible(), 'browse list unaffected');
  await ctx.close();
}

console.log('\n[A8] Mobile layout');
{
  const be = createBackend({ feed: feed(), tester: tester(['students_learners']), pages: {} });
  const ai = mkAi({ consent: true, result: RES({ recommendations: [rec(1, 'strong')] }) });
  const { page, ctx } = await open(375, be, ai);
  await page.getByTestId('ai-list').waitFor();
  await page.screenshot({ path: SHOTS + '/ai-discover-mobile.png', fullPage: true });
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no horizontal overflow at 375px');
  await ctx.close();
}

console.log('\n[A0] Flag off (default build): the app is exactly as before');
{
  const be = createBackend({ feed: feed(), tester: tester(['students_learners']), pages: {} });
  const ai = mkAi({ consent: true, result: RES({ recommendations: [rec(1)] }) });
  const t = await newPage(browser, 1280);
  await be.install(t.ctx);
  await installAi(t.ctx, ai);
  await t.page.goto(OFF + '/discover');
  await t.page.locator('ul > li h2').first().waitFor();
  await new Promise((r) => setTimeout(r, 400));
  ok((await t.page.locator('ul > li h2').count()) === 4 && (await t.page.getByTestId('ai-recs').count()) === 0 && (await t.page.getByTestId('browse-all').count()) === 0, 'no AI block, no extra heading');
  ok(ai.rpcs.length === 0 && ai.fnCalls.length === 0, 'and not a single AI request is made');
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
  await t.page.getByTestId('ai-recs').waitFor().catch(() => undefined);
  let all = '';
  for (const u of new Set(srcs)) all += await (await fetch(u)).text();
  ok(all.length > 1000, 'bundle inspected', String(all.length));
  ok(!/OPENAI_API_KEY|sk-proj-|sk-[A-Za-z0-9]{20,}|SUPABASE_SERVICE_ROLE_KEY|AI_MATCHING_ENABLED/.test(all), 'no OpenAI key, service-role key or server-only setting in the browser bundle');
  ok(/ai-match/.test(all) && !/api[.]openai[.]com/.test(all), 'the browser only knows the Edge Function name and never talks to api.openai.com');
  await t.ctx.close();
}

await finish(browser)();
