// Would the candidate Content-Security-Policy break any screen? Builds the app (stub env + Turnstile test key), serves it
// with the CSP ENFORCED, drives the main flows in real Chrome against the stub API, and fails on ANY violation raised by
// our own page. Run directly:  node tests/browser/csp-check.mjs   (not part of `npm run test:browser`)
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CAMP_ID, createBackend, dashCampaign, iso } from './stub.mjs';
import { launch, newPage, reporter } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const SUPABASE_ORIGIN = 'https://testproj.supabase.co'; // the stub stands in for https://<project-ref>.supabase.co
// The policy under test is the one vercel.json actually sends (Report-Only today). Only the Supabase origin is swapped
// for the stub's, so the test can never drift from what is deployed.
const vercel = JSON.parse(readFileSync(join(repo, 'vercel.json'), 'utf8'));
const header = vercel.headers.flatMap((h) => h.headers).find((h) => /^Content-Security-Policy/i.test(h.key));
if (!header) throw new Error('vercel.json has no Content-Security-Policy[-Report-Only] header');
const REAL_ORIGIN = header.value.split(' ').map((t) => t.replace(';', '')).find((t) => t.startsWith('https://') && t.endsWith('.supabase.co'));
if (!REAL_ORIGIN) throw new Error('no Supabase origin in the policy');
export const CSP = header.value.replace(REAL_ORIGIN, SUPABASE_ORIGIN);

const out = mkdtempSync(join(tmpdir(), 'pp-csp-'));
execFileSync(process.execPath, [join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
  cwd: repo,
  env: { ...process.env, VITE_SUPABASE_URL: SUPABASE_ORIGIN, VITE_SUPABASE_ANON_KEY: 'sb_publishable_stubbed_browser_tests_key', VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' },
  stdio: 'inherit',
});
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  let f = join(out, p);
  if (!(existsSync(f) && statSync(f).isFile())) f = join(out, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream', 'Content-Security-Policy': CSP });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await launch();
const { ok, finish } = reporter();
const FAKE_OK = `window.turnstile = { render(el, o) { setTimeout(() => o.callback('TURNSTILE-TEST-TOKEN'), 40); return 'w1'; }, reset() {}, remove() {} };`;

const done = dashCampaign({ id: 'c1', status: 'completed', response_count: 1, completed_at: iso(Date.now()) });
const be = createBackend({ balance: 2, dashCampaigns: [done], submissions: [{ id: 's1', campaign_id: 'c1', task_completed: true, friction: 'Great flow but the export button is hidden in a submenu of the toolbar.', suggestion: 'Move it.', ux_rating: 4, share_consent: true, created_at: iso(Date.now()) }] });
const { ctx, page } = await newPage(browser, 1280, 900);
await be.install(ctx);
await ctx.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_OK }));
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const violations = [];
page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => violations.push('pageerror: ' + e.message));

console.log('CSP under test:\n  ' + CSP.replace(/; /g, '\n  ') + '\n');
await page.goto(BASE + '/discover');
await page.getByText('Acme Invoicing').waitFor({ timeout: 20000 });
ok(true, 'first visit: Turnstile script + token + anonymous sign-in work under the CSP');
await page.goto(BASE + '/dashboard');
await page.getByText('Share your results').waitFor({ timeout: 20000 });
ok(await page.getByTestId('proof-card').isVisible(), 'dashboard: results/proof card renders');
await page.getByRole('button', { name: /copy/i }).first().click().catch(() => {});
await page.goto(BASE + '/create');
await page.getByText(/Request a test/i).first().waitFor();
ok(true, 'create page renders');
await page.goto(BASE + '/test/' + CAMP_ID);
await page.waitForTimeout(1200);
ok((await page.locator('body').innerText()).length > 100, 'test page renders');
ok(violations.length === 0, 'no Content-Security-Policy violation raised by our page on any screen', violations.join(' | '));
rmSync(out, { recursive: true, force: true });
server.close();
await finish(browser)();
