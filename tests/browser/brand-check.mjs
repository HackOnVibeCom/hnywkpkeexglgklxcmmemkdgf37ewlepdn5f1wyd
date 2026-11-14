// Brand consistency in real Chrome: on every screen (desktop + 360px) the visible text, accessible labels, document
// title, share prompts and the copied results message must say "UXBarter" and never the old name, and the favicon must be
// the new mark. Run directly:  node tests/browser/brand-check.mjs   (stub API; builds the app into a temp dir)
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CAMP_ID, createBackend, dashCampaign, iso } from './stub.mjs';
import { SHOTS, launch, newPage, overflowX, reporter } from './lib.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = mkdtempSync(join(tmpdir(), 'uxb-brand-'));
const build = (dir, key) => execFileSync(process.execPath, [join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'error'], {
  cwd: repo, stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: 'https://testproj.supabase.co', VITE_SUPABASE_ANON_KEY: 'sb_publishable_stubbed_browser_tests_key', VITE_TURNSTILE_SITE_KEY: key },
});
const dirPlain = join(out, 'plain'), dirCap = join(out, 'cap');
build(dirPlain, ''); build(dirCap, '1x00000000000000000000AA');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const serve = (dir) => new Promise((res) => {
  const server = createServer((req, r) => {
    const p = new URL(req.url, 'http://x').pathname; let f = join(dir, p);
    if (!(existsSync(f) && statSync(f).isFile())) f = join(dir, 'index.html');
    r.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }); r.end(readFileSync(f));
  });
  server.listen(0, '127.0.0.1', () => res({ server, url: `http://127.0.0.1:${server.address().port}` }));
});
const A = await serve(dirPlain), B = await serve(dirCap);

const browser = await launch();
const { ok, finish } = reporter();
const OLD = /peer\s*-?\s*probe/i;
const done = dashCampaign({ id: 'c1', status: 'completed', response_count: 1, completed_at: iso(Date.now()) });
const mkBe = () => createBackend({ balance: 2, dashCampaigns: [done], submissions: [{ id: 's1', campaign_id: 'c1', task_completed: true, friction: 'Great flow but the export button is hidden in a submenu of the toolbar.', suggestion: 'Move it.', ux_rating: 4, share_consent: true, created_at: iso(Date.now()) }] });

