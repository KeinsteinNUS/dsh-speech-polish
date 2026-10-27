给 DeepSeek Harness **内置**的本地语音转写加一层术语纠错：同音字、近音字、专业名词、数字写法错误，在文字进入输入框之前就被修好。不新增按钮、不换引擎、音频不出本机。

## 安装

**推荐**：用本 Release 附带的预构建包（免构建、不需要 git）：

```bash
dsh plugin --profile <你的profile> add https://github.com/KeinsteinNUS/dsh-speech-polish/releases/download/v0.1.0/dsh-speech-polish-0.1.0.tgz
```

或者直接从仓库装（走 https）：

```bash
dsh plugin --profile <你的profile> add git+https://github.com/KeinsteinNUS/dsh-speech-polish.git
```

> 不要写 `github:KeinsteinNUS/dsh-speech-polish`：npm / pnpm 会把它解析成 SSH（`git@github.com:...`），没有 SSH key 的机器会报 `Permission denied (publickey)`。

装好后在 **插件管理 → 语音输入 Bundle 详情** 里把「识别器」选成 `SenseVoice + glossary fix`、语言选中文；也可以直接写进 profile 的 `cordis.patch.yml`：

```yaml
- id: speech-to-text
  config:
    defaultProvider: sensevoice-polish
    language: zh
```

## 需要什么

- DSH 0.2.x，且启用了内置语音输入（`@deepseek-ai/dsh-experimental-voice-input-bundle`）。
- 一个 OpenAI 兼容的 chat 端点做纠错，默认 DeepSeek。密钥按 `apiKey` → 环境变量 `DEEPSEEK_API_KEY` → `~/.dsh/.credentials.yaml` 的三级顺序查找；找不到就静默返回原始转写。

## 实测

同一句话：底层识别 `把悬图的转速改成三天转，退火温度120度。` → 纠错后 `把旋涂的转速改成3000转，退火温度120度。`

额外耗时约 1.0 秒。离线冒烟测试 8 项全过（`npm test`）。

## 校验信息

| 项目 | 值 |
| --- | --- |
| 版本 | 0.1.0 |
| 包大小 | 12.1 kB（8 个文件，未压缩 26.9 kB） |
| 依赖 | 无运行时依赖 |
| 许可证 | MIT |

音频始终留在本机，只有已经转写好的文字会发给模型端点；任何一步失败都原样返回原始转写，不会让听写坏掉。
