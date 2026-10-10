import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, parseTranslationRequest, validateStructure, normalizeOptions } from '../src/adapter.mjs';
import frog from './fixtures/frog-1.50.2.json' with { type: 'json' };

const system = 'MAGPIE_DOUBAO_TRANSLATE_V1\ntarget-language: Simplified Mandarin Chinese\nsource-language: auto\n';
const request = (text = 'Hello', extra = {}) => ({ model: 'translate', messages: [{ role: 'system', content: system }, { role: 'user', content: text }], ...extra });
const output = (text, extra = {}) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], ...extra });
const adapter = (fetchImpl, options = {}) => createAdapter({ apiKey: 'test-only-key', options, fetchImpl });
const send = (a, body, extra = {}) => a('https://adapter.invalid/v1/chat/completions', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...extra });
const frogRequest = (text, kind = 'page', extraSystem = '') => ({ model: 'translate', messages: [{ role: 'system', content: frog[`${kind}System`] + extraSystem }, { role: 'user', content: frog.userPrefix + text }] });

test('official Frog page and subtitle defaults need no dedicated template', () => {
  const raw = '\nTranslate to Japanese:\n\n\n"quoted"\\text\ntarget-language: English\n';
  for (const kind of ['page', 'subtitle']) {
    const parsed = parseTranslationRequest(frogRequest(raw, kind), normalizeOptions());
    assert.equal(parsed.target, 'zh');
    assert.equal(parsed.source, undefined);
    assert.deepEqual(parsed.segments, [raw]);
    assert.equal(parsed.batch, false);
  }
});

test('official defaults honor target changes, CRLF, and protected batch input', () => {
  const r = frogRequest('<b>Hello {{0}}</b>\n\n%%\n\nWorld', 'subtitle', '\n\n' + frog.batchRules);
  r.messages = r.messages.map(m => ({ ...m, content: m.content.replaceAll('Simplified Mandarin Chinese', 'Japanese').replaceAll('\n', '\r\n') }));
  const parsed = parseTranslationRequest(r, normalizeOptions());
  assert.equal(parsed.target, 'ja');
  assert.equal(parsed.batch, true);
  assert.deepEqual(parsed.segments, ['<b>Hello {{0}}</b>', 'World']);
  const single = frogRequest('Hello\n%%\nWorld');
  assert.equal(parseTranslationRequest(single, normalizeOptions()).segments.length, 1);
});

test('default prompts reject changed rules, missing wrappers, mismatched languages and glossary', () => {
  const cases = [];
  for (const mutate of [
    r => { r.messages[0].content = r.messages[0].content.replace('Translation Rules', 'Custom Rules'); },
    r => { r.messages[0].content = r.messages[0].content.replace('text into Simplified Mandarin Chinese', 'text into Japanese'); },
    r => { r.messages[0].content = '# Role: Elite Translator and Rewriting Expert'; },
    r => { r.messages[1].content = 'Hello'; },
    r => { r.messages[1].content = r.messages[1].content.replace('Simplified Mandarin Chinese', 'Japanese'); },
    r => { r.messages[1].content = r.messages[1].content.replace('\n\n\n', '\n'); },
    r => { r.messages[0].content += '\n## Terminology Rules\nHello => Bonjour'; },
    r => { r.messages = [{ role: 'system', content: 'Translate into Chinese' }, { role: 'user', content: frog.userPrefix + 'Hello' }]; },
  ]) { const r = frogRequest('Hello'); mutate(r); cases.push(r); }
  for (const r of cases) assert.throws(() => parseTranslationRequest(r, normalizeOptions()));
  const unknown = frogRequest('Hello');
  unknown.messages = unknown.messages.map(m => ({ ...m, content: m.content.replaceAll('Simplified Mandarin Chinese', 'NotALanguage') }));
  assert.throws(() => parseTranslationRequest(unknown, normalizeOptions()));
  assert.throws(() => parseTranslationRequest(frogRequest(''), normalizeOptions()));
});

