# Obsidian Cat 使用教程

Obsidian Cat 是一个 Obsidian 第三方插件，用来把桌面小猫、PDF 解析、LLM 文献总结和研究型 wiki 架构整合到同一个 vault 中。插件安装后会自带桌面小猫运行时，不需要用户再单独安装旧版 exe，也不依赖 Python。

## 1. 安装

1. 下载发布包 `obsidian-cat-plugin-0.1.0.zip`。
2. 解压后得到 `obsidian-cat` 文件夹。
3. 将该文件夹放入目标 vault：

```text
<your-vault>/.obsidian/plugins/obsidian-cat
```

4. 打开 Obsidian，进入 `Settings -> Community plugins`。
5. 关闭 Safe mode 后启用 `Obsidian Cat`。
6. 进入 `Settings -> Obsidian Cat` 完成配置。

## 2. 推荐首次配置

打开插件设置页后，按顺序配置：

1. `Interface language / 界面语言`
   - `中文`：设置页显示中文。
   - `English`：设置页显示英文。

2. `Quick Start / 快速开始`
   - 点击 `Initialize / 初始化`。
   - 插件只会创建缺失目录和模板，不会覆盖已有 `raw/` 或 `wiki/` 内容。

3. `Model API / 大模型 API`
   - `Base URL`：OpenAI-compatible chat completions 地址。
   - `Model`：模型名称。
   - `API key`：可直接填入，插件会保存到 Obsidian 插件 data 中。
   - `Temperature`：建议 `0.2`。
   - `Max tokens`：建议按模型上下文能力设置。
   - `Dry run`：关闭后才会调用 LLM 生成完整 source note；开启时只生成 draft。

4. `MinerU API`
   - 开启 `Enable MinerU / 启用 MinerU`。
   - 在 `MinerU tokens` 中填入 token，每行一个。
   - `Parse language` 通常使用 `ch` 或 `en`。
   - OCR、公式、表格提取按 PDF 类型启用。

5. `Wiki Architecture / Wiki 架构`
   - `Source-note body language / 总结正文语言`
     - `中文`：source note 正文中文，标题结构保持英文。
     - `English`：source note 正文英文。
   - 默认目录：
     - `raw/`：原始材料。
     - `raw/parsed/`：MinerU 解析后的 Markdown。
     - `wiki/assets/`：PDF 图片和资源。
     - `wiki/sources/`：文献总结 source notes。
     - `wiki/concepts/`：机制概念。
     - `wiki/methods/`：方法。
     - `wiki/materials/`：材料体系。
     - `wiki/questions/`：后续问题。

6. 点击 `Sync / 同步`
   - 将 Obsidian 设置同步给桌面 companion。

## 3. 日常使用流程

1. 启动 Obsidian。
2. 如果设置了自动启动，小猫会出现在桌面。
3. 将 PDF 拖到桌面小猫上。
4. 插件会将 PDF 放入 `ingest/` 队列。
5. Companion 调用 MinerU 解析 PDF。
6. 成功后输出：

```text
raw/parsed/<pdf-or-paper-stem>.md
wiki/assets/<paper-stem>/*
raw/mineru_manifest.csv
raw/processed_pdfs/<original>.pdf
```

7. LLM 根据 parsed Markdown 生成文献总结：

```text
wiki/sources/<paper-title>.md
```

8. 插件会继续从 source note 中提取或更新：

```text
wiki/concepts/
wiki/methods/
wiki/materials/
wiki/questions/
```

## 4. Source Note 默认格式

默认格式对齐当前 vault 的旧工作流：

```markdown
---
type: literature-note
status: processed
source_path: raw/parsed/example.md
created_by: Obsidian Cat
created_at: 2026-05-13T00:00:00.000Z
---

# Paper Title

## Citation
## Research Classification
## One-Sentence Takeaway
## Structured Abstract
## Key Contributions
## Methods And Experimental Design
## Results And Evidence
## Figures And Tables
### Key Figure Gallery
## Important Equations Or Variables
## Limitations And Caveats
## Reusable Concepts
## Links To Existing Vault Topics
## Follow-Up Questions
## Extraction Notes
```

文件名优先使用文献标题。正文结构会保留关键图片、图注、证据表、材料/方法/概念/问题链接。

## 5. PDF 与图片路径规则

MinerU 完整输出只作为中转：

```text
raw/mineru/
```

成功或失败后该目录会清理。最终文件位置是：

```text
raw/parsed/
wiki/assets/
```

图片链接会被改写为 Obsidian 可识别格式：

```markdown
![[wiki/assets/<paper-stem>/<image>.jpg]]
```

如果 LLM 没有主动写入图片，companion 会从 parsed Markdown 中自动提取最多 6 张关键图片和附近图注，补到 `### Key Figure Gallery`。

## 6. 关闭与重开 Obsidian

关闭 Obsidian 时，桌面小猫可以继续留在桌面。

再次打开 Obsidian 时，插件会优先复用已有小猫；桌面 companion 也有单实例锁，不会生成第二只独立小猫。

## 7. 重要按钮说明

- `Initialize / 初始化`
  - 创建缺失目录和模板。
  - 不删除已有文件。

- `Start Cat / 启动小猫`
  - 手动启动桌面小猫。

- `Sync / 同步`
  - 把设置页的 API、路径、prompt、模板同步到 companion。

- `Generate Architecture With LLM / 用 LLM 生成架构`
  - 根据研究需求生成目录、模板和提示词建议。

- `Apply Architecture / 应用架构`
  - 创建缺失目录和模板。

- `Reset To Current Vault Defaults / 恢复当前 Vault 默认值`
  - 恢复 `raw/` + `wiki/` 的默认架构与 source-note 格式。

## 8. 升级插件

1. 关闭 Obsidian。
2. 可保留现有：

```text
<vault>/.obsidian/plugins/obsidian-cat/data.json
```

3. 用新版 `obsidian-cat` 文件夹覆盖旧插件文件夹。
4. 打开 Obsidian，进入设置页点击 `Sync / 同步`。

新版插件包不会携带真实 `agent.config.json`，避免覆盖用户 API key 和 MinerU token。

## 9. 排错

### 设置页为空

重新安装最新插件包，然后重启 Obsidian。

### PDF 没有解析

检查：

- `MinerU tokens` 是否已填写。
- `Enable MinerU` 是否开启。
- `Sync / 同步` 是否点过。
- `http://127.0.0.1:4317/api/status` 是否在线。

### 图片不显示

检查 parsed Markdown 中是否是：

```markdown
![[wiki/assets/...]]
```

如果出现重复路径，例如 `wiki/assets/.../wiki/assets/...`，运行插件的 `Audit Vault` 后再重新处理。

### Source note 不是旧格式

在 `Wiki Architecture` 中点击：

```text
Reset To Current Vault Defaults
Sync Settings To Companion
```

然后重新处理 parsed Markdown 或重新投喂 PDF。

## 10. 开发命令

```powershell
npm run plugin:check
npm run dist:win
npm run plugin:bundle-runtime
```

生成插件 zip：

```powershell
Compress-Archive -Path obsidian-plugin/obsidian-cat/* -DestinationPath dist/obsidian-cat-plugin-0.1.0.zip -Force
```
