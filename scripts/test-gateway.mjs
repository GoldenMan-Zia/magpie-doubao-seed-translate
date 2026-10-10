import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import frog from '../test/fixtures/frog-1.50.2.json' with { type: 'json' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bun = process.env.MAGPIE_BUN ?? spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim();
assert.ok(bun, 'Bun must be installed for actual Magpie host tests.');
const home = await mkdtemp(path.join(tmpdir(), 'magpie-seed-test-'));
const bin = process.env.MAGPIE_BIN ?? 'magpie';
let gateway, gatewayLog = '', seen = [], cancelledUpstream = 0;
const mock = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const text = body.input[0].content[0].text;
  seen.push({ body, auth: req.headers.authorization });
  if (text === 'RATE_LIMIT') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' }); res.end('{"error":{"message":"DO_NOT_LEAK_UPSTREAM"}}'); return; }
  if (text === 'HTML_DAMAGE') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '<b>broken' }] }] })); return; }
  if (text === 'CANCEL' || text === 'TIMEOUT') { res.on('close', () => { cancelledUpstream++; }); setTimeout(() => { if (!res.destroyed) res.end('{}'); }, 3000).unref(); return; }
  const translations = {
    Hello: '你好', A: '甲', B: '乙',
    '<b data-rf-attr="1">Hello {{0}}</b>': '<b data-rf-attr="1">你好 {{0}}</b>',
    'The weather is nice today.': '今天天气很好。',
    '<b data-rf-attr="0">Welcome {{0}}</b>': '<b data-rf-attr="0">欢迎 {{0}}</b>',
    'Thank you.': '谢谢。', 'Good morning.': '早上好。',
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: translations[text] ?? text }] }], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } }));
});
await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
const probe = createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), MAGPIE_ADDR: `127.0.0.1:${port}`, MAGPIE_BUN: bun };
const command = args => {
  const result = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 90000 });
  if (result.status !== 0) throw Error(`Isolated Magpie command failed (${args[0]}): ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
const system = 'MAGPIE_DOUBAO_TRANSLATE_V1\ntarget-language: Simplified Mandarin Chinese\nsource-language: auto';
const body = (text, extra = {}, batch = false) => ({ model: 'doubao-seed/translate', messages: [{ role: 'system', content: system + (batch ? '\n## Multi-paragraph Translation Rules\n' : '') }, { role: 'user', content: text }], ...extra });
const frogBody = (text, kind = 'page', batch = false, extra = {}) => ({ model: 'doubao-seed/translate', messages: [{ role: 'system', content: frog[`${kind}System`] + (batch ? '\n\n' + frog.batchRules : '') }, { role: 'user', content: frog.userPrefix + text }], ...extra });
const ask = (data, signal) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer local-test-client', 'content-type': 'application/json' }, body: JSON.stringify(data), signal });
try {
  command(['plugin', 'add', root]);
  command(['plugin', 'options', root, JSON.stringify({ upstreamURL: `http://127.0.0.1:${mock.address().port}/responses`, allowLocalTestServer: true, timeoutMs: 1000 })]);
  const authDir = path.join(home, '.config', 'magpie'); await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, 'plugin-auth.json'), JSON.stringify({ 'doubao-seed': { type: 'api', key: 'test-only-non-production-key' } }), { mode: 0o600 });
  const list = command(['plugin', '--json']);
  assert.match(list, /doubao-seed/);
  gateway = spawn(bin, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  gateway.stdout.on('data', b => { gatewayLog += b; }); gateway.stderr.on('data', b => { gatewayLog += b; });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (gateway.exitCode !== null) throw Error('Gateway exited before readiness.');
    try { const res = await fetch(`http://127.0.0.1:${port}/v1/models`); if (res.ok) { const models = await res.text(); assert.match(models, /doubao-seed\/translate/); ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'isolated gateway readiness');
  let res = await ask(body('Hello')); assert.equal(res.status, 200); let data = await res.json(); assert.equal(data.choices[0].message.content, '你好');
  for (const kind of ['page', 'subtitle']) {
    res = await ask(frogBody('Hello', kind)); assert.equal(res.status, 200); assert.equal((await res.json()).choices[0].message.content, '你好');
    res = await ask(frogBody('A\n\n%%\n\nB', kind, true)); assert.equal(res.status, 200); assert.equal((await res.json()).choices[0].message.content, '甲\n\n%%\n\n乙');
  }
  res = await ask(frogBody('<b data-rf-attr="1">Hello {{0}}</b>', 'page', false, { stream: true }));
  assert.equal(res.status, 200); assert.match(await res.text(), /你好 \{\{0\}\}/);
  const defaultCalls = seen.length;
  const mismatch = frogBody('Hello'); mismatch.messages[1].content = mismatch.messages[1].content.replace('Simplified Mandarin Chinese', 'Japanese');
  res = await ask(mismatch); assert.equal(res.status, 400); assert.equal(seen.length, defaultCalls);
  assert.ok(seen.every(call => !call.body.input[0].content[0].text.startsWith('Translate to ')));
  res = await ask(body('A\n\n%%\n\nB', {}, true)); assert.equal(res.status, 200); data = await res.json(); assert.equal(data.choices[0].message.content, '甲\n\n%%\n\n乙');
  res = await ask(body('<b data-rf-attr="1">Hello {{0}}</b>')); assert.equal(res.status, 200); assert.equal((await res.json()).choices[0].message.content, '<b data-rf-attr="1">你好 {{0}}</b>');
  res = await ask(body('Hello', { stream: true, stream_options: { include_usage: true } })); assert.equal(res.status, 200); const sse = await res.text(); assert.match(sse, /你好/); assert.match(sse, /data: \[DONE\]/);
  res = await ask(body('RATE_LIMIT')); assert.equal(res.status, 429); assert.doesNotMatch(await res.text(), /DO_NOT_LEAK_UPSTREAM/);
  res = await ask(body('HTML_DAMAGE')); assert.equal(res.status, 502);
  res = await ask({ model: 'doubao-seed/translate', messages: [{ role: 'user', content: 'Hello' }] }); assert.equal(res.status, 400);
  const before = seen.length; res = await ask(body(''));
  assert.equal(res.status, 400); assert.equal(seen.length, before);
  const ctl = new AbortController(); const cancelled = ask(body('CANCEL'), ctl.signal); cancelled.catch(() => {});
  for (let i = 0; i < 100 && !seen.some(call => call.body.input[0].content[0].text === 'CANCEL'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(seen.some(call => call.body.input[0].content[0].text === 'CANCEL'));
  ctl.abort(); await assert.rejects(cancelled);
  for (let i = 0; i < 100 && !cancelledUpstream; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(cancelledUpstream > 0, 'client cancellation must abort the upstream connection');
  res = await ask(body('TIMEOUT')); assert.equal(res.status, 504);
  res = await ask(body('Hello')); assert.equal(res.status, 200);
  const verify = spawn(process.execPath, [path.join(root, 'scripts', 'verify.mjs'), '--real-upstream'], { env: { ...env, MAGPIE_GATEWAY_URL: `http://127.0.0.1:${port}/v1` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let verifyLog = ''; verify.stdout.on('data', b => { verifyLog += b; }); verify.stderr.on('data', b => { verifyLog += b; });
  const verifyCode = await new Promise((resolve, reject) => { verify.once('exit', resolve); verify.once('error', reject); });
  assert.equal(verifyCode, 0, `delivered verification script failed: ${verifyLog}`); assert.match(verifyLog, /PASS 3\/3/);
  assert.ok(seen.every(call => call.auth === 'Bearer test-only-non-production-key'));
  assert.ok(seen.every(call => call.body.model === 'doubao-seed-translation-250915' && call.body.stream === false));
  assert.doesNotMatch(gatewayLog, /test-only-non-production-key|local-test-client/);
  console.log('PASS: actual Magpie isolated plugin load, authentication, model routing, Frog default page/subtitle prompts, legacy contract, nonstream, batch ordering, HTML/placeholders, SSE, 429, integrity rejection, invalid-input rejection, cancellation propagation, timeout recovery and delivered verification script.');
  console.log('Only loopback mock requests were used; no real key, no charged upstream, no live Magpie config modified.');
  if (process.env.KEEP_TEST_HOME === '1') console.log(`Isolated HOME retained: ${home}`);
} finally {
  if (gateway && gateway.exitCode === null) { gateway.kill('SIGTERM'); await new Promise(resolve => { gateway.once('exit', resolve); setTimeout(() => { gateway.kill('SIGKILL'); resolve(); }, 3000).unref(); }); }
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  if (process.env.KEEP_TEST_HOME !== '1') await rm(home, { recursive: true, force: true });
}
