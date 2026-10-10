import assert from 'node:assert/strict';
import frog from '../test/fixtures/frog-1.50.2.json' with { type: 'json' };

if (!process.argv.includes('--real-upstream')) {
  console.log('No requests sent. With --real-upstream, this check sends three gateway requests / four small Doubao calls and can incur charges.');
  console.log('Run: node scripts/verify.mjs --real-upstream');
  console.log('Optional: MAGPIE_GATEWAY_URL=http://127.0.0.1:3425/v1 and MAGPIE_GATEWAY_KEY (never put a real key on the command line).');
  process.exit(0);
}
const base = process.env.MAGPIE_GATEWAY_URL ?? 'http://127.0.0.1:3425/v1';
const url = new URL(base);
if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw Error('Verification only permits a loopback Magpie URL without credentials or query parameters.');
const key = process.env.MAGPIE_GATEWAY_KEY ?? 'magpie';
const post = async (text, { batch = false, stream = false, kind = 'page' } = {}) => {
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(75000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'doubao-seed/translate', stream, ...(stream ? { stream_options: { include_usage: true } } : {}), messages: [{ role: 'system', content: frog[`${kind}System`] + (batch ? '\n\n' + frog.batchRules : '') }, { role: 'user', content: frog.userPrefix + text }] }),
  });
  if (!res.ok) throw Error(`HTTP ${res.status}. Check Magpie provider login, upstreamModel access and the selected template. Response body is not printed to protect secrets.`);
  if (!stream) return (await res.json()).choices?.[0]?.message?.content;
  const sse = await res.text();
  assert.match(sse, /data: \[DONE\]/);
  return sse.split(/\r?\n/).filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6))).flatMap(item => item.choices ?? []).map(item => item.delta?.content ?? '').join('');
};
try {
  const single = await post('The weather is nice today.');
  assert.ok(typeof single === 'string' && /[\u3400-\u9fff]/.test(single), 'single translation must contain Chinese characters');
  console.log('PASS 1/3: plain text produced Chinese output.');
  const batch = await post('<b data-rf-attr="0">Welcome {{0}}</b>\n\n%%\n\nThank you.', { batch: true });
  const segments = batch.split(/\r?\n[ \t]*%%[ \t]*\r?\n/);
  assert.equal(segments.length, 2); assert.match(segments[0], /<b data-rf-attr="0">/); assert.match(segments[0], /\{\{0\}\}/); assert.match(segments[0], /<\/b>/);
  console.log('PASS 2/3: two batch items, HTML and placeholder boundaries survived.');
  const streamed = await post('Good morning.', { stream: true, kind: 'subtitle' });
  assert.match(streamed, /[\u3400-\u9fff]/);
  console.log('PASS 3/3: Chat Completions SSE completed with Chinese output.');
  console.log('Gateway smoke check completed. Manually test Frog webpage, selection, subtitles and input translation; this script does not prove UI behavior or translation quality.');
} catch (error) {
  console.error(error.message.startsWith('HTTP ') ? error.message : 'Verification failed: check provider connectivity, output structure and translation result. No raw response or credential is printed.');
  process.exitCode = 1;
}
