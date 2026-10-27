# 发布清单

按顺序做完就能上架：npm 上可被 `dsh plugin add` 安装，awesome-dsh-plugin 目录里有条目，dshmarket 会自动抓到。

## 0. 先替换占位符

| 文件 | 占位符 | 换成 |
| --- | --- | --- |
| `package.json` | `keinstein`（3 处：repository / homepage / bugs） | 你的 GitHub 用户名 |
| `package.json` | `author: ""` | 你的名字或 `名字 <邮箱>` |
| `LICENSE` | `dsh-speech-polish contributors` | 你的名字（可选） |
| `docs/awesome-plugin-entry.yml` | `keinstein`（2 处） | 同上 |

```bash
# 一次性替换（把 yourname 换成你的 GitHub 用户名）
node -e "const fs=require('fs');for(const f of ['package.json','docs/awesome-plugin-entry.yml']){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replaceAll('keinstein','yourname'))}"
```

## 1. 本地自检

```bash
npm test          # 必须输出 dsh-speech-polish: 8 checks passed
npm pack --dry-run   # 看清将要发布的文件清单
```

## 2. 建仓库并推上去

```bash
cd dsh-speech-polish
git init
git add .
git commit -m "dsh-speech-polish 0.1.0: terminology-aware correction layer for built-in STT"
git branch -M main
git remote add origin https://github.com/KeinsteinNUS/dsh-speech-polish.git
git push -u origin main
```

推完到仓库 **About → Topics** 加一个 `dsh-plugin`（目录站点靠这个 topic 做二次抓取）。

## 3. 发 npm

```bash
npm login                     # 已登录可跳过
npm publish --access public   # 名字 dsh-speech-polish，发布前已确认无人占用
```

发布后立刻验证真的能装：

```bash
dsh plugin --profile desktop add dsh-speech-polish
# 然后 插件管理 → 语音输入 Bundle 详情 → 识别器 选 "SenseVoice + glossary fix"
# 或者直接在 profile 的 cordis.patch.yml 里写 defaultProvider: sensevoice-polish
```

> 注意：`dsh plugin add` 会重建 profile 的依赖树。装之前把 `~/.dsh/profiles/<profile>` 备份一份更稳。
>
> 如果本地已经手工装过同名包（`link:` 依赖），先 `dsh plugin --profile desktop remove dsh-speech-polish`，否则会出现两个来源抢同一个包名。

## 4. 提交 awesome-dsh-plugin

```bash
git clone https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
cd awesome-dsh-plugin
cp <本仓库>/docs/awesome-plugin-entry.yml data/plugins/KeinsteinNUS__dsh-speech-polish.yml
git checkout -b add-dsh-speech-polish
git add data/plugins/KeinsteinNUS__dsh-speech-polish.yml
git commit -m "Add dsh-speech-polish (voice: terminology-aware correction for built-in STT)"
git push -u origin add-dsh-speech-polish
```

然后开 PR。只需这一个 YAML——README 和站点会从 `data/plugins/*.yml` 自动重生成。字段形状（已对照现有条目核过）：

```yaml
url: https://github.com/<owner>/<repo>
name: <owner>/<repo>
category: voice
description:
  en: '...'
  zh: '...'
```

## 5. 时机与后续

- npm 发布 + awesome PR 合并后，dshmarket 下一次抓取就能搜到（它抓 `awesome-dsh-plugin.com/plugins.json` 等目录）。
- 版本升级：改 `package.json` 的 `version`、补 `CHANGELOG.md`、`npm publish`；目录条目不用改（它指向仓库）。
- 建议在 README 顶部放一张真实 trace 截图或 before/after 对照，评审和用户都更容易买账。
