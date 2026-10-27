# dsh-speech-polish

> A terminology-aware correction layer for DeepSeek Harness's **built-in** local
> speech-to-text. Homophones, near-homophones, domain terms and malformed numbers
> are fixed before the transcript reaches the composer.
>
> No extra button, no engine swap, audio never leaves the machine.

[中文](README.md)

## Why

DSH's built-in dictation runs the local SenseVoiceSmall model (int8, ~239 MB).
It handles everyday speech, but **technical vocabulary is wrong almost every
time**. Measured on four Chinese technical sentences (103 characters, local
SenseVoice, Chinese forced):

| Setup | Character error rate |
| --- | --- |
| raw recognizer, `auto` language | 16.5% |
| raw recognizer, `zh` forced | 14.6% |
| VAD / segmentation tuning | 16.5% – 17.5% (no gain) |
| **+ this plugin** | glossary term hits **10/13 → 13/13** |

One real dictation (2026-10-27, plugin 0.2.1, host Node v24.21):

| Stage | Text |
| --- | --- |
| raw recognizer | 把**悬图**的转速改成**三天转**，退火温度120度。 |
| corrected | 把**旋涂**的转速改成**3000转**，退火温度120度。 |

Both mistakes fixed, at a cost of about **1.0 s** per utterance.

## How it plugs in

DSH's dictation is a service plus pluggable recognizer *providers*. This plugin
registers one more provider that wraps an existing one:

```
microphone → bundled local SenseVoice (audio stays local)
           → transcript → one temperature=0 LLM pass with your glossary
           → corrected text → composer
```

The UI does not change: same composer microphone, one extra recognizer in the
picker.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-speech-polish
```

Then open the plugin manager → the voice-input bundle details and select
**SenseVoice + glossary fix** as the recognizer (language: Chinese). Or set it in
your profile's `cordis.patch.yml`:

```yaml
- id: speech-to-text
  config:
    defaultProvider: sensevoice-polish
    language: zh
```

Restart the desktop app (or touch `cordis.patch.yml`, which makes the host
re-import plugins) to apply.

### API key

The correction pass needs an OpenAI-compatible chat endpoint (DeepSeek by
default). Resolution order:

1. `apiKey` in the plugin config;
2. `DEEPSEEK_API_KEY` environment variable;
3. DSH's own credential store, `refs.DEEPSEEK_API_KEY` in
   `~/.dsh/.credentials.yaml` (tries `DSH_HOME`, then `<home>/.dsh`, then
   `HOME/.dsh`).

If none is found the plugin stays silent and returns the raw transcript.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `baseProviderId` | `sensevoice-local` | recognizer to wrap |
| `providerId` | `sensevoice-polish` | id this plugin registers |
| `label` | `SenseVoice + glossary fix` | name shown in settings |
| `model` | `deepseek-chat` | correction model |
| `baseURL` | `https://api.deepseek.com` | any OpenAI-compatible endpoint |
| `apiKey` | empty | explicit key, highest priority |
| `timeoutMs` | `8000` | per-correction timeout |
| `minChars` | `4` | skip very short utterances |
| `maxGrowthRatio` | `0.6` | reject outputs that grow/shrink too much |
| `glossary` | built-in generic list | **your domain terms**, replaces the default |
| `instruction` | empty | extra instruction appended to the prompt |
| `enabled` | `true` | when false, pure pass-through |
| `traceFile` | off | enable a JSONL trace of every step |

## Diagnostics

With `traceFile` enabled, every stage appends one JSON line: `apply`, `enter`,
`raw`, `polished`, `skip`, `error`. No `apply` means the plugin never loaded; no
`enter` means it loaded but is not the selected recognizer; `error` carries the
real exception message.

## Privacy and failure policy

- Audio never leaves the machine; only the finished transcript is sent.
- Any failure (network, timeout, implausible output, missing key) returns the raw
  transcript — dictation never breaks because of this layer.
- No logging or indexing by default.

## Compatibility

Requires the `ctx.speechToText` service from
`@deepseek-ai/dsh-experimental-speech-to-text` (DSH 0.2.x). Verified on Windows
desktop with DSH 0.2.1-rc.3 (host Node v24.21). It is recognizer-agnostic: point
`baseProviderId` at any other provider to wrap that one instead.

## Development

```bash
npm test    # offline smoke test with a stubbed model endpoint
```

## License

MIT
