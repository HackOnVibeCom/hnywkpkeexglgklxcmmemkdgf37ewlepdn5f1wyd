// Shared helpers for the browser suites.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'peerprobe-shots');
mkdirSync(SHOTS, { recursive: true });

export async function launch() {
  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error('No Chrome found. Set CHROME_PATH to a Chrome/Chromium executable.');
  return chromium.launch({ executablePath, headless: true });
}

export function reporter() {
  let pass = 0;
  let fail = 0;
  const ok = (c, n, x = '') => {
    if (c) pass++;
    else fail++;
    console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`);
  };
  const finish = (browser) => async () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    await browser?.close();
    process.exit(fail ? 1 : 0);
  };
  return { ok, finish };
}

/** A new context per page == a fresh incognito profile (empty storage). */
export async function newPage(browser, width, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const dialogs = { n: 0 };
  page.on('dialog', async (d) => {
    dialogs.n++;
    await d.dismiss();
  });
  return { ctx, page, errors, dialogs };
}

export const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns truthy (or the timeout elapses). Returns the final truthiness. */
export async function waitUntil(fn, timeout = 8000, step = 100) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(step);
  }
  return !!(await fn());
}
