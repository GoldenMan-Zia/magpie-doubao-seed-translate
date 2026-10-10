import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../index.mjs';

test('Magpie v1 entry declares a text-only Chat Completions provider', async () => {
  const hooks = await plugin.server({}); const cfg = {};
  await hooks.config(cfg);
  const p = cfg.provider['doubao-seed'];
  assert.equal(p.npm, '@ai-sdk/openai-compatible');
  assert.equal(p.models.translate.tool_call, false);
  assert.equal(hooks.auth.provider, 'doubao-seed');
  assert.equal(hooks.auth.methods[0].type, 'api');
  const loaded = await hooks.auth.loader(async () => ({ type: 'api', key: 'test-only-key' }));
  assert.equal(typeof loaded.fetch, 'function');
  assert.equal(loaded.apiKey, undefined);
  assert.match(loaded.baseURL, /\.invalid\/v1$/);
});

test('unsigned provider returns actionable error without network access', async () => {
  const hooks = await plugin.server({});
  for (const auth of [undefined, { type: 'oauth', access: 'not-valid-for-this-provider' }]) {
    const loaded = await hooks.auth.loader(async () => auth);
    const res = await loaded.fetch('https://adapter.invalid/v1/chat/completions', { body: '{}' });
    assert.equal(res.status, 401);
  }
});
