// Self-test of scripts/ai-smoke-test.mjs WITHOUT any real OpenAI request: the script is run as a child process against a loopback
// mock of the Responses API and a FAKE key. It proves the script's safety behaviour before the owner ever gives it a real key:
//   dry run is free and needs no key; no real run without both flags; a missing / non-project key is refused; the key can never be
//   sent to a non-loopback host; the key never appears in any output or in the report; every unexpected condition (rejected key,
//   unknown model, rejected schema, cut-off output, rate limit) STOPS the run at once (exit 3); the cost ceiling stops it BEFORE a
//   request that could exceed it; and the whole happy path (probe, assessments, matching, all expectations) works end to end.
//   node tests/unit/smoke-script.test.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const ok = (c, n, x = '') => {
  if (c) pass++;
  else fail++;
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`);
};
const FAKE_KEY = 'sk-proj-FAKEKEYFORSELFTESTONLY0123456789abcdef';

// ---- mock Responses API ------------------------------------------------------------------------------------------
const FAMILIES = {
  dev: /\b(python|fastapi|api|apis|rest|developer|backend|docker|git|postgresql)\b/i,
  game: /\b(game|games|gaming|steam|console)\b/i,
  invoice: /\b(excel|invoice|invoices|invoicing|crm|bookkeeping)\b/i,
  grocery: /\b(grocery|groceries|recipes?|meal)\b/i,
};
const FAMILY_LABEL = { dev: 'software development', game: 'video games', invoice: 'office spreadsheets and invoicing', grocery: 'online shopping' };
const sentences = (t) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
function scripted(name, userText) {
  if (name === 'smoke_probe') return { ok: true, label: 'alpha' };
  if (name === 'tester_experience') {
    const profile = JSON.parse(userText.slice(userText.indexOf('\n') + 1));
    const texts = [profile.bio, ...profile.answers.map((a) => a.answer)].filter(Boolean);
    const areas = [];
    for (const [k, re] of Object.entries(FAMILIES)) {
      const hits = texts.flatMap(sentences).filter((s) => re.test(s));
      if (hits.length) areas.push({ label: FAMILY_LABEL[k], level: 'stated_hands_on', evidence: hits.slice(0, 3).map((s) => s.slice(0, 150)) });
    }
    return { summary: 'The tester reports: ' + areas.map((a) => a.label).join(', '), experience_areas: areas, tools_and_workflows: [], product_domains: [], missing_information: [] };
  }
  if (name === 'campaign_matches') {
    const analysis = JSON.parse(userText.slice(userText.indexOf('\n') + 1, userText.indexOf('\n\nCAMPAIGNS')));
    const campaigns = JSON.parse(userText.slice(userText.indexOf('\n', userText.indexOf('\n\nCAMPAIGNS') + 2) + 1));
    return { matches: campaigns.map((c) => {
      const fam = Object.entries(FAMILIES).filter(([, re]) => re.test(`${c.name} ${c.description} ${c.task}`)).map(([k]) => FAMILY_LABEL[k]);
      const hit = analysis.experience_areas.find((a) => fam.includes(a.label));
      if (!hit) return { ref: c.ref, verdict: 'none', explanation: '', evidence: [], unsupported_requirements: [] };
      return { ref: c.ref, verdict: 'good', explanation: 'You report hands-on work that this product depends on.', evidence: [{ quote: hit.evidence[0], relevance: 'Directly relevant reported experience.' }], unsupported_requirements: [] };
    }) };
  }
  if (name === 'professional_assessment') {
    const answers = JSON.parse(userText.split('ANSWERS (untrusted data, JSON):\n')[1]);
    const all = answers.map((a) => a.answer).join(' ');
    const base = { plausibility_concern: false, instruction_like_text: false, clarification_questions: [] };
    if (/not much|never built/i.test(all)) return { ...base, outcome: 'not_yet', confidence: 'medium', criteria: [] };
    if (/python/i.test(all)) {
      const first = (s) => sentences(s)[0].replace(/[.!?]$/, '');
      return { ...base, outcome: 'qualified', confidence: 'high', criteria: [{ id: 'c1', met: 'yes', quote: first(answers[0].answer) }, { id: 'c2', met: 'yes', quote: first(answers[1].answer) }] };
    }
    return { ...base, outcome: 'unclear', confidence: 'low', criteria: [], clarification_questions: ['Which specific tools did you use, and for what?'] };
  }
  throw new Error('unknown ' + name);
}

function startMock(mode = {}) {
  const seen = { models: 0, responses: 0, auth: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.auth.push(req.headers.authorization);
      const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.startsWith('/v1/models/')) {
        seen.models++;
        if (mode.models) return json(mode.models, { error: { message: 'Incorrect API key provided: ' + FAKE_KEY, type: 'invalid_request_error', code: 'invalid_api_key' } });
        return json(200, { id: decodeURIComponent(req.url.slice('/v1/models/'.length)), object: 'model', owned_by: 'openai' });
      }
      seen.responses++;
      const parsed = JSON.parse(body);
      if (mode.responses) return json(mode.responses, { error: { message: mode.message ?? 'bad request', type: 'invalid_request_error', code: mode.code ?? 'x' } });
      if (mode.incomplete) return json(200, { status: 'incomplete', output: [], usage: { input_tokens: 100, output_tokens: 600 } });
      const name = parsed.text?.format?.name;
      const text = JSON.stringify(scripted(name, parsed.input[1].content));
      json(200, { id: 'r', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1200, output_tokens: 300 } });
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/ai-smoke-test.mjs', ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENAI_ENV_FILE: join(tmpdir(), 'definitely-missing.env'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
}
const GO = ['--execute', '--i-approve-paid-api-calls'];

console.log('\n[free / refusing modes]');
{
  const d = await run([]);
  ok(d.code === 0 && /DRY RUN/.test(d.out) && /Worst case/.test(d.out) && /\$0\.05/.test(d.out), 'dry run: exit 0, no key needed, prints the plan, the estimate, the worst case and the $0.05 ceiling');
  const onlyOne = await run(['--execute'], { OPENAI_API_KEY: FAKE_KEY });
  ok(onlyOne.code === 0 && /DRY RUN/.test(onlyOne.out), '--execute without the approval flag is still a dry run (no request possible)');
  const noKey = await run(GO);
  ok(noKey.code === 2 && /No key found/.test(noKey.out), 'a real run without a key refuses');
  const badKey = await run(GO, { OPENAI_API_KEY: 'sk-' + 'a'.repeat(40) });
  ok(badKey.code === 2 && /not project-scoped/.test(badKey.out) && !badKey.out.includes('a'.repeat(40)), 'a non-project key (personal / organisation-wide) is refused and not echoed');
  const remote = await run(GO, { OPENAI_API_KEY: FAKE_KEY, OPENAI_BASE_URL: 'https://evil.example' });
  ok(remote.code === 2 && /loopback/.test(remote.out) && !remote.out.includes(FAKE_KEY), 'a non-loopback OPENAI_BASE_URL is refused, so the key can never be sent elsewhere');
}

console.log('\n[every unexpected condition stops the run at once]');
for (const [label, mode, re] of [
  ['rejected key (401 on the free lookup)', { models: 401 }, /key was rejected/],
  ['project without access to the model (403)', { models: 403 }, /not allowed to use this model/],
  ['unknown model (404)', { models: 404 }, /does not exist or is not available/],
  ['schema / parameters rejected (400 on the first paid request)', { responses: 400, code: 'invalid_json_schema', message: 'Invalid schema for response_format' }, /rejected the request shape[\s\S]*|invalid_json_schema/],
  ['no quota / rate limit (429)', { responses: 429 }, /Rate limit or no remaining quota/],
  ['output cut off by the token limit', { incomplete: true }, /max_output_tokens/],
]) {
  const m = await startMock(mode);
  const report = join(tmpdir(), `smoke-selftest-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const r = await run([...GO, '--report', report], { OPENAI_API_KEY: FAKE_KEY, OPENAI_BASE_URL: m.url });
  ok(r.code === 3 && re.test(r.out), `${label}: stops with exit 3`, r.out.slice(-300));
  ok(m.seen.responses <= 1, `${label}: at most ONE paid request was made (no retries)`, String(m.seen.responses));
  const rep = existsSync(report) ? readFileSync(report, 'utf8') : '';
  ok(!r.out.includes(FAKE_KEY) && !rep.includes(FAKE_KEY), `${label}: the key appears neither in the output nor in the report`);
  if (existsSync(report)) rmSync(report);
  m.server.close();
}

