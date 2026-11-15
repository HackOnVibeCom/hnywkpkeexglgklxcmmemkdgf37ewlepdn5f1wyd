// Orchestrator: builds the app twice into temp dirs (1: no Supabase env -> "Backend not configured",
// 2: stub env pointing at https://testproj.supabase.co, which the suites intercept), serves both
// with a Cloudflare-Pages-like SPA fallback, then runs the suites against them in real Chrome.
//
// Run from the repo root:  npm run test:browser
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'peerprobe-browser-'));

const vite = await import(pathToFileURL(join(root, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);

async function buildApp(name, env) {
  const outDir = join(tmp, name);
  // process.env wins over .env.local in Vite's loadEnv, so a developer's real keys can never leak into
  // these test bundles (and the "no env" build is really unconfigured).
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    await vite.build({ root, mode: 'production', logLevel: 'error', build: { outDir, emptyOutDir: true } });
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return outDir;
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serve(dir) {
  return new Promise((res) => {
    const server = createServer(async (req, resp) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
      let file = join(dir, path);
      try {
        if (!(await stat(file)).isFile()) throw new Error('not a file');
      } catch {
        file = join(dir, 'index.html'); // SPA fallback, like Cloudflare Pages _redirects
      }
      try {
        const data = await readFile(file);
        resp.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        resp.end(data);
      } catch {
        resp.writeHead(500);
        resp.end('error');
      }
    });
    server.listen(0, '127.0.0.1', () => res({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

console.log('Building app (no env)…');
const dirNo = await buildApp('noenv', { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', VITE_TURNSTILE_SITE_KEY: '' });
console.log('Building app (stub env)…');
const dirEnv = await buildApp('env', {
  VITE_SUPABASE_URL: 'https://testproj.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_stubbed_browser_tests_key',
  VITE_TURNSTILE_SITE_KEY: '', // Turnstile OFF: sign-in must work exactly as before
});
console.log('Building app (stub env + Turnstile site key)…');
const dirCap = await buildApp('captcha', {
  VITE_SUPABASE_URL: 'https://testproj.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_stubbed_browser_tests_key',
  VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA', // Cloudflare's public always-pass TEST key
});
const a = await serve(dirNo);
const b = await serve(dirEnv);
const c = await serve(dirCap);

let failed = false;
try {
  for (const suite of ['core-ui.mjs', 'lifecycle-ui.mjs', 'phase2-ui.mjs', 'matching-ui.mjs', 'matching-v2-ui.mjs']) {
    console.log(`\n══════ ${suite} ══════`);
    // Async spawn: the static servers live in THIS process, so the event loop must stay free.
    const code = await new Promise((res) => {
      const child = spawn(process.execPath, [join(here, suite)], {
        stdio: 'inherit',
        env: { ...process.env, BASE_NOENV: a.url, BASE_ENV: b.url, BASE_CAPTCHA: c.url },
      });
      child.on('exit', (c) => res(c));
    });
    if (code !== 0) failed = true;
  }
} finally {
  a.server.close();
  b.server.close();
  c.server.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? '\nBROWSER TESTS FAILED' : '\nBROWSER TESTS PASSED');
process.exit(failed ? 1 : 0);
