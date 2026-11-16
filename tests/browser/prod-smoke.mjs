// READ-ONLY smoke of a LIVE deployment in real Chrome (no stub, no writes, no sign-in): pages render, no JS errors, no request to the
// AI Edge Function, nothing is sent to OpenAI. Usage:  node tests/browser/prod-smoke.mjs https://uxbarter.vercel.app
// Anonymous identities need the Turnstile check, which only a human can pass: those steps are manual (docs/RELEASE_RUNBOOK.md).
import { launch, newPage, reporter, SHOTS } from './lib.mjs';

const BASE = (process.argv[2] ?? 'https://uxbarter.vercel.app').replace(/\/$/, '');
const browser = await launch();
const { ok, finish } = reporter();

for (const [label, width] of [['desktop', 1280], ['mobile', 375]]) {
  const { ctx, page, errors } = await newPage(browser, width);
  const aiCalls = [];
  const rpc = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/functions\/v1\/ai-match|api\.openai\.com/.test(u)) aiCalls.push(u);
    const m = /\/rest\/v1\/rpc\/([a-z_0-9]+)/.exec(u);
    if (m) rpc.push(m[1]);
  });
  for (const path of ['/', '/discover', '/profile', '/dashboard']) {
    const res = await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    ok(res && res.status() === 200, `[${label}] ${path} answers 200`);
    await page.locator('body').waitFor(); await page.waitForTimeout(2500);
    const text = await page.locator('body').innerText();
    ok(/UXBarter/.test(text) && !/Something went wrong|Application error|undefined is not/i.test(text), `[${label}] ${path} renders the app (no error screen)`);
    ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `[${label}] ${path}: no horizontal overflow`);
  }
  await page.goto(BASE + '/discover', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/prod-discover-${label}.png`, fullPage: true });
  ok(aiCalls.length === 0, `[${label}] no request to the AI function or to OpenAI (flag off)`, aiCalls.join());
  const bad = errors.filter((e) => !/Failed to load resource|Content Security Policy|Report-Only|^%c/i.test(e));
  ok(bad.length === 0, `[${label}] no JavaScript errors`, bad.join(' | '));
  console.log(`    (${label}) RPCs seen without a session: ${[...new Set(rpc)].join(', ') || 'none'}; console messages filtered: ${errors.length - bad.length}`);
  await ctx.close();
}
await finish(browser)();
