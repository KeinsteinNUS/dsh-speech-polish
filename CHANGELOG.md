# Changelog

## 0.1.0 (unreleased)

Initial public release, extracted from a local deployment that had been running
against DSH 0.2.1-rc.3.

- Registers a `speech-to-text` provider that wraps an existing recognizer
  (default `sensevoice-local`) and adds one terminology-aware LLM correction pass.
- Audio never leaves the machine; only the finished transcript is sent.
- Failures (network, timeout, missing key, implausible output) fall back to the
  raw transcript instead of breaking dictation.
- Configurable glossary, model, endpoint, timeout and minimum length.
- Opt-in JSONL trace for after-the-fact diagnosis
  (`apply` / `enter` / `raw` / `polished` / `skip` / `error`).
- Credential resolution: explicit config → `DEEPSEEK_API_KEY` → DSH credential
  store, including the `<user-profile>/.dsh` fallback for hosts that do not
  export `DSH_HOME`.
- Offline smoke test (`npm test`) with a stubbed model endpoint.