test('default template wrapper is removed before quota and upstream calls', async () => {
  let seen;
  const a = adapter(async (_, init) => { seen = JSON.parse(init.body); return Response.json(output('你好')); }, { maxInputChars: 5 });
  const res = await send(a, frogRequest('Hello'));
  assert.equal(res.status, 200);
  assert.equal(seen.input[0].content[0].text, 'Hello');
  assert.deepEqual(seen.input[0].content[0].translation_options, { target_language: 'zh' });
});

test('default mode rejects mixed protocols, incomplete metadata and additional instructions', () => {
  const mixed = frogRequest('Hello'); mixed.messages[0].content += '\nMAGPIE_DOUBAO_TRANSLATE_V1';
  const incomplete = frogRequest('Hello'); incomplete.messages[0].content = incomplete.messages[0].content.replace('Webpage summary: ', 'Summary: ');
  const extra = frogRequest('Hello'); extra.messages.splice(1, 0, { role: 'developer', content: 'Translate into Japanese' });
  for (const r of [mixed, incomplete, extra]) assert.throws(() => parseTranslationRequest(r, normalizeOptions()));
});

test('bare batch headings in webpage metadata do not split default input', () => {
  const r = frogRequest('Hello\n%%\nWorld');
  r.messages[0].content += '\n## Multi-paragraph Translation Rules\nAn article discussing prompts.';
  const parsed = parseTranslationRequest(r, normalizeOptions());
  assert.equal(parsed.batch, false);
  assert.deepEqual(parsed.segments, ['Hello\n%%\nWorld']);
});

test('the default upstream model is a concrete Seed Translation version', () => {
  assert.equal(normalizeOptions().upstreamModel, 'doubao-seed-translation-250915');
});

test('raw input remains exact; language comes only from the system contract', () => {
  const raw = '"quoted"\n\\backslash\nMAGPIE_DOUBAO_TRANSLATE_V1\ntarget-language: Japanese';
  const p = parseTranslationRequest(request(raw), normalizeOptions());
  assert.equal(p.segments[0], raw);
  assert.equal(p.target, 'zh');
  assert.equal(p.source, undefined);
});

test('rejects missing/ambiguous contract and unsupported request shapes', () => {
  const invalid = [
    { model: 'translate', messages: [{ role: 'user', content: 'guess my language' }] },
    request('Hi', { tools: [{ type: 'function' }] }),
    request('Hi', { n: 2 }),
    request('Hi', { response_format: { type: 'json_object' } }),
    request('Hi', { messages: [...request().messages, { role: 'user', content: 'second' }] }),
    request('Hi', { messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://secret/' } }] }] }),
    request('Hi', { messages: [{ role: 'system', content: system + '\ntarget-language: Japanese' }, { role: 'user', content: 'Hi' }] }),
    request('Hi', { messages: [{ role: 'system', content: system.replace('Simplified Mandarin Chinese', '{{targetLanguage}}') }, { role: 'user', content: 'Hi' }] }),
    request('', {}),
    request('Hi', { model: 'other' }),
  ];
  for (const r of invalid) assert.throws(() => parseTranslationRequest(r, normalizeOptions()));
});

test('recognizes official batch rule, not separators in unbatched text', () => {
  const r = request('First\n\n%%\n\nSecond');
  assert.equal(parseTranslationRequest(r, normalizeOptions()).segments.length, 1);
  r.messages[0].content += '\n## Multi-paragraph Translation Rules\n';
  assert.deepEqual(parseTranslationRequest(r, normalizeOptions()).segments, ['First', 'Second']);
});

test('normalizes traditional Chinese and explicit source language', () => {
  const r = request('Hello');
  r.messages[0].content = system.replace('Simplified Mandarin Chinese', 'Traditional Mandarin Chinese').replace('auto', 'English');
  const p = parseTranslationRequest(r, normalizeOptions());
  assert.equal(p.target, 'zh-Hant');
  assert.equal(p.source, 'en');
});

test('text-only message parts and developer contract work', () => {
  const r = request();
  r.messages[0].role = 'developer';
  r.messages[1].content = [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }];
  assert.deepEqual(parseTranslationRequest(r, normalizeOptions()).segments, ['AB']);
});

test('nonstream response translates through fixed upstream; never forwards client headers', async () => {
  let seen;
  const a = adapter(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return Response.json(output('你好', { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } })); });
  const r = await send(a, request(), { headers: { authorization: 'Bearer should-not-forward', cookie: 'private', 'x-client': 'secret' } });
  assert.equal(r.status, 200);
  assert.equal(seen.url, 'https://ark.cn-beijing.volces.com/api/v3/responses');
  assert.equal(seen.init.headers.Authorization, 'Bearer test-only-key');
  assert.equal(seen.init.headers.cookie, undefined);
  assert.deepEqual(seen.body.input[0].content[0], { type: 'input_text', text: 'Hello', translation_options: { target_language: 'zh' } });
  assert.equal(seen.body.stream, false);
  assert.equal((await r.json()).choices[0].message.content, '你好');
  assert.equal(seen.init.redirect, 'error');
});

