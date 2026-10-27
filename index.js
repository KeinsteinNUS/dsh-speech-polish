/**
 * dsh-speech-polish — a terminology-aware correction layer for DSH's built-in
 * local speech-to-text.
 *
 * The plugin registers an extra `speech-to-text` provider that delegates
 * recognition to an existing provider (by default the bundled local
 * `sensevoice-local`), then runs one low-temperature LLM pass over the raw
 * transcript to repair homophone / near-homophone mistakes before the text ever
 * reaches the composer.
 *
 * Design rules:
 * - No new UI, no second microphone button: it plugs into the built-in speech
 *   service, so the composer keeps working exactly as before.
 * - Audio never leaves the machine; only the finished transcript is sent.
 * - Any failure (network, timeout, odd output) returns the raw transcript
 *   unchanged, so dictation cannot break because of this layer.
 * - Everything can be traced to a JSONL file for after-the-fact diagnosis.
 *
 * @license MIT
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-speech-polish';
export const inject = ['speechToText'];

/** Language hints forwarded to the underlying recognizer. */
const LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'];

/**
 * Words that global Chinese ASR models frequently confuse with near-homophones.
 * Domain-specific vocabulary belongs in the `glossary` option; this list only
 * carries broadly useful technical terms.
 */
const DEFAULT_GLOSSARY = [
  '卷积核', '边界填充', '步长', '池化', '张量', '梯度', '正则化', '损失函数',
  '递归', '迭代', '编译', '解释器', '序列化', '反序列化', '线程池', '协程',
  '缓存', '索引', '重构', '部署', '回滚', '灰度', '熔断', '限流', '幂等',
  '阈值', '帧率', '采样率', '带宽', '延迟', '抖动', '分辨率', '编码', '解码',
  '协议', '接口', '指针', '引用', '内存泄漏', '死锁', '竞态', '事务', '主键',
];

const SYSTEM_PROMPT = [
  '你是语音转写文本的纠错器。输入是 ASR 产出的原始文本，可能含同音字、近音字、',
  '专有名词写错、数字写法异常、标点缺失。',
  '',
  '任务：在完全不改变说话人原意、不增加也不删减信息的前提下，纠正这些错误。',
  '',
  '规则：',
  '1. 只输出纠正后的正文本身。不要解释、不要前后缀、不要引号、不要 Markdown 代码块。',
  '2. 保持原句的语气、语序和粒度；拿不准的地方原样保留，不要臆测改写。',
  '3. 只改字，不改口吻，不把口语润色成书面语，不合并或拆分句子。',
  '4. 数字与单位：明显异常的写法要修正（例如“三000转”改为“3000转”），',
  '   其余保持原样；代码标识符、单位符号（3×3、120℃、16kHz、0.5s）原样保留。',
  '5. 标点只做最小补全，让句子可读即可。',
  '6. 优先使用术语表中的写法。',
  '',
  '术语表（出现同音错写时按此纠正）：',
].join('\n');

function homeDir() {
  return process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
}

/**
 * Candidate locations of the DSH credential store, in order.
 *
 * The desktop Host process does NOT always export `DSH_HOME` (measured: it
 * exports only `USERPROFILE`), so `<user-profile>/.dsh/.credentials.yaml` is a
 * required candidate — without it the API key is never found and every
 * transcript silently falls back to the unpolished text.
 */
export function credentialCandidates(env = process.env) {
  const roots = [
    env.DSH_HOME,
    env.USERPROFILE ? join(env.USERPROFILE, '.dsh') : undefined,
    env.HOME ? join(env.HOME, '.dsh') : undefined,
  ].filter(Boolean);
  return [...new Set(roots.map((root) => join(root, '.credentials.yaml')))];
}

function readKeyFromCredentials(env) {
  const tried = [];
  for (const file of credentialCandidates(env)) {
    tried.push(file);
    try {
      const text = readFileSync(file, 'utf8');
      const match = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
      if (match) return { key: match[1], source: `credentials:${file}`, tried };
    } catch {}
  }
  return { key: undefined, source: 'missing', tried };
}

/** Resolution order: explicit config → environment → DSH credential store. */
export function resolveApiKey(config = {}, env = process.env) {
  if (config.apiKey) return { key: config.apiKey, source: 'config', tried: [] };
  if (env.DEEPSEEK_API_KEY) return { key: env.DEEPSEEK_API_KEY, source: 'env', tried: [] };
  return readKeyFromCredentials(env);
}

/** `AbortSignal.any` needs Node 20.3+/18.17+; fall back to a manual race. */
function combineSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === 'function') {
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  timeout.addEventListener('abort', abort, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

/** Strip the wrappers a chat model sometimes adds around a bare answer. */
export function cleanReply(text) {
  let value = String(text ?? '').trim();
  value = value.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  value = value.replace(/^(纠正后|修正后|结果|输出)\s*[：:]\s*/, '');
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('“') && value.endsWith('”'))) {
    value = value.slice(1, -1).trim();
  }
  if ((value.startsWith('「') && value.endsWith('」')) || (value.startsWith('『') && value.endsWith('』'))) {
    value = value.slice(1, -1).trim();
  }
  return value.replace(/\s+\n/g, '\n').trim();
}