console.log('\n[cost ceiling]');
{
  const m = await startMock();
  const r = await run([...GO, '--max-cost', '0.0001'], { OPENAI_API_KEY: FAKE_KEY, OPENAI_BASE_URL: m.url });
  ok(r.code === 3 && /ceiling/.test(r.out) && m.seen.responses === 0, 'a request that could exceed the ceiling is not sent (zero paid requests)');
  m.server.close();
  const huge = await run(['--max-cost', '5']);
  ok(/\$0\.05/.test(huge.out), 'the ceiling cannot be raised above $0.05');
}

console.log('\n[happy path against the mock: all phases, all expectations]');
{
  const m = await startMock();
  const report = join(tmpdir(), `smoke-selftest-ok-${Date.now()}.json`);
  const r = await run([...GO, '--report', report], { OPENAI_API_KEY: FAKE_KEY, OPENAI_BASE_URL: m.url });
  ok(r.code === 0, 'exit 0', r.out.slice(-600));
  ok(/\[P0\]/.test(r.out) && /\[P1\]/.test(r.out) && /\[P2\]/.test(r.out) && /\[P3\]/.test(r.out) && /\[P4\]/.test(r.out), 'all phases ran');
  ok(m.seen.models === 1 && m.seen.responses === 11, 'one free model lookup and exactly 11 paid requests (1 probe + 4 assessments + 3 x 2 matching; the injection set is stopped by code)', `${m.seen.models}/${m.seen.responses}`);
  const rep = JSON.parse(readFileSync(report, 'utf8'));
  ok(rep.totals.requests === 11 && rep.totals.estimated_cost_usd > 0 && rep.totals.estimated_cost_usd < 0.05 && rep.checks.every((c) => c.pass), 'the report records 11 requests, an estimated cost below the ceiling and only passing expectations');
  ok(m.seen.auth.every((a) => a === `Bearer ${FAKE_KEY}`) && !r.out.includes(FAKE_KEY) && !JSON.stringify(rep).includes(FAKE_KEY), 'the key is only ever sent as the bearer token and never appears in output or report');
  rmSync(report);
  m.server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
