import languageNames from './languages.json' with { type: 'json' };

export const PROVIDER = 'doubao-seed';
export const MODEL = 'translate';
export const CONTRACT = 'MAGPIE_DOUBAO_TRANSLATE_V1';
const DEFAULT_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const SEPARATOR = /\r?\n[ \t]*%%[ \t]*\r?\n/;
const FROG_BATCH_RULE = '## Multi-paragraph Translation Rules\n1. If input contains a standalone line containing only %%, use a standalone %% line in your output. If input has no standalone %% line, don\'t use %% in your output.\n2. **CRITICAL**: Treat %% as a separator only when it appears on its own line. Do not treat %% as a separator when it appears inside normal text, code, quotes, or punctuation.';
const encoder = new TextEncoder();
const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const aliases = new Map(Object.entries(languageNames).map(([name, code]) => [name.toLowerCase(), code]));
for (const [name, code] of Object.entries({ 'Simplified Chinese': 'zh', 'Traditional Chinese': 'zh-Hant', 'Chinese (Simplified)': 'zh', 'Chinese (Traditional)': 'zh-Hant', '简体中文': 'zh', '繁体中文': 'zh-Hant', 'zh-CN': 'zh', 'zh-TW': 'zh-Hant' })) aliases.set(name.toLowerCase(), code);
const codes = new Map(Object.values(languageNames).map(code => [code.toLowerCase(), code]));

class AdapterError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
const fail = (status, code, message) => { throw new AdapterError(status, code, message); };

export function normalizeOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_options', 'Plugin options must be an object.');
  const defaults = { upstreamURL: DEFAULT_URL, upstreamModel: 'doubao-seed-translation-250915', timeoutMs: 60000, batchConcurrency: 2, maxBatchItems: 32, maxInputChars: 24000, allowLocalTestServer: false };
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) fail(400, 'invalid_options', 'Unknown plugin option; store the API key through Magpie login, not options.');
  const opts = { ...defaults, ...value };
  for (const [key, max] of Object.entries({ timeoutMs: 300000, batchConcurrency: 8, maxBatchItems: 128, maxInputChars: 200000 })) {
    if (!Number.isSafeInteger(opts[key]) || opts[key] < 1 || opts[key] > max) fail(400, 'invalid_options', `Invalid ${key}.`);
  }
  if (typeof opts.allowLocalTestServer !== 'boolean' || typeof opts.upstreamModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(opts.upstreamModel)) fail(400, 'invalid_options', 'Invalid upstream model or test-server option.');
  let url;
  try { url = new URL(opts.upstreamURL); } catch { fail(400, 'invalid_options', 'Invalid upstream URL.'); }
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (opts.allowLocalTestServer && local && url.protocol === 'http:'))) fail(400, 'invalid_options', 'Upstream requires HTTPS without credentials/query/fragment; HTTP is only allowed for explicit loopback tests.');
  return Object.freeze(opts);
}

function language(value, source = false) {
  if (source && value.toLowerCase() === 'auto') return undefined;
  const code = aliases.get(value.toLowerCase()) ?? codes.get(value.toLowerCase());
  if (!code) fail(400, 'unsupported_language', 'Unrecognized target/source language. Use a documented language name or code; Cantonese is not silently mapped to Mandarin.');
  return code;
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(p => p && p.type === 'text' && typeof p.text === 'string')) return content.map(p => p.text).join('');
  fail(400, 'unsupported_content', 'This provider accepts text-only translation requests.');
}

const DEFAULT_RULES = {
  text: `## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text.
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency.
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.

## Document Metadata for Context Awareness
Webpage title: `,
  subtitles: `## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. Keep subtitle timing alignment natural by matching the original subtitle segment boundaries and sentence flow.
3. Preserve speaker intent, tone, punctuation, and line-break structure unless a small adjustment is required for fluent subtitles.
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.

## Video Metadata for Context Awareness
Video title: `,
};