async function polish({ text, glossary, model, baseURL, apiKey, timeoutMs, signal, instruction }) {
  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n${glossary.join('、')}` },
    ...(instruction ? [{ role: 'user', content: instruction }] : []),
    { role: 'user', content: text },
  ];
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 1024, stream: false }),
    signal: combineSignal(signal, timeoutMs),
  });
  if (!response.ok) throw new Error(`polish endpoint ${response.status}`);
  const payload = await response.json();
  const reply = payload?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string') throw new Error('polish endpoint returned no content');
  return cleanReply(reply);
}

/**
 * Mount the correction provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const baseProviderId = config.baseProviderId ?? 'sensevoice-local';
  const providerId = config.providerId ?? 'sensevoice-polish';
  const label = config.label ?? 'SenseVoice + glossary fix';
  const enabled = config.enabled !== false;
  const model = config.model ?? 'deepseek-chat';
  const baseURL = String(config.baseURL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const timeoutMs = Number(config.timeoutMs ?? 8000);
  const minChars = Number(config.minChars ?? 4);
  const maxGrowth = Number(config.maxGrowthRatio ?? 0.6);
  const instruction = config.instruction ?? '';
  const glossary = Array.isArray(config.glossary) && config.glossary.length
    ? config.glossary
    : DEFAULT_GLOSSARY;

  // Tracing is opt-in: a published plugin should not write files by default.
  const traceFile = config.traceFile
    ? String(config.traceFile)
    : undefined;
  const traceCandidates = traceFile
    ? [traceFile, join(tmpdir(), 'speech-polish-trace.jsonl')]
    : [];
  let tracePath;

  const trace = (event, data) => {
    if (!traceCandidates.length) return;
    const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`;
    for (const target of tracePath ? [tracePath] : traceCandidates) {
      try {
        appendFileSync(target, line);
        tracePath = target;
        return;
      } catch {}
    }
  };

  const underlying = () => ctx.speechToText.providers.get(baseProviderId)?.provider;
  const knownProviders = () => [...ctx.speechToText.providers.keys()];

  const preparation = {
    subscribe(listener) {
      const target = underlying()?.preparation;
      return target ? target.subscribe(listener) : () => {};
    },
    snapshot() {
      return underlying()?.preparation?.snapshot() ?? { phase: 'ready' };
    },
    prepare(options) {
      trace('prepare', { options: options === undefined ? null : true });
      return underlying()?.preparation?.prepare(options);
    },
    async cancel() {
      await underlying()?.preparation?.cancel();
    },
  };

  ctx.effect(() => {
    const dispose = ctx.speechToText.register({
      info: { id: providerId, name: label, location: 'host-local', languages: LANGUAGES },
      preparation,
      transcribe: async (input, signal) => {
        trace('enter', { language: input?.language ?? null, hasBase: Boolean(underlying()) });
        if (!underlying()) {
          trace('error', { where: 'base-missing', baseProviderId, known: knownProviders() });
          throw new Error(`speech provider not registered: ${baseProviderId}`);
        }
        const spec = ctx.speechToText.resolve({
          providerId: baseProviderId,
          audio: input.audio,
          language: input.language,
        });
        const raw = await ctx.speechToText.transcribe(spec, signal);
        const source = String(raw?.text ?? '').trim();
        trace('raw', { text: source, chars: source.length });
        if (!enabled || source.length < minChars) {
          trace('skip', { reason: enabled ? 'too-short' : 'disabled' });
          return raw;
        }

        const { key: apiKey, source: keySource, tried } = resolveApiKey(config);
        if (!apiKey) {
          trace('skip', { reason: 'no-api-key', keySource, tried });
          ctx.logger?.warn?.('speech-polish: no DEEPSEEK_API_KEY, keeping the raw transcript');
          return raw;
        }
        try {
          const startedAt = Date.now();
          const corrected = await polish({ text: source, glossary, model, baseURL, apiKey, timeoutMs, signal, instruction });
          const sane = corrected.length > 0
            && corrected.length <= source.length * (1 + maxGrowth)
            && corrected.length >= source.length * 0.4;
          trace('polished', { keySource, ms: Date.now() - startedAt, changed: corrected !== source, sane, text: corrected });
          return sane && corrected !== source ? { ...raw, text: corrected } : raw;
        } catch (error) {
          trace('error', { where: 'polish', keySource, name: error?.name, message: String(error?.message ?? error) });
          ctx.logger?.warn?.(`speech-polish: correction skipped (${error?.message ?? error})`);
          return raw;
        }
      },
    });
    trace('apply', {
      providerId, baseProviderId, label, model, baseURL, timeoutMs, minChars, enabled, traceFile,
      node: process.version,
      hasFetch: typeof fetch,
      hasSignalAny: typeof AbortSignal.any,
      keySource: resolveApiKey(config).source,
      known: knownProviders(),
      selectionHint: (() => {
        try {
          return ctx.speechToText.config?.defaultProvider?.get?.() ?? null;
        } catch {
          return 'n/a';
        }
      })(),
    });
    return () => dispose();
  });
}
