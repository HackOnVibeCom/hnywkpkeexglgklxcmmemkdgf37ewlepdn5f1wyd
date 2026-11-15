// Regenerates public/og-image.png (1200x630, the social-share card) from the constants below.
// Needs Chrome + the playwright-core already installed for the browser tests:
//   npm --prefix tests/browser install && node scripts/make-og-image.mjs
// Keep the texts in sync with the og:/twitter: tags in index.html (and the favicon mark in public/favicon.svg).
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'UXBarter'; //                                  <- the product name
const HEADLINE = ['Give feedback.', 'Get feedback.']; //     <- the tagline, one line per row (second row is accented)
const SUBLINE = 'Swap 3-minute usability tests with other founders and developers. Earn credits by helping each other.';
const FOOTER = 'Credit-based peer-to-peer usability testing · No signup';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(pathToFileURL(join(root, 'tests/browser/node_modules/playwright-core/index.mjs')).href);
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => existsSync(p));
if (!chrome) throw new Error('No Chrome found: set CHROME_PATH');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;background:#f8fafc;color:#0f172a;display:flex;flex-direction:column;justify-content:space-between;padding:68px 80px}
  .brand{display:flex;align-items:center;gap:20px;font-size:42px;font-weight:800;letter-spacing:-0.5px}
  .logo{width:68px;height:68px;border-radius:17px;background:#4f46e5;display:grid;place-items:center}
  h1{font-size:104px;line-height:1.02;font-weight:800;letter-spacing:-3px}
  h1 span{color:#4f46e5}
  .sub{font-size:31px;line-height:1.35;color:#334155;max-width:900px;margin-top:26px}
  .foot{font-size:26px;color:#64748b}
</style>
<div class="brand"><div class="logo"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m8 4-4 4 4 4"/><path d="M4 8h16"/><path d="m16 20 4-4-4-4"/><path d="M20 16H4"/></svg></div>${esc(NAME)}</div>
<div><h1>${esc(HEADLINE[0])}<br><span>${esc(HEADLINE[1])}</span></h1><p class="sub">${esc(SUBLINE)}</p></div>
<div class="foot">${esc(FOOTER)}</div>`;

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html);
writeFileSync(join(root, 'public/og-image.png'), await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } }));
await browser.close();
console.log('wrote public/og-image.png');