function defaultFrogInput(system, text) {
  const normalized = system.replaceAll('\r\n', '\n');
  const heading = /^You are a professional ([^\n]+) native translator who needs to fluently translate (text|subtitles) into \1\.\n\n/.exec(normalized);
  if (!heading || !normalized.slice(heading[0].length).startsWith(DEFAULT_RULES[heading[2]]) || system.split(/\r?\n/).includes(CONTRACT)) {
    fail(400, 'missing_contract', 'Select the built-in Default prompt in Frog for both webpage and subtitles. Custom/rewrite prompts are not supported; the legacy Magpie template still works.');
  }
  const metadata = normalized.slice(heading[0].length + DEFAULT_RULES[heading[2]].length);
  const summaryLabel = heading[2] === 'text' ? '\nWebpage summary: ' : '\nVideo summary: ';
  if (!metadata.includes(summaryLabel)) fail(400, 'invalid_contract', 'Frog default prompt metadata is incomplete.');
  const wrapper = typeof text === 'string' && /^Translate to ([^\r\n]+):\r?\n\r?\n\r?\n/.exec(text);
  if (!wrapper) fail(400, 'invalid_contract', 'Frog default prompt requires its standard Translate to header.');
  const target = language(heading[1]);
  if (language(wrapper[1]) !== target) fail(400, 'invalid_contract', 'System and user target languages do not match.');
  // Slice exactly once: the original text may itself start with a Translate to header.
  return { target, source: undefined, text: text.slice(wrapper[0].length) };
}

export function parseTranslationRequest(body, opts) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== MODEL) fail(400, 'unsupported_model', 'Use the translation-only model doubao-seed/translate.');
  if (!Array.isArray(body.messages) || body.messages.length < 2 || body.messages.length > 4) fail(400, 'invalid_messages', 'Expected system instructions followed by one user text.');
  if (body.tools?.length || body.functions?.length || (body.tool_choice && body.tool_choice !== 'none') || (body.n !== undefined && body.n !== 1) || (body.response_format?.type && body.response_format.type !== 'text') || (body.stream !== undefined && typeof body.stream !== 'boolean')) fail(400, 'unsupported_request', 'Tools, multiple candidates and structured output are not supported by this translation provider.');
  const instructions = [];
  let text;
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') fail(400, 'invalid_messages', 'Invalid message.');
    if (['system', 'developer'].includes(message.role) && text === undefined) instructions.push(messageText(message.content));
    else if (message.role === 'user' && text === undefined) text = messageText(message.content);
    else fail(400, 'unsupported_conversation', 'Only instructions followed by a single user input are supported.');
  }
  const system = instructions.join('\n');
  if (/^## .*(Glossary|Terminology)/im.test(system) || /^## .*术语/m.test(system)) fail(400, 'unsupported_glossary', 'Frog glossary instructions cannot be honored by this adapter. Disable the glossary for this provider.');
  let target, source;
  if (system.split(/\r?\n/)[0] === CONTRACT) {
    if (system.split(/\r?\n/).filter(line => line === CONTRACT).length !== 1) fail(400, 'invalid_contract', 'Expected one translation protocol marker.');
    const targets = [...system.matchAll(/^target-language: ([^\r\n]+)\r?$/gm)];
    const sources = [...system.matchAll(/^source-language: ([^\r\n]+)\r?$/gm)];
    if (targets.length !== 1 || sources.length > 1) fail(400, 'invalid_contract', 'Expected one target-language and at most one source-language line.');
    target = language(targets[0][1].trim());
    source = language((sources[0]?.[1] ?? 'auto').trim(), true);
  } else {
    if (instructions.length !== 1) fail(400, 'invalid_contract', 'Frog default mode requires a single system instruction.');
    ({ target, source, text } = defaultFrogInput(system, text));
  }
  if (typeof text !== 'string' || text.trim() === '') fail(400, 'empty_input', 'Translation input is empty.');
  if (text.length > opts.maxInputChars) fail(413, 'input_too_large', 'Translation exceeds maxInputChars. Reduce Frog batch size.');
  const batch = system.split(/\r?\n/)[0] === CONTRACT
    ? /^## Multi-paragraph Translation Rules\r?$/m.test(system)
    : system.replaceAll('\r\n', '\n').split('\n').some((_, i, lines) => lines.slice(i, i + 3).join('\n') === FROG_BATCH_RULE);
  const segments = batch ? text.split(SEPARATOR).map(part => part.trim()) : [text];
  if (segments.length > opts.maxBatchItems) fail(413, 'batch_too_large', 'Translation exceeds maxBatchItems. Reduce Frog batch size.');
  if (segments.some(part => !part.trim())) fail(400, 'empty_segment', 'Batch contains an empty segment.');
  return { target, source, segments, batch, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true };
}

