# dsh-speech-polish

> 给 DeepSeek Harness **内置**的本地语音转写加一层术语纠错：同音字、近音字、专业名词、数字写法错误，在文字进入输入框之前就被修好。
>
> 不新增按钮、不换引擎、音频不出本机。

[English](README.en.md)

## 它解决什么问题

DSH 内置语音输入走的是本地 SenseVoiceSmall（int8，约 239 MB），日常对话够用，但**专业词几乎必错**。实测 4 句中文技术句（103 字，本地 SenseVoice，锁中文）：

| 配置 | 字错率 CER |
| --- | --- |
| 原始识别（`auto` 语言） | 16.5% |
| 原始识别（锁 `zh`） | 14.6% |
| 调 VAD 阈值 / 放宽切段 | 16.5% ~ 17.5%（无收益） |
| **+ 本插件纠错** | 术语命中 **10/13 → 13/13** |

真实口述一轮（2026-10-27，本插件 0.2.1，宿主 Node v24.21）：

| 阶段 | 文本 |
| --- | --- |
| 底层 `raw` | 把**悬图**的转速改成**三天转**，退火温度120度。 |
| 纠错后 | 把**旋涂**的转速改成**3000转**，退火温度120度。 |

同一句话里的两处错误都被修好，额外耗时约 **1.0 秒**。

## 它是怎么接进去的

DSH 的语音输入是一个服务 + 若干「识别器（provider）」。本插件**注册一个新的 provider**，内部：

```
麦克风 → 内置 SenseVoice（本地，音频不出机器）
        → 拿到文字 → 一次 temperature=0 的 LLM 纠错（带术语表）
        → 返回修正后的文字 → 输入框
```

所以你的界面完全不变：还是输入框那个麦克风，只是设置里的识别器多了一项。

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-speech-polish
```

然后在 **插件管理页 → 语音输入 Bundle 的详情**里，把「识别器」选成 **SenseVoice + glossary fix**，语言选中文。

也可以直接写进 profile 的 `cordis.patch.yml`：

```yaml
- id: speech-to-text
  config:
    defaultProvider: sensevoice-polish
    language: zh
```

重启桌面端（或改一下 `cordis.patch.yml` 触发宿主重新加载插件）后生效。

### 密钥

纠错这一步需要一个 OpenAI 兼容的 chat 接口。默认用 DeepSeek：

1. 插件配置里的 `apiKey`；
2. 环境变量 `DEEPSEEK_API_KEY`；
3. DSH 自己的凭据库 `~/.dsh/.credentials.yaml` 中的 `refs.DEEPSEEK_API_KEY`（依次尝试 `DSH_HOME`、`<用户目录>/.dsh`、`HOME/.dsh`）。

三者都找不到时**不报错**，直接返回原始识别结果。

## 配置

写在 bundle patch 的 `speech-polish` 行的 `config` 里：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseProviderId` | `sensevoice-local` | 底层识别器 id |
| `providerId` | `sensevoice-polish` | 本插件注册的 id |
| `label` | `SenseVoice + glossary fix` | 设置里显示的名字 |
| `model` | `deepseek-chat` | 纠错模型 |
| `baseURL` | `https://api.deepseek.com` | OpenAI 兼容端点（可换任何厂商/自建网关） |
| `apiKey` | 空 | 显式密钥，优先于环境变量与凭据库 |
| `timeoutMs` | `8000` | 单次纠错超时 |
| `minChars` | `4` | 短于此长度的文本不纠错（“嗯”“好的”） |
| `maxGrowthRatio` | `0.6` | 输出相对原文允许的最大膨胀，超出即丢弃该次纠错 |
| `glossary` | 内置通用技术词表 | **你的领域术语**，数组；替换内置表 |
| `instruction` | 空 | 追加给模型的额外要求（口吻、单位习惯等） |
| `enabled` | `true` | 关掉后只做透传 |
| `traceFile` | 关闭 | 打开后把每步写入 JSONL，便于排查 |

### 领域术语表

内置表只有通用技术词。材料的、医疗的、法务的术语请自己加：

```yaml
- id: speech-polish
  config:
    glossary: [液晶盒, 取向层, 旋涂, 退火, 相位延迟, 氧化铟锡, 偏振响应, 双折射]
```

术语表只用于“同音错写时该改成什么”，不会让模型无中生有——输出长度偏离原文 40%~160% 之外会被判定不可信并丢弃。

## 诊断

打开 `traceFile` 后，每个阶段一行 JSON：

| event | 含义 |
| --- | --- |
| `apply` | 插件被宿主加载并注册（含 node 版本、密钥来源、当前选中的识别器） |
| `enter` | 有一次真实转写进入本 provider（说明它就是当前选中的那个） |
| `raw` | 底层识别的原始文本 |
| `polished` | 纠错成功（耗时、是否改动、最终文本） |
| `skip` | 主动跳过（`too-short` / `disabled` / `no-api-key`） |
| `error` | 出错并已回退到原文（`message` 是真实原因） |

判读：没有 `apply` = 没加载；有 `apply` 没 `enter` = 加载了但没被选中；有 `enter` + `error` = 纠错调用失败。

## 隐私与失败策略

- **音频不出本机**。只有已经转好的文字会发给模型端点。
- 任何失败（网络、超时、输出离谱、没有密钥）都**原样返回**原始转写，不会让听写坏掉。
- 不写日志、不建索引；`traceFile` 默认关闭。

## 兼容性

- 依赖 `@deepseek-ai/dsh-experimental-speech-to-text` 暴露的 `ctx.speechToText` 服务（DSH 0.2.x）。
- 只在 Windows 桌面端实测（DSH 0.2.1-rc.3，宿主 Node v24.21）；理论上与识别器实现无关，换 `baseProviderId` 即可套在别的识别器外面。

## 开发

```bash
npm test          # 离线冒烟测试，桩掉模型端点，不需要网络与密钥
```

## 与其他语音插件的区别

社区里已有不少语音输入插件（`dsh-ears`、`dsh-voice-scribe`、`dsh-voice-mic` 等），它们大多**另起一套**麦克风与管线，用云端 ASR 或其它本地引擎替换内置方案。

本插件走另一条路：**保留内置识别器，只给它补一个纠错层**。适合这样的场景：接受本地小模型的识别率、但受不了专业词被写成同音别字；不想再挂一个麦克风按钮；不希望录音上传。

## License

MIT