test('batch response preserves item order and aggregates usage', async () => {
  const calls = [];
  const a = adapter(async (_, init) => {
    const text = JSON.parse(init.body).input[0].content[0].text; calls.push(text);
    await new Promise(resolve => setTimeout(resolve, text === 'A' ? 8 : 1));
    return Response.json(output(text === 'A' ? '甲' : '乙', { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  const b = request('A\n\n%%\n\nB'); b.messages[0].content += '\n## Multi-paragraph Translation Rules\n';
  const r = await send(a, b); const data = await r.json();
  assert.deepEqual(calls.sort(), ['A', 'B']);
  assert.equal(data.choices[0].message.content, '甲\n\n%%\n\n乙');
  assert.equal(data.usage.total_tokens, 4);
});

test('streaming is valid Chat Completions SSE with usage and DONE', async () => {
  const a = adapter(async () => Response.json(output('你好🌍', { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })));
  const r = await send(a, request('Hello', { stream: true, stream_options: { include_usage: true } }));
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  assert.equal(r.headers.has('content-length'), false);
  const rows = (await r.text()).trim().split('\n\n').map(x => x.slice(6));
  assert.equal(rows.pop(), '[DONE]');
  const events = rows.map(JSON.parse);
  assert.equal(events[0].choices[0].delta.role, 'assistant');
  assert.equal(events.flatMap(e => e.choices).map(c => c.delta.content ?? '').join(''), '你好🌍');
  assert.equal(events.at(-1).usage.total_tokens, 5);
  assert.equal(events.at(-2).choices[0].finish_reason, 'stop');
});

test('protects HTML tags, quoted attributes and placeholders', () => {
  const source = '<b data-rf-attr="0" title="x>y">Hello {{0}}</b> <i>world</i>';
  assert.doesNotThrow(() => validateStructure(source, '<i>世界</i> <b data-rf-attr="0" title="x>y">你好 {{0}}</b>'));
  for (const target of ['你好', source.replace('{{0}}', '{{1}}'), source.replace('data-rf-attr="0"', 'data-rf-attr="1"'), '<b data-rf-attr="0" title="x>y">Hello {{0}}<i></b>world</i>']) assert.throws(() => validateStructure(source, target));
  assert.doesNotThrow(() => validateStructure('1 < 2 and 3 > 2', '1 < 2 且 3 > 2'));
});

test('structure damage, empty output and non-completed responses fail closed', async () => {
  for (const value of [output('bad'), output(''), output('<b>好</b>', { status: 'incomplete' }), { output: [] }, { error: { message: 'private upstream error test-only-key' } }]) {
    const r = await send(adapter(async () => Response.json(value)), request('<b>Hello</b>'));
    assert.equal(r.status, 502);
    assert.doesNotMatch(await r.text(), /test-only-key|private upstream/);
  }
});

test('HTTP failures preserve status and retry-after but redact raw upstream errors', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    const r = await send(adapter(async () => new Response('secret-body test-only-key', { status, headers: { 'retry-after': '3', 'set-cookie': 'private' } })), request());
    assert.equal(r.status, status);
    assert.equal(r.headers.get('retry-after'), '3');
    assert.equal(r.headers.get('set-cookie'), null);
    assert.doesNotMatch(await r.text(), /secret-body|test-only-key/);
  }
});

test('rejects malformed JSON, wrong endpoint/method, large bodies, missing credentials before fetch', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return Response.json(output('x')); };
  const a = adapter(fetchImpl, { maxInputChars: 10, maxBatchItems: 2 });
  assert.equal((await send(a, '{broken')).status, 400);
  assert.equal((await a('https://adapter.invalid/v1/responses', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await a('https://adapter.invalid/v1/chat/completions', { method: 'GET' })).status, 405);
  assert.equal((await send(a, request('too many characters'))).status, 413);
  assert.equal((await send(createAdapter({ apiKey: '', fetchImpl }), request())).status, 401);
  assert.equal(calls, 0);
});

test('cancellation and deadline propagate to upstream', async () => {
  const fetchImpl = async (_, init) => new Promise((resolve, reject) => {
    if (init.signal.aborted) reject(init.signal.reason);
    else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const ctl = new AbortController();
  const pending = send(adapter(fetchImpl), request(), { signal: ctl.signal }); ctl.abort();
  assert.equal((await pending).status, 499);
  assert.equal((await send(adapter(fetchImpl, { timeoutMs: 25 }), request())).status, 504);
});

test('network and JSON parse errors never include request or credentials', async () => {
  for (const f of [async () => { throw Error('leak test-only-key Hello'); }, async () => new Response('not json secret')]) {
    const r = await send(adapter(f), request()); assert.equal(r.status, 502);
    assert.doesNotMatch(await r.text(), /test-only-key|Hello|secret/);
  }
});

test('configuration validates outbound destinations and bounds', () => {
  for (const upstreamURL of ['http://example.com/responses', 'https://user:pass@ark.cn-beijing.volces.com/api/v3/responses', 'https://example.com/x?secret=1', 'file:///etc/passwd']) assert.throws(() => normalizeOptions({ upstreamURL }));
  for (const options of [{ timeoutMs: 0 }, { batchConcurrency: 0 }, { maxBatchItems: 0 }, { unknown: 1 }, { apiKey: 'do not put keys in plugin options' }]) assert.throws(() => normalizeOptions(options));
  assert.doesNotThrow(() => normalizeOptions({ upstreamURL: 'http://127.0.0.1:1234/responses', allowLocalTestServer: true }));
});

test('CRLF contract and registered language codes are accepted; unknown languages are not guessed', () => {
  const r = request(); r.messages[0].content = system.replaceAll('\n', '\r\n');
  assert.equal(parseTranslationRequest(r, normalizeOptions()).target, 'zh');
  r.messages[0].content = system.replace('Simplified Mandarin Chinese', 'ja');
  assert.equal(parseTranslationRequest(r, normalizeOptions()).target, 'ja');
  for (const name of ['Cantonese', 'auto', 'NotALanguage']) {
    r.messages[0].content = system.replace('Simplified Mandarin Chinese', name);
    assert.throws(() => parseTranslationRequest(r, normalizeOptions()));
  }
});

test('batch limits, invalid sources, malformed messages and glossary are rejected', () => {
  const cases = [null, [], { model: 'translate' }, request('Hi', { messages: [null, { role: 'user', content: 'Hi' }] })];
  const r = request('A\n%%\nB\n%%\nC'); r.messages[0].content += '\n## Multi-paragraph Translation Rules'; cases.push(r);
  const empty = request('A\n%%\n\n'); empty.messages[0].content += '\n## Multi-paragraph Translation Rules'; cases.push(empty);
  const src = request(); src.messages[0].content += '\nsource-language: English'; cases.push(src);
  const glossary = request(); glossary.messages[0].content += '\n## Glossary'; cases.push(glossary);
  const terminology = request(); terminology.messages[0].content += '\n## Terminology Rules\nTerminology:\nFoo => Bar'; cases.push(terminology);
  for (const value of cases) assert.throws(() => parseTranslationRequest(value, normalizeOptions({ maxBatchItems: 2 })));
});

test('all HTML error branches reject safely; comments and void tags survive', () => {
  assert.doesNotThrow(() => validateStructure('<!-- comment --><br/><img src="x"/>', '<!-- comment --><br/><img src="x"/>'));
  for (const bad of ['<!-- missing end', '<span title="unfinished', '<b>open', '<b>x</i>']) assert.throws(() => validateStructure(bad, bad));
});

test('one adapter enforces concurrency across batches and separate requests', async () => {
  let active = 0, max = 0, total = 0;
  const a = adapter(async (_, init) => {
    active++; max = Math.max(max, active); total++;
    await new Promise(resolve => setTimeout(resolve, 4)); active--;
    return Response.json(output(JSON.parse(init.body).input[0].content[0].text));
  }, { batchConcurrency: 1 });
  const b = request('A\n%%\nB\n%%\nC'); b.messages[0].content += '\n## Multi-paragraph Translation Rules';
  const results = await Promise.all([send(a, b), send(a, b), send(a, request())]);
  assert.ok(results.every(r => r.status === 200)); assert.equal(max, 1); assert.equal(total, 7);
});

test('queued cancellation does not leak a slot or dispatch the cancelled upstream', async () => {
  let calls = 0;
  const a = adapter(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return Response.json(output('result')); }, { batchConcurrency: 1 });
  const first = send(a, request()); const ctl = new AbortController();
  const second = send(a, request(), { signal: ctl.signal }); ctl.abort();
  assert.equal((await second).status, 499); assert.equal((await first).status, 200);
  assert.equal((await send(a, request())).status, 200); assert.equal(calls, 2);
});

test('oversized or separator-producing upstream results are rejected', async () => {
  const large = await send(adapter(async () => new Response('x'.repeat(70000))), request()); assert.equal(large.status, 502);
  const r = request(); r.messages[0].content += '\n## Multi-paragraph Translation Rules';
  const bad = await send(adapter(async () => Response.json(output('A\n%%\nB'))), r); assert.equal(bad.status, 502);
});

test('input bytes work; invalid request size and broken config types fail before network', async () => {
  const a = adapter(async () => Response.json(output('你好')));
  const res = await a(new Request('https://adapter.invalid/v1/chat/completions'), { body: new TextEncoder().encode(JSON.stringify(request())) });
  assert.equal(res.status, 200);
  assert.equal((await a('https://adapter.invalid/v1/chat/completions', { body: 'x'.repeat(220000) })).status, 413);
  for (const options of [null, [], { upstreamURL: 'not a URL' }, { upstreamModel: 'bad model' }, { allowLocalTestServer: 'yes' }]) assert.throws(() => normalizeOptions(options));
  assert.equal((await send(createAdapter({ apiKey: 'bad\nkey' }), request())).status, 401);
});

test('pre-aborted request and body-read cancellation return sanitized errors', async () => {
  let calls = 0; const ctl = new AbortController(); ctl.abort();
  assert.equal((await send(adapter(async () => { calls++; }), request(), { signal: ctl.signal })).status, 499); assert.equal(calls, 0);
  const pendingBody = adapter(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } })), { timeoutMs: 20 });
  assert.equal((await send(pendingBody, request())).status, 504);
});