function sortedCounts(tokens) {
  const result = new Map();
  for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
  return JSON.stringify([...result.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// Scan tags with quote awareness: a '>' inside an attribute is not a tag end.
function htmlTokens(text) {
  const tags = [];
  const stack = [];
  for (let pos = 0; pos < text.length; pos++) {
    if (text[pos] !== '<') continue;
    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      if (end < 0) fail(502, 'html_integrity', 'Unterminated HTML comment.');
      tags.push(text.slice(pos, end + 3)); pos = end + 2; continue;
    }
    const match = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)(?=[\s/>])/.exec(text.slice(pos));
    if (!match) continue;
    let end = pos + match[0].length, quote = '';
    for (; end < text.length; end++) {
      const ch = text[end];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (end === text.length) fail(502, 'html_integrity', 'Unterminated HTML tag.');
    const tag = text.slice(pos, end + 1), name = match[1].toLowerCase();
    if (tag.startsWith('</')) {
      if (stack.pop() !== name) fail(502, 'html_integrity', 'HTML nesting was damaged.');
    } else if (!VOID_TAGS.has(name) && !/\/\s*>$/.test(tag)) stack.push(name);
    tags.push(tag); pos = end;
  }
  if (stack.length) fail(502, 'html_integrity', 'HTML tags are unbalanced.');
  return tags;
}

export function validateStructure(source, target) {
  if (sortedCounts(htmlTokens(source)) !== sortedCounts(htmlTokens(target))) fail(502, 'html_integrity', 'Translation changed HTML tags or attributes; result was rejected.');
  const tokens = text => text.match(/\{\{[^{}\r\n]+\}\}/g) ?? [];
  if (sortedCounts(tokens(source)) !== sortedCounts(tokens(target))) fail(502, 'placeholder_integrity', 'Translation changed protected placeholders; result was rejected.');
}

function errorResponse(error) {
  const e = error instanceof AdapterError ? error : new AdapterError(502, 'adapter_error', 'Translation adapter failed.');
  const headers = { 'content-type': 'application/json' };
  if (e.retryAfter && /^[0-9A-Za-z,: +\-]{1,80}$/.test(e.retryAfter)) headers['retry-after'] = e.retryAfter;
  return new Response(JSON.stringify({ error: { message: e.message, type: 'translation_error', code: e.code } }), { status: e.status, headers });
}

function completionResponse(text, usage, request) {
  const id = `chatcmpl-${crypto.randomUUID()}`, created = Math.floor(Date.now() / 1000);
  const base = { id, created, model: MODEL };
  if (!request.stream) return Response.json({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage });
  // The upstream is non-streaming. SSE begins only after every segment validates.
  const event = (choices, extra = {}) => `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices, ...extra })}\n\n`;
  const payload = event([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])
    + event([{ index: 0, delta: { content: text }, finish_reason: null }])
    + event([{ index: 0, delta: {}, finish_reason: 'stop' }])
    + (request.includeUsage ? event([], { usage }) : '') + 'data: [DONE]\n\n';
  return new Response(payload, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

function gate(limit) {
  let active = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (signal, work) => {
    if (signal.aborted) throw signal.reason;
    if (active >= limit) await new Promise((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', aborted); resolve(); };
      const aborted = () => { const i = waiting.indexOf(ready); if (i >= 0) waiting.splice(i, 1); reject(signal.reason); };
      waiting.push(ready); signal.addEventListener('abort', aborted, { once: true });
    });
    else active++;
    try { if (signal.aborted) throw signal.reason; return await work(); } finally { release(); }
  };
}

async function boundedText(response, maxBytes, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail(502, 'response_too_large', 'Upstream response exceeds the safe size limit.'); }
      chunks.push(value);
    }
    if (signal.aborted) throw signal.reason;
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

export function createAdapter({ apiKey, options = {}, fetchImpl = globalThis.fetch } = {}) {
  const opts = normalizeOptions(options), run = gate(opts.batchConcurrency);
  return async (input, init = {}) => {
    let timer;
    const ctl = new AbortController();
    const cancel = () => ctl.abort(init.signal.reason);
    if (init.signal?.aborted) cancel(); else init.signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (ctl.signal.aborted) throw ctl.signal.reason;
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.pathname.endsWith('/chat/completions')) fail(400, 'unsupported_endpoint', 'Use Frog OpenAI-compatible Chat Completions, not Responses.');
      if ((init.method ?? 'POST').toUpperCase() !== 'POST') fail(405, 'unsupported_method', 'Translation requires POST.');
      if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) fail(401, 'missing_api_key', 'Log in to the doubao-seed provider with your Volcengine Ark API key.');
      const bodyText = typeof init.body === 'string' ? init.body : init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : '';
      if (encoder.encode(bodyText).byteLength > opts.maxInputChars * 6 + 65536) fail(413, 'request_too_large', 'Request body is too large.');
      let body;
      try { body = JSON.parse(bodyText); } catch { fail(400, 'invalid_json', 'Invalid JSON request body.'); }
      const req = parseTranslationRequest(body, opts);
      timer = setTimeout(() => ctl.abort(new DOMException('Deadline exceeded', 'TimeoutError')), opts.timeoutMs);
      const results = await Promise.all(req.segments.map(text => run(ctl.signal, async () => {
        // Validate input before spending quota and before trusting generated markup.
        htmlTokens(text);
        const translationOptions = { ...(req.source ? { source_language: req.source } : {}), target_language: req.target };
        const response = await fetchImpl(opts.upstreamURL, {
          method: 'POST', redirect: 'error', signal: ctl.signal,
          headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: opts.upstreamModel, stream: false, input: [{ role: 'user', content: [{ type: 'input_text', text, translation_options: translationOptions }] }] }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new AdapterError(response.status, 'upstream_http_error', `Doubao translation returned HTTP ${response.status}. Check credentials, model access or quota in Magpie.`, response.headers.get('retry-after'));
        }
        let data;
        try { data = JSON.parse(await boundedText(response, Math.max(65536, text.length * 24), ctl.signal)); }
        catch (e) { if (e instanceof AdapterError || ctl.signal.aborted) throw e; fail(502, 'upstream_invalid_json', 'Doubao returned an invalid response.'); }
        if (data?.error || (data?.status && data.status !== 'completed')) fail(502, 'upstream_incomplete', 'Doubao did not complete the translation.');
        const content = (data?.output ?? []).filter(item => item?.type === 'message').flatMap(item => item.content ?? []).filter(part => part?.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('');
        const translated = content.trim();
        if (!translated) fail(502, 'upstream_empty_output', 'Doubao response did not contain translated output_text.');
        if (req.batch && SEPARATOR.test(translated)) fail(502, 'batch_integrity', 'A translation introduced a batch separator; result was rejected.');
        validateStructure(text, translated);
        const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
        const prompt = count(data.usage?.input_tokens), completion = count(data.usage?.output_tokens);
        return { text: translated, usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: count(data.usage?.total_tokens) || prompt + completion } };
      })));
      const usage = results.reduce((sum, result) => { for (const key of Object.keys(sum)) sum[key] += result.usage[key]; return sum; }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      return completionResponse(results.map(r => r.text).join('\n\n%%\n\n'), usage, req);
    } catch (error) {
      if (init.signal?.aborted) return errorResponse(new AdapterError(499, 'request_cancelled', 'Translation was cancelled.'));
      if (ctl.signal.aborted && ctl.signal.reason?.name === 'TimeoutError') return errorResponse(new AdapterError(504, 'translation_timeout', 'Translation exceeded the configured deadline.'));
      ctl.abort();
      return errorResponse(error instanceof AdapterError ? error : new AdapterError(502, 'upstream_network_error', 'Could not complete the Doubao request. Check the Magpie provider network settings.'));
    } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', cancel); }
  };
}
