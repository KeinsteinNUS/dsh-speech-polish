// Offline smoke test: stubs the model endpoint, so `npm test` needs no network
// and no API key. It exercises the whole provider path the host would use.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const plugin = await import('../index.js');

const RAW = '把悬图的转速改成三000转，退火温度120度。';
const FIXED = '把旋涂的转速改成3000转，退火温度120度。';

function createCtx({ baseText = RAW, registerError } = {}) {
  const logs = [];
  const calls = [];
  const baseProvider = {
    info: { id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto', 'zh'] },
    async transcribe() {
      calls.push('base');
      return { text: baseText, audioSeconds: 3.2, inferenceSeconds: 0.28 };
    },
  };
  const ctx = {
    logger: { warn: (...a) => logs.push(a.join(' ')), info: () => {} },
    effect(fn) {
      return fn();
    },
    speechToText: {
      providers: new Map([['sensevoice-local', { provider: baseProvider }]]),
      register(provider) {
        if (registerError) throw registerError;
        this.registered = provider;
        this.providers.set(provider.info.id, { provider });
        return async () => this.providers.delete(provider.info.id);
      },
      resolve(request) {
        const registration = this.providers.get(request.providerId);
        if (!registration) throw new Error(`no provider ${request.providerId}`);
        return { provider: registration.provider, audio: request.audio, language: request.language };
      },
      async transcribe(spec) {
        calls.push('service');
        return spec.provider.transcribe({ audio: spec.audio, language: spec.language });
      },
      config: { defaultProvider: { get: () => 'sensevoice-polish' } },
    },
  };
  return { ctx, logs, calls };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => handler(...args);
  return () => {
    globalThis.fetch = original;
  };
}

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const completion = (content) => jsonResponse({ choices: [{ message: { content } }] });

// 1. happy path: raw text is corrected and the rest of the result is preserved.
{
  const { ctx } = createCtx();
  const restore = stubFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.temperature, 0);
    assert.ok(body.messages.some((m) => m.content.includes(RAW)));
    assert.ok(body.messages[0].content.includes('术语表'));
    return completion(FIXED);
  });
  plugin.apply(ctx, { apiKey: 'test-key' });
  try {
    assert.equal(ctx.speechToText.registered.info.id, 'sensevoice-polish');
    assert.ok(ctx.speechToText.registered.info.languages.includes('zh'));
    const result = await ctx.speechToText.registered.transcribe({ audio: 'wav', language: 'zh' });
    assert.equal(result.text, FIXED);
    assert.equal(result.audioSeconds, 3.2);
    assert.equal(result.inferenceSeconds, 0.28);
  } finally {
    restore();
  }
}

// 2. endpoint failure: raw transcript survives untouched.
{
  const { ctx, logs } = createCtx();
  const restore = stubFetch(async () => jsonResponse({ error: 'nope' }, 500));
  plugin.apply(ctx, { apiKey: 'test-key' });
  try {
    const result = await ctx.speechToText.registered.transcribe({ audio: 'wav', language: 'zh' });
    assert.equal(result.text, RAW);
    assert.ok(logs.some((line) => line.includes('correction skipped')));
  } finally {
    restore();
  }
}

// 3. implausible output (wrong length) is rejected instead of applied.
{
  const { ctx } = createCtx();
  const restore = stubFetch(async () => completion('旋涂'));
  plugin.apply(ctx, { apiKey: 'test-key' });
  try {
    const result = await ctx.speechToText.registered.transcribe({ audio: 'wav', language: 'zh' });
    assert.equal(result.text, RAW);
  } finally {
    restore();
  }
}

// 4. short utterances skip the model call entirely.
{
  const { ctx } = createCtx({ baseText: '嗯。' });
  let called = false;
  const restore = stubFetch(async () => {
    called = true;
    return completion('嗯');
  });
  plugin.apply(ctx, { apiKey: 'test-key' });
  try {
    const result = await ctx.speechToText.registered.transcribe({ audio: 'wav', language: 'zh' });
    assert.equal(result.text, '嗯。');
    assert.equal(called, false);
  } finally {
    restore();
  }
}

// 5. missing API key: raw transcript, no request, no throw.
{
  const { ctx } = createCtx();
  const restore = stubFetch(async () => {
    throw new Error('should not be called');
  });
  plugin.apply(ctx, {}); // no apiKey, and the test environment has no credentials
  try {
    const result = await ctx.speechToText.registered.transcribe({ audio: 'wav', language: 'zh' });
    assert.equal(result.text, RAW);
  } finally {
    restore();
  }
}

// 6. credential lookup: DSH_HOME, then <profile>/.dsh, deduplicated.
{
  const candidates = plugin.credentialCandidates({ DSH_HOME: 'C:/a/.dsh', USERPROFILE: 'C:/u', HOME: undefined });
  assert.deepEqual(candidates, [join('C:/a/.dsh', '.credentials.yaml'), join('C:/u', '.dsh', '.credentials.yaml')]);
  const deduped = plugin.credentialCandidates({ DSH_HOME: 'C:/u/.dsh', USERPROFILE: 'C:/u' });
  assert.equal(deduped.length, 1);
}

// 7. credential file is read from the profile fallback when DSH_HOME is unset.
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-polish-'));
  mkdirSync(join(home, '.dsh'), { recursive: true });
  const file = join(home, '.dsh', '.credentials.yaml');
  writeFileSync(file, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-test\n', { encoding: 'utf8' });
  const resolved = plugin.resolveApiKey({}, { USERPROFILE: home });
  assert.equal(resolved.key, 'sk-test');
  assert.equal(resolved.source, `credentials:${file}`);
}

// 8. reply cleanup strips code fences and wrappers.
{
  assert.equal(plugin.cleanReply('```text\n把旋涂改好\n```'), '把旋涂改好');
  assert.equal(plugin.cleanReply('纠正后：把旋涂改好'), '把旋涂改好');
  assert.equal(plugin.cleanReply('“把旋涂改好”'), '把旋涂改好');
}

console.log('dsh-speech-polish: 8 checks passed');
