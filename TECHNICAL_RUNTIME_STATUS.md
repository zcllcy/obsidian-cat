# Cat Vault Agent Technical Runtime Status

更新时间: 2026-05-09

## 1. 项目概览

- 项目名称: `cat-vault-agent`
- 包版本: `0.1.0`
- 项目根目录: `E:\LLM_Research\cat-vault-agent`
- 当前目标: 用桌面小猫把 PDF、文本、URL 投喂进 Obsidian 知识库，并由本地后端串行处理
- 主知识库目录: `E:\LLM_Research\LCY_phonon_research`
- 本地状态接口: `http://127.0.0.1:4317`

## 2. 当前实际运行版本

当前这台电脑上实际运行的不是源码开发版，而是打包后的 Electron 桌面版:

- 运行中的可执行文件:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\Cat Vault Agent.exe`
- 观测到的运行时间:
  - 2026-05-09 18:33 左右启动
- 当前运行形态:
  - 一个 Electron 主进程
  - 多个同路径辅助进程

重要说明:

- `Cat Vault Agent.exe` 的文件时间是 `2026-05-04 10:37:50`
- 但其内部 `resources\app` 目录中的若干代码文件已经在 `2026-05-09` 被直接热修补
- 因此当前运行版本应视为:
  - `dist/win-unpacked` 打包版
  - 加上 2026-05-09 的本地热修补

## 3. 运行时文件位置

### 3.1 打包版代码位置

- Electron 入口:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\apps\desktop\main.js`
- 预加载脚本:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\apps\desktop\preload.js`
- Python 主代理:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\src\agent.py`
- MinerU 适配器:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\src\mineru_adapter.py`
- 宠物前端:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\public\pet-window.js`
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\public\pet-window.css`
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\public\pet.html`

### 3.2 打包版配置位置

- 当前打包版实际读取的配置文件:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\config\agent.config.json`
- 打包版示例配置:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\config\agent.config.example.json`

### 3.3 运行时日志与状态位置

Python 后端会把日志和状态写到 Windows `APPDATA`:

- AppData 根目录:
  - `C:\Users\LCY\AppData\Roaming\Cat Vault Agent`
- 日志目录:
  - `C:\Users\LCY\AppData\Roaming\Cat Vault Agent\logs`
- 当前主日志:
  - `C:\Users\LCY\AppData\Roaming\Cat Vault Agent\logs\agent.log`
- 状态目录:
  - `C:\Users\LCY\AppData\Roaming\Cat Vault Agent\state`
- 任务队列:
  - `C:\Users\LCY\AppData\Roaming\Cat Vault Agent\state\jobs.json`
- 已处理记录:
  - `C:\Users\LCY\AppData\Roaming\Cat Vault Agent\state\processed.json`

## 4. 源码目录与运行目录的关系

项目内同时存在两套可编辑代码:

- 源码开发目录:
  - `E:\LLM_Research\cat-vault-agent\src`
  - `E:\LLM_Research\cat-vault-agent\public`
  - `E:\LLM_Research\cat-vault-agent\apps`
- 当前实际运行目录:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app`

结论:

- 如果修改的是源码目录，但没有重新打包或同步到 `dist\win-unpacked\resources\app`
- 那么当前桌面猫不会自动使用这些修改
- 本轮排查中的若干修复，已经同时写入源码目录和正在运行的打包目录

## 5. 当前关键配置快照

基于打包版 `config\agent.config.json`:

- `vaultRoot`:
  - `E:\LLM_Research\LCY_phonon_research`
- 服务监听:
  - `127.0.0.1:4317`
- `dryRun`:
  - `false`
- 模型配置:
  - provider: `openai-compatible`
  - model: `gpt-4.1-mini`
  - external config: `E:\LLM_Research\LCY_phonon_research\LLM_API\fig_extraction_config.json`
- 支持投喂扩展名:
  - `.md`
  - `.txt`
  - `.pdf`
- MinerU:
  - enabled: `true`
  - api file: `E:\LLM_Research\LCY_phonon_research\RE_MD\api.txt`
  - output folder: `raw/parsed`
  - assets folder: `wiki/assets`
  - language: `ch`
  - OCR: `true`

## 6. 处理链路摘要

当前桌面猫的主要路径如下:

1. 用户把 PDF / 文本 / URL 拖到小猫窗口
2. Electron 前端触发 `feedFiles` / `feedUrl` / `feedText`
3. Electron 主进程调用本地后端接口:
   - `POST /api/feed-path`
   - `POST /api/feed-url`
   - `POST /api/feed-text`
4. Python 后端把输入复制到知识库 `ingest/`
5. 后端扫描候选文件并写入 `jobs.json`
6. 处理器串行消费队列
7. 若是 PDF:
   - 调用 MinerU 申请上传地址
   - 上传 PDF
   - 轮询解析结果
   - 下载结果 ZIP
   - 生成 Markdown 并写回知识库
8. 若是 Markdown / 文本:
   - 直接走知识整理与 LLM 输出流程

## 7. 本轮已完成修复

### 7.1 PDF 失败任务不可重试

现象:

- 同一个 PDF 第一次解析失败后
- 再次拖给小猫时，文件会复制进 `ingest/`
- 但不会重新入队，表面上看像“没触发解析”

根因:

- 旧的 `sync_jobs()` 去重逻辑把 `failed` 任务也当作已知任务
- 同一路径或同哈希文件会被直接跳过

修复:

- `failed` 任务不再参与普通去重
- 如果再次发现同一路径或同哈希的失败文件，会把旧任务重置为 `queued`
- `/api/feed-path` 改为返回真实 `queued` 状态与 `jobCount`

已写入:

- 源码版:
  - `E:\LLM_Research\cat-vault-agent\src\agent.py`
- 当前运行版:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\src\agent.py`

