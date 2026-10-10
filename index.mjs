import { createAdapter, normalizeOptions, PROVIDER, MODEL } from './src/adapter.mjs';

export default {
  id: 'magpie-doubao-seed-translate',
  async server(_input, options) {
    const settings = normalizeOptions(options);
    return {
      async config(cfg) {
        cfg.provider ??= {};
        cfg.provider[PROVIDER] = {
          name: 'Doubao Seed Translation',
          npm: '@ai-sdk/openai-compatible',
          api: 'https://doubao-seed-adapter.invalid/v1',
          models: {
            [MODEL]: { name: 'Doubao Seed Translate (Frog)', tool_call: false, reasoning: false, attachment: false, modalities: { input: ['text'] }, limit: { context: 8192, output: 8192 } },
          },
        };
      },
      auth: {
        provider: PROVIDER,
        methods: [{ type: 'api', label: 'Volcengine Ark API key (Seed Translation)' }],
        async loader(getAuth) {
          const auth = await getAuth();
          return { baseURL: 'https://doubao-seed-adapter.invalid/v1', fetch: createAdapter({ apiKey: auth?.type === 'api' ? auth.key : '', options: settings }) };
        },
      },
    };
  },
};