async function sweep(width) {
  const be = mkBe();
  const { ctx, page } = await newPage(browser, width, 900);
  await be.install(ctx);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: A.url });
  const seen = [];
  for (const path of ['/', '/discover', '/create', '/dashboard', '/test/' + CAMP_ID, '/nope']) {
    await page.goto(A.url + path);
    await page.waitForTimeout(700);
    const body = await page.locator('body').innerText();
    const labels = await page.evaluate(() => [...document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')].map((e) => ['aria-label', 'title', 'alt', 'placeholder'].map((a) => e.getAttribute(a)).filter(Boolean).join(' ')).join(' | '));
    seen.push({ path, body, labels, title: await page.title() });
    if (path === '/' || path === '/dashboard') await page.screenshot({ path: `${SHOTS}/brand-${width}-${path === '/' ? 'landing' : 'dashboard'}.png`, fullPage: true });
    if (path === '/') ok(!(await overflowX(page)), `[${width}px] landing: no horizontal overflow`);
    if (path === '/dashboard') ok(!(await overflowX(page)), `[${width}px] dashboard (invite + results cards): no horizontal overflow`);
  }
  ok(seen.every((s) => !OLD.test(s.body) && !OLD.test(s.labels) && !OLD.test(s.title)), `[${width}px] no old name in visible text, labels or title on / /discover /create /dashboard /test /404`, seen.filter((s) => OLD.test(s.body + s.labels + s.title)).map((s) => s.path).join(','));
  const landing = seen[0];
  ok(landing.body.includes('UXBarter is a credit-based, peer-to-peer') && landing.body.includes('Give feedback. Get feedback.'), `[${width}px] landing says UXBarter + the tagline`);
  ok((await page.getByRole('link', { name: 'UXBarter home' }).count()) === 1, `[${width}px] header logo link has the accessible name "UXBarter home"`);
  ok(seen.every((s) => s.title === 'UXBarter — Give feedback. Get feedback.'), `[${width}px] document title on every route`);
  ok(seen.every((s) => s.body.includes('UXBarter has no accounts.')), `[${width}px] footer says UXBarter on every route`);
  const dash = seen.find((s) => s.path === '/dashboard');
  ok(/tested by other founders on uxbarter/i.test(dash.body), // the label is upper-cased by CSS
    `[${width}px] results card is branded`);
  // what actually gets shared / copied
  await page.goto(A.url + '/dashboard');
  await page.getByText('Share your results').waitFor();
  const copyBtns = page.getByRole('button', { name: /copy/i });
  const links = await page.locator('a[href*="twitter.com/intent/tweet"], a[href*="linkedin.com"]').evaluateAll((as) => as.map((a) => decodeURIComponent(a.href)));
  ok(links.length >= 2 && links.every((l) => !OLD.test(l)) && links.some((l) => l.includes('UXBarter')), `[${width}px] X/LinkedIn share links carry the new name`, links.join(' | ').slice(0, 200));
  let copied = '';
  if (await copyBtns.count()) { await copyBtns.first().click(); copied = await page.evaluate(() => navigator.clipboard.readText()); }
  ok(copied.includes('UXBarter') && !OLD.test(copied), `[${width}px] copied results message names UXBarter`, copied.slice(0, 160));
  await ctx.close();
}
await sweep(1280);
await sweep(360);

// first-visit loading screen + invitation note + failure messages (Turnstile build)
{
  const be = mkBe();
  const { ctx, page } = await newPage(browser, 1280, 900);
  await be.install(ctx);
  await ctx.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: "window.turnstile={render(){return 'w'},reset(){},remove(){}};" }));
  await page.goto(B.url + '/discover');
  await page.getByTestId('captcha-hint').waitFor();
  ok(!OLD.test(await page.locator('body').innerText()), 'loading screen (pending human check): no old name');
  await ctx.close();
  const c2 = await newPage(browser, 1280, 900); await mkBe().install(c2.ctx);
  await c2.page.goto(A.url + '/?ref=abcdef123456');
  await c2.page.getByTestId('invited-note').waitFor();
  ok(!OLD.test(await c2.page.locator('body').innerText()), 'invited-visitor landing: no old name');
  await c2.ctx.close();
}
// static metadata + assets
const html = readFileSync(join(dirPlain, 'index.html'), 'utf8');
const meta = {}; for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) meta[m[1]] = m[2];
ok(meta['og:site_name'] === 'UXBarter' && meta['og:title'] === 'UXBarter — Give feedback. Get feedback.' && meta['twitter:title'] === meta['og:title'], 'og:site_name / og:title / twitter:title = UXBarter — Give feedback. Get feedback.');
ok(meta['og:description'] === meta['twitter:description'] && /credit-based, peer-to-peer usability testing exchange/.test(meta['og:description']) && meta['og:description'].length <= 220, `og/twitter descriptions identical and explanatory (${meta['og:description'].length} chars)`);
ok(['og:url', 'og:image', 'twitter:image'].every((k) => meta[k].startsWith('https://peerprobe.vercel.app/')), 'og:url, og:image, twitter:image use the preserved production host');
ok(/<link rel="canonical" href="https:\/\/peerprobe\.vercel\.app\/"/.test(html) && /<title>UXBarter — Give feedback\. Get feedback\.<\/title>/.test(html), '<title> and canonical link');
ok(!OLD.test(html.replace(/https:\/\/peerprobe\.vercel\.app\/[A-Za-z.-]*/g, '').replace(/peerprobe\.vercel\.app/g, '')), 'index.html mentions the old name only inside the preserved hostname');
const png = readFileSync(join(repo, 'public', 'og-image.png'));
ok(png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630 && meta['og:image:width'] === '1200' && meta['og:image:height'] === '630', 'public/og-image.png is 1200x630 and matches og:image:width/height');
const fav = readFileSync(join(repo, 'public', 'favicon.svg'), 'utf8');
ok(fav.includes('<svg') && !fav.includes('<circle'), 'favicon is the new exchange mark (no magnifier circle)');
ok(existsSync(join(dirPlain, 'og-image.png')) && existsSync(join(dirPlain, 'favicon.svg')), 'og-image.png and favicon.svg are shipped in the build');

rmSync(out, { recursive: true, force: true });
A.server.close(); B.server.close();
await finish(browser)();