运行版文件时间:

- `agent.py`: `2026-05-09 17:20:20`

### 7.2 拖 PDF 到小猫时出现禁止圆圈

现象:

- Windows 光标显示禁止投放标识

根因:

- 旧版只在很小的 `dropZone` 上监听拖放
- 宠物窗口同时存在 `-webkit-app-region: drag` 区域，容易让系统把窗口当成拖拽标题区

修复:

- 把拖放监听提升到窗口级别
- 给猫本体增加 `-webkit-app-region: no-drag`

已写入:

- 源码版:
  - `E:\LLM_Research\cat-vault-agent\public\pet-window.js`
  - `E:\LLM_Research\cat-vault-agent\public\pet-window.css`
- 当前运行版:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\public\pet-window.js`
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\public\pet-window.css`

运行版文件时间:

- `pet-window.css`: `2026-05-09 17:15:29`
- `pet-window.js`: `2026-05-09 20:31:40`

### 7.3 投入成功后先提示“投喂失败”

现象:

- 文件刚投进去，前端会先冒出失败提示
- 随后又可能进入正常处理

根因:

- 前端 `feed()` 只要发生异常就显示失败
- 刚投喂后的第一次 `refresh()` 又可能被上一条旧错误记录覆盖

修复:

- `feed(files)` 现在根据 `feedFiles()` 返回的真实 `queued` 结果判断是否投喂成功
- 增加短暂的旧错误提示屏蔽窗口，避免新投喂状态被旧错误覆盖

已写入:

- 源码版:
  - `E:\LLM_Research\cat-vault-agent\public\pet-window.js`
- 当前运行版:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app\public\pet-window.js`

## 8. MinerU 当前状态

已做过一次真实链路测试，结果如下:

- 请求上传地址: 成功
- 上传 PDF 到 OSS: 成功
- 轮询解析结果: 成功
- 下载 ZIP 结果包: 成功

因此当前结论是:

- MinerU token 当前可用
- MinerU API 当前可用
- 结果 ZIP 下载链路当前可用

但历史日志显示它存在间歇性失败，主要集中在下载结果包阶段:

- `Could not resolve host`
- `SSLEOFError`
- `curl timed out after 420 seconds`

这说明:

- MinerU 问题不是永久性配置错误
- 更像是到 `cdn-mineru.openxlab.org.cn` 的网络链路偶发不稳定

## 9. 当前已知风险

- 当前运行版是热修补后的打包目录，不是重新完整构建的正式安装包
- 后续如果重新打包，必须确保把源码目录中的相同修改带进去
- AppData 中的 `jobs.json` 和 `processed.json` 会持续影响重复文件的行为
- MinerU 仍可能因外部 CDN 网络波动而偶发失败

## 10. 建议的后续工作

### 10.1 版本管理

- 重新构建一个新的 Windows 包
- 避免继续直接修改 `dist\win-unpacked\resources\app`
- 给热修补版本打内部标签，例如 `0.1.0-hotfix-20260509`

### 10.2 交互改进

- 增加“失败任务重试”按钮
- 把提示文案区分为:
  - 已接住
  - 已入队
  - 处理中
  - MinerU 下载失败，可重试

### 10.3 稳定性改进

- 为 MinerU 增加下载前连通性探测
- 对 CDN 下载失败做更清晰分类
- 增加本地 PDF 解析后备方案，降低外部网络依赖

## 11. 复查清单

如果以后再排查“拖了 PDF 但没解析”，建议按下面顺序检查:

1. 确认当前运行的是哪一个 `Cat Vault Agent.exe`
2. 确认它对应的 `resources\app\src\agent.py` 是否包含重试修复
3. 打开:
   - `C:\Users\LCY\AppData\Roaming\Cat Vault Agent\logs\agent.log`
4. 检查是否出现:
   - `fed file copied into vault`
   - `scan complete, pending: N`
   - `processing error`
   - `processed file`
5. 如果有 `pending: 0`，优先检查去重逻辑
6. 如果进入 `processing error`，优先检查 MinerU 与网络

## 12. 当前建议的事实来源

以后若要继续维护这台电脑上的桌面猫，优先以以下路径为准:

- 当前运行程序:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\Cat Vault Agent.exe`
- 当前运行代码:
  - `E:\LLM_Research\cat-vault-agent\dist\win-unpacked\resources\app`
- 当前运行日志:
  - `C:\Users\LCY\AppData\Roaming\Cat Vault Agent\logs\agent.log`
- 当前运行状态:
  - `C:\Users\LCY\AppData\Roaming\Cat Vault Agent\state`
- 项目源码:
  - `E:\LLM_Research\cat-vault-agent`

