# Obsidian Cat 中文快速开始

Obsidian Cat 是一个 Obsidian 插件。安装后，你可以在 Obsidian 中配置大模型和 MinerU API，然后把 PDF 拖给桌面小猫，自动生成文献笔记。

## 1. 安装插件

1. 下载 `obsidian-cat-plugin-0.1.0.zip`。
2. 解压后得到 `obsidian-cat` 文件夹。
3. 把这个文件夹复制到你的 Obsidian vault：

```text
你的Vault/.obsidian/plugins/obsidian-cat
```

4. 打开 Obsidian。
5. 进入 `设置 -> 第三方插件`。
6. 关闭安全模式，然后启用 `Obsidian Cat`。

## 2. 打开设置页

进入：

```text
设置 -> 第三方插件 -> Obsidian Cat
```

建议先把 `界面语言` 设为 `中文`。

## 3. 第一次配置

1. 点击 `初始化`
   - 创建 `raw/`、`wiki/`、`templates/` 等目录。
   - 不会删除已有文件。

2. 填写 `大模型 API`
   - `Base URL`：大模型接口地址。
   - `模型`：模型名称。
   - `API key`：你的大模型 key。
   - 如果只是测试，可以先打开 `草稿模式`，这样不会调用大模型。

3. 填写 `MinerU API`
   - 开启 `启用 MinerU`。
   - 在 `MinerU tokens` 中填入 token。
   - `解析语言` 通常填 `ch`。

4. 设置 `总结正文语言`
   - 选择 `中文`：生成中文文献笔记。
   - 选择 `English`：生成英文文献笔记。

5. 点击 `同步`
   - 把设置同步给桌面小猫 companion。

## 4. 启动小猫

点击：

```text
启动桌面小猫
```

小猫会出现在桌面。之后你可以把 PDF 直接拖到小猫身上。

如果关闭 Obsidian，小猫可以继续留在桌面。再次打开 Obsidian 时，插件会复用已有小猫，不会重复启动第二只。

## 5. PDF 处理结果

```text
ingest/              临时投喂目录
raw/parsed/          MinerU 解析后的 Markdown
wiki/assets/         PDF 图片
wiki/sources/        生成的文献笔记
raw/processed_pdfs/  已处理 PDF
```

文献笔记默认会使用论文标题命名：

```text
wiki/sources/论文标题.md
```

笔记会包含文献信息、研究分类、结构化摘要、结果证据表、关键图片与图注、可复用概念和后续问题。

## 6. 常见问题

### 设置后没有生效

点击设置页里的 `同步`。

### PDF 没有解析

检查：

- MinerU 是否开启。
- MinerU token 是否填写。
- 小猫是否已启动。
- 是否点击过 `同步`。

### 不想调用大模型

打开 `草稿模式`。插件会生成 draft，不会调用 LLM。

### 想恢复默认目录和提示词

点击：

```text
恢复当前 Vault 默认值
```

然后点击：

```text
同步
```

