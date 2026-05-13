const {
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath
} = require("obsidian");

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const VIEW_TYPE = "obsidian-cat-task-center";

const REQUIRED_SOURCE_HEADINGS = [
  "Citation",
  "Research Classification",
  "One-Sentence Takeaway",
  "Structured Abstract",
  "Key Contributions",
  "Methods And Experimental Design",
  "Results And Evidence",
  "Figures And Tables",
  "Important Equations Or Variables",
  "Limitations And Caveats",
  "Reusable Concepts",
  "Links To Existing Vault Topics",
  "Follow-Up Questions",
  "Extraction Notes"
];

const DEFAULT_RESEARCH_REQUIREMENTS = "LLM research, phonon research, and their intersection.";

const DEFAULT_PATHS = {
  ingest: "ingest",
  raw: "raw",
  rawMineru: "raw/mineru",
  rawParsed: "raw/parsed",
  processedPdfs: "raw/processed_pdfs",
  failedPdfs: "raw/failed_pdfs",
  runtime: "raw/plugin_runtime",
  sources: "wiki/sources",
  concepts: "wiki/concepts",
  methods: "wiki/methods",
  materials: "wiki/materials",
  questions: "wiki/questions",
  syntheses: "wiki/syntheses",
  templates: "templates",
  assets: "wiki/assets"
};

function defaultSourceNoteTemplate() {
  return [
    "---",
    "type: literature-note",
    "status: processed",
    "source_path: {{sourcePath}}",
    "created_by: Obsidian Cat",
    "created_at: {{createdAt}}",
    "---",
    "",
    "# {{title}}",
    "",
    "## Citation",
    "",
    "- Title:",
    "- Authors:",
    "- Year:",
    "- Journal/Conference:",
    "- DOI/URL:",
    "",
    "## Research Classification",
    "",
    "- Source Type:",
    "- Domain:",
    "- Materials/System:",
    "- Task/Problem:",
    "- Methods:",
    "- Data/Code:",
    "",
    "## One-Sentence Takeaway",
    "",
    "## Structured Abstract",
    "",
    "- Background:",
    "- Objective:",
    "- Approach:",
    "- Main Results:",
    "- Significance:",
    "",
    "## Key Contributions",
    "",
    "- ",
    "",
    "## Methods And Experimental Design",
    "",
    "- ",
    "",
    "## Results And Evidence",
    "",
    "| Claim | Evidence from source | Figure/Table/Equation | Confidence |",
    "|---|---|---|---|",
    "|  |  |  |  |",
    "",
    "## Figures And Tables",
    "",
    "| Figure/Table | What it shows | Why it matters | Evidence status |",
    "|---|---|---|---|",
    "|  |  |  |  |",
    "",
    "### Key Figure Gallery",
    "",
    "## Important Equations Or Variables",
    "",
    "| Equation/Variable | Meaning | Context | Evidence status |",
    "|---|---|---|---|",
    "|  |  |  |  |",
    "",
    "## Limitations And Caveats",
    "",
    "## Reusable Concepts",
    "",
    "- [[wiki/concepts/]]",
    "",
    "## Links To Existing Vault Topics",
    "",
    "- Concepts:",
    "- Materials:",
    "- Methods:",
    "- Entities:",
    "- Syntheses:",
    "- Questions:",
    "",
    "## Follow-Up Questions",
    "",
    "- [[wiki/questions/]]",
    "",
    "## Extraction Notes",
    "",
    ""
  ].join("\n");
}

function defaultTopicExtractionPolicy(paths = DEFAULT_PATHS) {
  return [
    `Source notes go to ${paths.sources}.`,
    `Reusable mechanism concepts go to ${paths.concepts}.`,
    `Methods, algorithms, and workflows go to ${paths.methods}.`,
    `Concrete materials and studied systems go to ${paths.materials}.`,
    `Actionable open questions go to ${paths.questions}.`,
    "Do not create topic notes from status markers such as Not found in extracted text, Needs verification, or Status: uncertain.",
    "Every non-obvious scientific claim must point to a source note, original source path, figure/table/equation context, or be marked Needs verification."
  ].join("\n");
}

function defaultDocumentPrompt(paths = DEFAULT_PATHS, requirements = DEFAULT_RESEARCH_REQUIREMENTS) {
  const bodyLanguage = paths.outputLanguage || "zh-CN";
  return [
    "You are Obsidian Cat, a careful research-vault assistant.",
    `Research focus: ${requirements || DEFAULT_RESEARCH_REQUIREMENTS}`,
    "",
    `Write Markdown source notes with the exact English headings required by the vault template. Body content language: ${bodyLanguage}. Keep proper nouns, material names, model names, methods, equations, and short technical labels in English when useful.`,
    "",
    "Required source-note headings:",
    ...REQUIRED_SOURCE_HEADINGS.map((heading) => `- ## ${heading}`),
    "",
    "Evidence and metadata rules:",
    "- Do not invent bibliographic metadata. Missing fields must be written as `Not found in extracted text`.",
    "- Mark inferred statements as `Status: inferred` and uncertain statements as `Status: uncertain` or `Needs verification`.",
    "- Reusable Concepts must be phrase-level concepts, not long sentences.",
    "- Follow-Up Questions must be concrete enough to become a reading task, experiment, simulation, or modeling task.",
    `- Body content must use ${bodyLanguage}; keep required Markdown headings in English.`,
    "- Preserve YAML frontmatter with `type: literature-note`, `status: processed`, `source_path`, and `created_by: Obsidian Cat`.",
    "- `Research Classification` must include Source Type, Domain, Materials/System, Task/Problem, Methods, and Data/Code fields.",
    "- `Results And Evidence`, `Figures And Tables`, and `Important Equations Or Variables` should be Markdown tables when evidence is available.",
    "- Add `### Key Figure Gallery` inside `Figures And Tables` when parsed Markdown contains image links. Reuse the original Obsidian image links exactly.",
    "- `Links To Existing Vault Topics` should group Concepts, Materials, Methods, Entities, Syntheses, and Questions.",
    "",
    "Vault paths:",
    `- Raw material: ${paths.raw}`,
    `- Parsed Markdown: ${paths.rawParsed}`,
    `- Source notes: ${paths.sources}`,
    `- Concepts: ${paths.concepts}`,
    `- Methods: ${paths.methods}`,
    `- Materials: ${paths.materials}`,
    `- Questions: ${paths.questions}`,
    `- Syntheses: ${paths.syntheses}`,
    `- Templates: ${paths.templates}`,
    `- Assets: ${paths.assets}`,
    "",
    "Link policy: use durable Obsidian wiki links to curated notes when justified, for example [[wiki/concepts/Phonon Scattering]]."
  ].join("\n");
}

function isLegacySimpleSourceTemplate(value) {
  const text = String(value || "");
  return text.includes("source_path: {{sourcePath}}") &&
    text.includes("## Citation") &&
    !text.includes("type: literature-note") &&
    !text.includes("| Claim | Evidence from source |");
}

function shouldRefreshDefaultPrompt(value) {
  const text = String(value || "");
  return !text || !text.includes("Key Figure Gallery") || !text.includes("Research Classification");
}

const DEFAULT_SETTINGS = {
  uiLanguage: "zh-CN",
  paths: DEFAULT_PATHS,
  cat: {
    autoStartOnObsidianLaunch: true,
    executablePath: "",
    preferBundledRuntime: true,
    bundledRuntimeDir: "companion/cat-vault-agent",
    statusUrl: "http://127.0.0.1:4317/api/status"
  },
  model: {
    providerName: "openai-compatible",
    baseUrl: "",
  model: "",
  apiKeyEnv: "OPENAI_API_KEY",
  apiKey: "",
  temperature: 0.2,
  maxTokens: 1800
  },
  mineru: {
    enabled: true,
    apiTokens: "",
    language: "ch",
    isOcr: true,
    enableFormula: true,
    enableTable: true,
    outputFolder: "raw/parsed",
    assetsFolder: "wiki/assets",
    archiveOriginal: false
  },
  architecture: {
    researchRequirements: DEFAULT_RESEARCH_REQUIREMENTS,
    outputLanguage: "zh-CN",
    useCurrentVaultDefaults: true,
    sourceNoteTemplate: defaultSourceNoteTemplate(),
    topicExtractionPolicy: defaultTopicExtractionPolicy(DEFAULT_PATHS),
    documentPrompt: defaultDocumentPrompt(DEFAULT_PATHS, DEFAULT_RESEARCH_REQUIREMENTS)
  },
  advanced: {
    show: false,
    showPaths: false,
    runtimeStateFolder: "raw/plugin_runtime",
    timeoutMs: 600000
  },
  safety: {
    writeMode: "draft-first",
    keepAuditJson: true
  },
  companion: {
    dryRun: false,
    intervalSeconds: 300,
    providerName: "openai-compatible",
    baseUrl: "",
    model: "",
    apiKeyEnv: "OPENAI_API_KEY",
    apiKey: "",
    temperature: 0.2,
    maxTokens: 1800,
    mineruLanguage: "ch",
    outputLanguage: "zh-CN"
  }
};

const I18N = {
  "zh-CN": {
    settingsTitle: "Obsidian Cat 设置",
    interfaceLanguage: "界面语言",
    interfaceLanguageDesc: "切换插件设置页语言；不会改变文献总结正文语言。",
    quickStart: "快速开始",
    initialize: "初始化 / 修复 Vault 结构",
    initializeDesc: "只创建缺失的文件夹和模板；不会删除或覆盖已有 raw/wiki 内容。",
    initializeButton: "初始化",
    startCat: "启动桌面小猫",
    startCatDesc: "启动随插件打包的桌面 companion，小猫会出现在桌面上。",
    startCatButton: "启动小猫",
    sync: "同步设置到 Companion",
    syncDesc: "把插件设置写入打包 companion 的 agent.config.json。",
    syncButton: "同步",
    companionStatus: "Companion 状态",
    companionStatusDesc: "本会话尚未检查。",
    check: "检查",
    autoStart: "Obsidian 启动时自动启动小猫",
    autoStartDesc: "Obsidian 启动后自动启动或复用现有桌面小猫。",
    modelApi: "大模型 API",
    dryRun: "草稿模式",
    dryRunDesc: "开启后 companion 不调用 LLM，只写入 source note draft。",
    providerLabel: "Provider 标签",
    providerLabelDesc: "OpenAI-compatible provider 标签。",
    baseUrl: "Base URL",
    baseUrlDesc: "Chat completions endpoint，例如 https://api.openai.com/v1/chat/completions。",
    model: "模型",
    modelDesc: "Companion runtime 使用的模型名。",
    apiKey: "API key",
    apiKeyDesc: "为了部署方便存入插件 data；也可以留空并使用环境变量。",
    apiKeyEnv: "API key 环境变量",
    apiKeyEnvDesc: "API key 留空时读取的环境变量名。",
    temperature: "Temperature",
    maxTokens: "Max tokens",
    mineruApi: "MinerU API",
    enableMinerU: "启用 MinerU",
    enableMinerUDesc: "PDF 解析后再生成 source note。",
    mineruTokens: "MinerU tokens",
    mineruTokensDesc: "每行一个 token，会直接同步到 companion 配置。",
    parseLanguage: "解析语言",
    parseLanguageDesc: "通常使用 ch 或 en。",
    ocr: "OCR",
    ocrDesc: "为 PDF 启用 OCR 模式。",
    formula: "公式提取",
    formulaDesc: "请求 MinerU 提取公式。",
    table: "表格提取",
    tableDesc: "请求 MinerU 提取表格。",
    rawMineru: "MinerU 中转目录",
    rawMineruDesc: "完整 MinerU zip 临时输出；成功/失败后会清理。",
    rawParsed: "Parsed Markdown 目录",
    rawParsedDesc: "MinerU 解析后的 Markdown 输出目录。",
    assets: "Assets 目录",
    assetsDesc: "PDF 中提取的图片和资源目录。",
    archivePdfs: "归档原 PDF",
    archivePdfsDesc: "成功/失败后将 PDF 移出 ingest，进入 processed/failed 目录。",
    wikiArchitecture: "Wiki 架构",
    folderPreset: "文件夹预设",
    folderPresetDesc: "当前默认：raw/ 保存原始材料，wiki/ 保存整理后的笔记。",
    researchRequirements: "研究需求描述",
    researchRequirementsDesc: "描述研究方向和知识库组织偏好，LLM 架构生成会参考这里。",
    outputLanguage: "总结正文语言",
    outputLanguageDesc: "控制 source note 正文语言，例如 zh-CN 或 en。",
    rawFolder: "Raw 目录",
    sourceNotesFolder: "Source notes 目录",
    conceptsFolder: "Concepts 目录",
    methodsFolder: "Methods 目录",
    materialsFolder: "Materials 目录",
    questionsFolder: "Questions 目录",
    synthesesFolder: "Syntheses 目录",
    templatesFolder: "Templates 目录",
    sourceNoteTemplate: "Source note 模板",
    topicPolicy: "Topic extraction policy",
    documentPrompt: "文档处理 Prompt",
    generateArchitecture: "用 LLM 生成架构",
    generateArchitectureDesc: "使用当前 Model API 设置；失败时回退到当前 vault 默认架构。",
    generate: "生成",
    applyArchitecture: "应用架构",
    applyArchitectureDesc: "只创建缺失文件夹和模板，不改动已有文件。",
    apply: "应用",
    resetDefaults: "恢复当前 Vault 默认值",
    resetDefaultsDesc: "恢复 AGENTS.md 约定的 raw/ + wiki/ 架构与默认提示词。",
    reset: "恢复",
    advanced: "高级设置",
    preferBundledRuntime: "优先使用打包 runtime",
    preferBundledRuntimeDesc: "优先使用 Obsidian 插件内置的 runtime。",
    bundledRuntimeFolder: "打包 runtime 目录",
    bundledRuntimeFolderDesc: "相对于插件目录。",
    executablePath: "小猫可执行文件路径",
    executablePathDesc: "当内置 runtime 不可用时使用的 Obsidian Cat.exe 路径。",
    statusUrl: "状态 URL",
    statusUrlDesc: "插件内部使用的本地 API endpoint。",
    runtimeStateFolder: "Runtime state 目录",
    runtimeStateFolderDesc: "Vault-relative runtime state folder。",
    timeoutMs: "Runtime timeout ms",
    scanInterval: "扫描间隔秒数"
  }
};

I18N.en = {
  settingsTitle: "Obsidian Cat Settings",
  interfaceLanguage: "Interface language",
  interfaceLanguageDesc: "Switch the plugin settings language; this does not change source-note body language.",
  quickStart: "Quick Start",
  initialize: "Initialize / Repair Vault Structure",
  initializeDesc: "Create only missing folders and templates. Existing raw/wiki content is never deleted or overwritten.",
  initializeButton: "Initialize",
  startCat: "Start Desktop Cat",
  startCatDesc: "Launch the bundled desktop companion so the cat appears on the desktop.",
  startCatButton: "Start Cat",
  sync: "Sync Settings To Companion",
  syncDesc: "Write these plugin settings into the bundled companion agent.config.json.",
  syncButton: "Sync",
  companionStatus: "Companion Status",
  companionStatusDesc: "Not checked in this session.",
  check: "Check",
  autoStart: "Auto-start desktop cat",
  autoStartDesc: "Launch or reuse the desktop cat when Obsidian starts.",
  modelApi: "Model API",
  dryRun: "Dry run",
  dryRunDesc: "When enabled, the companion writes draft source notes without live LLM calls.",
  providerLabel: "Provider label",
  providerLabelDesc: "OpenAI-compatible provider label.",
  baseUrl: "Base URL",
  baseUrlDesc: "Chat completions endpoint, for example https://api.openai.com/v1/chat/completions.",
  model: "Model",
  modelDesc: "Model name used by the companion runtime.",
  apiKey: "API key",
  apiKeyDesc: "Stored in plugin data for convenience. You can leave it empty and use an environment variable instead.",
  apiKeyEnv: "API key env",
  apiKeyEnvDesc: "Environment variable name used when API key is empty.",
  temperature: "Temperature",
  maxTokens: "Max tokens",
  mineruApi: "MinerU API",
  enableMinerU: "Enable MinerU",
  enableMinerUDesc: "Use MinerU for PDF parsing before source-note drafting.",
  mineruTokens: "MinerU tokens",
  mineruTokensDesc: "One token per line. These are synced directly to the companion config.",
  parseLanguage: "Parse language",
  parseLanguageDesc: "Usually ch or en.",
  ocr: "OCR",
  ocrDesc: "Enable OCR mode for PDFs.",
  formula: "Formula extraction",
  formulaDesc: "Ask MinerU to extract formulas.",
  table: "Table extraction",
  tableDesc: "Ask MinerU to extract tables.",
  rawMineru: "MinerU staging folder",
  rawMineruDesc: "Temporary full MinerU zip output; cleaned after success/failure.",
  rawParsed: "Parsed Markdown folder",
  rawParsedDesc: "MinerU parsed Markdown output.",
  assets: "Assets folder",
  assetsDesc: "Images and assets extracted from PDFs.",
  archivePdfs: "Archive original PDFs",
  archivePdfsDesc: "Move PDFs out of ingest into processed/failed folders after processing.",
  wikiArchitecture: "Wiki Architecture",
  folderPreset: "Folder preset",
  folderPresetDesc: "Current defaults: raw/ keeps original material, wiki/ keeps curated notes.",
  researchRequirements: "Research Requirements",
  researchRequirementsDesc: "Describe your research focus and organization preferences. The LLM architecture generator uses this as guidance.",
  outputLanguage: "Source-note body language",
  outputLanguageDesc: "Controls source-note body language, for example zh-CN or en.",
  rawFolder: "Raw folder",
  sourceNotesFolder: "Source notes folder",
  conceptsFolder: "Concepts folder",
  methodsFolder: "Methods folder",
  materialsFolder: "Materials folder",
  questionsFolder: "Questions folder",
  synthesesFolder: "Syntheses folder",
  templatesFolder: "Templates folder",
  sourceNoteTemplate: "Source note template",
  topicPolicy: "Topic extraction policy",
  documentPrompt: "Document processing prompt",
  generateArchitecture: "Generate Architecture With LLM",
  generateArchitectureDesc: "Uses the current Model API settings. Falls back to current vault defaults if the call fails.",
  generate: "Generate",
  applyArchitecture: "Apply Architecture",
  applyArchitectureDesc: "Create missing folders and templates only. Existing files remain untouched.",
  apply: "Apply",
  resetDefaults: "Reset To Current Vault Defaults",
  resetDefaultsDesc: "Restore the raw/ + wiki/ architecture from the current AGENTS.md conventions.",
  reset: "Reset",
  advanced: "Advanced",
  preferBundledRuntime: "Prefer bundled runtime",
  preferBundledRuntimeDesc: "Use the runtime packaged inside this Obsidian plugin when available.",
  bundledRuntimeFolder: "Bundled runtime folder",
  bundledRuntimeFolderDesc: "Relative to this plugin folder.",
  executablePath: "Cat executable path",
  executablePathDesc: "Optional fallback path to Obsidian Cat.exe when bundled runtime is unavailable.",
  statusUrl: "Cat status URL",
  statusUrlDesc: "Internal local API endpoint used by the plugin.",
  runtimeStateFolder: "Runtime state folder",
  runtimeStateFolderDesc: "Vault-relative folder for runtime state.",
  timeoutMs: "Runtime timeout ms",
  scanInterval: "Scan interval seconds"
};

function deepMerge(base, override) {
  const output = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = deepMerge(base[key] || {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function cleanPath(value) {
  return normalizePath(String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, ""));
}

function markdownHeadings(text) {
  const headings = [];
  const re = /^##\s+(.+)$/gm;
  let match;
  while ((match = re.exec(text)) !== null) headings.push(match[1].trim());
  return headings;
}

function wikiLinks(text) {
  const links = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = re.exec(text)) !== null) links.push(match[1].trim());
  return links;
}

function normalizedTitleKey(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").replace(/\s+/g, " ").trim();
}

function looksInvalidTopicTitle(title) {
  const normalized = String(title || "").trim();
  if (normalized.length < 2 || normalized.length > 120) return true;
  if ((normalized.match(/\(/g) || []).length !== (normalized.match(/\)/g) || []).length) return true;
  if ((normalized.match(/\[/g) || []).length !== (normalized.match(/\]/g) || []).length) return true;
  return [
    /^not found in extracted text$/i,
    /^needs verification$/i,
    /^status:\s*(uncertain|inferred)$/i,
    /^specifically\b/i,
    /^x\s*=/i,
    /^[a-z]{1,3}\)$/i
  ].some((pattern) => pattern.test(normalized));
}

function safeFileName(name) {
  const cleaned = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || `source-${Date.now()}`;
}

function nowIso() {
  return new Date().toISOString();
}

class ResearchWikiPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.auditFindings = [];
    this.lastLog = "Plugin loaded.";

    this.registerView(VIEW_TYPE, (leaf) => new TaskCenterView(leaf, this));
    this.addRibbonIcon("cat", "Obsidian Cat", () => this.openTaskCenter());

    this.addCommand({
      id: "open-task-center",
      name: "Open Obsidian Cat Center",
      callback: () => this.openTaskCenter()
    });
    this.addCommand({
      id: "start-desktop-cat",
      name: "Start Desktop Cat",
      callback: () => this.startDesktopCat({ showNotice: true })
    });
    this.addCommand({
      id: "check-desktop-cat-status",
      name: "Check Desktop Cat Status",
      callback: () => this.checkDesktopCatStatus(true)
    });
    this.addCommand({
      id: "draft-source-note",
      name: "Draft Source Note From Current Parsed Markdown",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (checking) return true;
        this.draftSourceNoteFromFile(file);
        return true;
      }
    });
    this.addCommand({
      id: "audit-vault",
      name: "Audit Vault",
      callback: () => this.auditVault({ openReport: false })
    });

    this.addSettingTab(new ResearchWikiSettingTab(this.app, this));

    if (this.settings.cat.autoStartOnObsidianLaunch) {
      window.setTimeout(() => this.startDesktopCat({ showNotice: false }), 1200);
    }
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = deepMerge(DEFAULT_SETTINGS, loaded);
    this.migrateLegacySettings(loaded || {});
  }

  migrateLegacySettings(loaded) {
    const legacy = loaded.companion || {};
    if (!loaded.model && legacy) {
      this.settings.model.providerName = legacy.providerName || this.settings.model.providerName;
      this.settings.model.baseUrl = legacy.baseUrl || this.settings.model.baseUrl;
      this.settings.model.model = legacy.model || this.settings.model.model;
      this.settings.model.apiKeyEnv = legacy.apiKeyEnv || this.settings.model.apiKeyEnv;
      this.settings.model.apiKey = legacy.apiKey || this.settings.model.apiKey;
      this.settings.model.temperature = Number(legacy.temperature || this.settings.model.temperature);
      this.settings.model.maxTokens = Number(legacy.maxTokens || this.settings.model.maxTokens);
    }
    if (!loaded.mineru && legacy) {
      this.settings.mineru.language = legacy.mineruLanguage || this.settings.mineru.language;
    }
    if (!this.settings.mineru.apiTokens && this.settings.mineru.apiToken) {
      this.settings.mineru.apiTokens = this.settings.mineru.apiToken;
      delete this.settings.mineru.apiToken;
    }
    delete this.settings.mineru.apiFile;
    delete this.settings.model.externalConfig;
    delete this.settings.model.legacyExternalConfig;
    delete this.settings.externalCommand;
    if (!["zh-CN", "en"].includes(this.settings.uiLanguage)) {
      this.settings.uiLanguage = "zh-CN";
    }
    if (!loaded.architecture && legacy.outputLanguage) {
      this.settings.architecture.outputLanguage = legacy.outputLanguage;
    }
    if (isLegacySimpleSourceTemplate(this.settings.architecture.sourceNoteTemplate)) {
      this.settings.architecture.sourceNoteTemplate = defaultSourceNoteTemplate();
    }
    if (shouldRefreshDefaultPrompt(this.settings.architecture.documentPrompt)) {
      this.settings.architecture.documentPrompt = defaultDocumentPrompt(this.settings.paths, this.settings.architecture.researchRequirements);
    }
    this.settings.paths = deepMerge(DEFAULT_PATHS, this.settings.paths || {});
    this.settings.mineru.outputFolder = this.settings.paths.rawParsed;
    this.settings.mineru.assetsFolder = this.settings.paths.assets;
  }

  tr(key) {
    return (I18N[this.settings.uiLanguage] || I18N["zh-CN"])[key] || I18N.en[key] || key;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  vaultBasePath() {
    const adapter = this.app.vault.adapter;
    return adapter && adapter.basePath ? adapter.basePath : "";
  }

  absoluteVaultPath(vaultRelativePath) {
    const base = this.vaultBasePath();
    return base ? path.join(base, vaultRelativePath.replace(/\//g, path.sep)) : vaultRelativePath;
  }

  pluginBasePath() {
    const base = this.vaultBasePath();
    if (!base || !this.manifest || !this.manifest.dir) return "";
    return path.join(base, this.manifest.dir.replace(/\//g, path.sep));
  }

  bundledCatExecutablePath() {
    const pluginBase = this.pluginBasePath();
    if (!pluginBase) return "";
    const runtimeDir = path.join(
      pluginBase,
      this.settings.cat.bundledRuntimeDir.replace(/\//g, path.sep)
    );
    const preferred = path.join(runtimeDir, "Obsidian Cat.exe");
    if (fs.existsSync(preferred)) return preferred;
    return path.join(runtimeDir, "Cat Vault Agent.exe");
  }

  resolvedCatExecutablePath() {
    const bundled = this.bundledCatExecutablePath();
    if (this.settings.cat.preferBundledRuntime && bundled && fs.existsSync(bundled)) return bundled;
    if (this.settings.cat.executablePath && fs.existsSync(this.settings.cat.executablePath)) {
      return this.settings.cat.executablePath;
    }
    return bundled || this.settings.cat.executablePath || "";
  }

  async syncBundledCatConfig(exePath) {
    if (!exePath || !fs.existsSync(exePath)) return;
    const configPath = path.join(path.dirname(exePath), "resources", "app", "config", "agent.config.json");
    const examplePath = path.join(path.dirname(exePath), "resources", "app", "config", "agent.config.example.json");
    if (!fs.existsSync(configPath) && fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, configPath);
    }
    if (!fs.existsSync(configPath)) return;

    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      this.lastLog = `Cat config exists but could not be parsed: ${configPath}`;
      return;
    }

    config.vaultRoot = this.vaultBasePath();
    config.host = config.host || "127.0.0.1";
    config.port = config.port || 4317;
    config.dryRun = Boolean(this.settings.companion.dryRun);
    config.intervalSeconds = Number(this.settings.companion.intervalSeconds || 300);
    config.ingest = config.ingest || {};
    config.ingest.feedFolder = this.settings.paths.ingest;
    config.parser = config.parser || {};
    config.parser.mineru = config.parser.mineru || {};
    config.parser.mineru.enabled = Boolean(this.settings.mineru.enabled);
    config.parser.mineru.outputFolder = this.settings.paths.rawParsed;
    config.parser.mineru.assetsFolder = this.settings.paths.assets;
    config.parser.mineru.rawOutputFolder = this.settings.paths.rawMineru || "raw/mineru";
    config.parser.mineru.processedFolder = this.settings.paths.processedPdfs;
    config.parser.mineru.failedFolder = this.settings.paths.failedPdfs;
    config.parser.mineru.manifestPath = "raw/mineru_manifest.csv";
    config.parser.mineru.apiTokens = this.settings.mineru.apiTokens || "";
    config.parser.mineru.language = this.settings.mineru.language;
    config.parser.mineru.isOcr = Boolean(this.settings.mineru.isOcr);
    config.parser.mineru.enableFormula = Boolean(this.settings.mineru.enableFormula);
    config.parser.mineru.enableTable = Boolean(this.settings.mineru.enableTable);
    config.parser.mineru.archiveOriginal = Boolean(this.settings.mineru.archiveOriginal);
    config.model = config.model || {};
    config.model.providerName = this.settings.model.providerName;
    delete config.model.externalConfig;
    delete config.model.legacyExternalConfig;
    config.model.baseUrl = this.settings.model.baseUrl;
    config.model.model = this.settings.model.model;
    config.model.apiKeyEnv = this.settings.model.apiKeyEnv;
    config.model.apiKey = this.settings.model.apiKey;
    config.model.temperature = Number(this.settings.model.temperature || 0.2);
    config.model.maxTokens = Number(this.settings.model.maxTokens || 1800);
    config.output = config.output || {};
    config.output.sourceNotesFolder = this.settings.paths.sources;
    config.output.questionsFolder = this.settings.paths.questions;
    config.output.language = this.settings.architecture.outputLanguage;
    config.output.sourceNoteTemplate = await this.sourceNoteTemplateForSync();
    config.output.topicExtractionPolicy = this.settings.architecture.topicExtractionPolicy || defaultTopicExtractionPolicy(this.settings.paths);
    config.output.analysisPrompt = await this.documentPromptForSync();
    config.architecture = {
      researchRequirements: this.settings.architecture.researchRequirements,
      paths: this.settings.paths,
      topicExtractionPolicy: config.output.topicExtractionPolicy
    };
    config.runtime = config.runtime || {};
    config.runtime.stateFolder = this.settings.advanced.runtimeStateFolder;
    config.runtime.timeoutMs = Number(this.settings.advanced.timeoutMs || 600000);

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  }

  companionConfigPath() {
    const exe = this.resolvedCatExecutablePath();
    if (!exe) return "";
    return path.join(path.dirname(exe), "resources", "app", "config", "agent.config.json");
  }

  async syncCompanionSettings() {
    const exe = this.resolvedCatExecutablePath();
    if (!exe || !fs.existsSync(exe)) {
      new Notice("Bundled Obsidian Cat runtime not found.");
      return false;
    }
    await this.syncBundledCatConfig(exe);
    this.lastLog = `Companion config synced: ${this.companionConfigPath()}`;
    this.refreshTaskCenter();
    new Notice("Companion settings synced.");
    return true;
  }

  async initializeCurrentVault() {
    for (const folder of [
      this.settings.paths.ingest,
      this.settings.paths.raw,
      this.settings.paths.rawMineru,
      this.settings.paths.rawParsed,
      this.settings.paths.processedPdfs,
      this.settings.paths.failedPdfs,
      this.settings.paths.runtime,
      this.settings.paths.sources,
      this.settings.paths.concepts,
      this.settings.paths.methods,
      this.settings.paths.materials,
      this.settings.paths.questions,
      this.settings.paths.syntheses,
      this.settings.paths.templates,
      this.settings.paths.assets
    ]) {
      await this.ensureFolder(folder);
    }
    await this.writeIfMissing("wiki/Home.md", "# Home\n\n## Navigation\n\n- [[wiki/Literature Index]]\n- [[wiki/Map of Contents]]\n- [[wiki/questions/Open Questions]]\n");
    await this.writeIfMissing("wiki/Literature Index.md", "# Literature Index\n\n## Papers\n");
    await this.writeIfMissing("wiki/Map of Contents.md", "# Map of Contents\n\n## Literature\n\n- [[wiki/Literature Index]]\n");
    await this.writeIfMissing(`${cleanPath(this.settings.paths.questions)}/Open Questions.md`, "# Open Questions\n\n");
    await this.writeIfMissing(`${cleanPath(this.settings.paths.templates)}/Source Note.md`, this.settings.architecture.sourceNoteTemplate || defaultSourceNoteTemplate());
    await this.syncCompanionSettings();
    new Notice("Current vault initialized for Obsidian Cat.");
  }

  async writeIfMissing(filePath, content) {
    if (await this.app.vault.adapter.exists(filePath)) return;
    const parent = filePath.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    await this.app.vault.create(filePath, content.endsWith("\n") ? content : `${content}\n`);
  }

  async ensureFolder(folderPath) {
    const clean = cleanPath(folderPath);
    if (!clean) return;
    if (!(await this.app.vault.adapter.exists(clean))) {
      await this.app.vault.createFolder(clean);
    }
  }

  async sourceNoteTemplateForSync() {
    const templatePath = `${cleanPath(this.settings.paths.templates)}/Source Note.md`;
    if (await this.app.vault.adapter.exists(templatePath)) {
      return await this.app.vault.adapter.read(templatePath);
    }
    return this.settings.architecture.sourceNoteTemplate || defaultSourceNoteTemplate();
  }

  async documentPromptForSync() {
    const agentRules = (await this.app.vault.adapter.exists("AGENTS.md"))
      ? await this.app.vault.adapter.read("AGENTS.md")
      : "";
    return [
      `Source-note body language: ${this.settings.architecture.outputLanguage || "zh-CN"}. Keep required Markdown headings in English.`,
      "",
      this.settings.architecture.documentPrompt || defaultDocumentPrompt(this.settings.paths, this.settings.architecture.researchRequirements),
      "",
      "Current vault rules from AGENTS.md:",
      agentRules,
      "",
      "Use output.sourceNoteTemplate as the target shape. Keep required Markdown headings in English, write body content in Chinese, do not invent bibliographic metadata, and promote reusable concepts/questions only when evidence supports them."
    ].join("\n").trim();
  }

  async openTaskCenter() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async checkDesktopCatStatus(showNotice = false) {
    const url = this.settings.cat.statusUrl;
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 1200);
      const response = await fetch(url, { signal: controller.signal });
      window.clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      this.lastLog = `Desktop cat online: ${data.lastMessage || "ready"}`;
      if (showNotice) new Notice("Desktop cat is online.");
      this.refreshTaskCenter();
      return { online: true, data };
    } catch (error) {
      this.lastLog = `Desktop cat offline: ${error.message || error}`;
      if (showNotice) new Notice("Desktop cat is not responding.");
      this.refreshTaskCenter();
      return { online: false, error };
    }
  }

  async startDesktopCat({ showNotice = true } = {}) {
    const status = await this.checkDesktopCatStatus(false);
    if (status.online) {
      if (showNotice) new Notice("Desktop cat is already running.");
      return;
    }

    const exe = this.resolvedCatExecutablePath();
    if (!exe || !fs.existsSync(exe)) {
      new Notice("Cat runtime not found. Check bundled runtime or plugin settings.");
      this.lastLog = [
        "Cat executable not found.",
        `Bundled path: ${this.bundledCatExecutablePath() || "(unavailable)"}`,
        `Custom path: ${this.settings.cat.executablePath || "(empty)"}`
      ].join("\n");
      this.refreshTaskCenter();
      return;
    }

    try {
      await this.syncBundledCatConfig(exe);
      const child = childProcess.spawn(exe, [], {
        cwd: path.dirname(exe),
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
      child.unref();
      this.lastLog = `Started desktop cat: ${exe}`;
      if (showNotice) new Notice("Desktop cat started.");
      window.setTimeout(() => this.checkDesktopCatStatus(false), 2500);
    } catch (error) {
      this.lastLog = `Failed to start desktop cat: ${error.message || error}`;
      new Notice("Failed to start desktop cat.");
    }
    this.refreshTaskCenter();
  }

  async generateArchitectureWithLlm() {
    const fallback = this.buildDefaultArchitectureProfile();
    const model = this.settings.model;
    if (!model.baseUrl || !model.model) {
      this.applyArchitectureProfile(fallback);
      await this.saveSettings();
      this.lastLog = "Model API is not configured; default vault architecture profile was applied.";
      new Notice("Model API not configured. Applied current vault defaults.");
      this.refreshTaskCenter();
      return;
    }

    const prompt = [
      "Return JSON only. Design an Obsidian research vault architecture profile for Obsidian Cat.",
      "The profile must preserve strict evidence rules and the required source note headings.",
      `Research requirements: ${this.settings.architecture.researchRequirements || DEFAULT_RESEARCH_REQUIREMENTS}`,
      `Current paths: ${JSON.stringify(this.settings.paths)}`,
      "JSON shape:",
      "{",
      "  \"folders\": {\"raw\":\"raw\", \"rawParsed\":\"raw/parsed\", \"sources\":\"wiki/sources\", \"concepts\":\"wiki/concepts\", \"methods\":\"wiki/methods\", \"materials\":\"wiki/materials\", \"questions\":\"wiki/questions\", \"syntheses\":\"wiki/syntheses\", \"templates\":\"templates\", \"assets\":\"wiki/assets\"},",
      "  \"sourceNoteTemplate\": \"markdown template with the required English headings\",",
      "  \"topicExtractionPolicy\": \"plain text policy\",",
      "  \"documentPrompt\": \"plain text prompt for document processing\"",
      "}"
    ].join("\n");

    try {
      const apiKey = model.apiKey || (model.apiKeyEnv ? "" : "");
      const response = await fetch(model.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model: model.model,
          temperature: Number(model.temperature || 0.2),
          max_tokens: Number(model.maxTokens || 1800),
          messages: [
            { role: "system", content: "You produce strict JSON only." },
            { role: "user", content: prompt }
          ]
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const content = json.choices?.[0]?.message?.content || "";
      const parsed = this.parseArchitectureJson(content);
      this.applyArchitectureProfile(parsed || fallback);
      await this.saveSettings();
      await this.syncCompanionSettings();
      this.lastLog = parsed ? "LLM architecture profile generated and applied." : "LLM response was not valid JSON; default profile applied.";
      new Notice(parsed ? "Architecture generated." : "Architecture fallback applied.");
    } catch (error) {
      this.applyArchitectureProfile(fallback);
      await this.saveSettings();
      this.lastLog = `Architecture generation failed; default profile applied: ${error.message || error}`;
      new Notice("Architecture generation failed. Applied current vault defaults.");
    }
    this.refreshTaskCenter();
  }

  parseArchitectureJson(text) {
    const trimmed = String(text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch (error) {
        return null;
      }
    }
  }

  buildDefaultArchitectureProfile() {
    const paths = deepMerge(DEFAULT_PATHS, this.settings.paths || {});
    return {
      folders: paths,
      sourceNoteTemplate: defaultSourceNoteTemplate(),
      topicExtractionPolicy: defaultTopicExtractionPolicy(paths),
      documentPrompt: defaultDocumentPrompt(paths, this.settings.architecture.researchRequirements)
    };
  }

  applyArchitectureProfile(profile) {
    const folders = profile.folders || profile.paths || {};
    for (const key of Object.keys(DEFAULT_PATHS)) {
      if (folders[key]) this.settings.paths[key] = cleanPath(folders[key]);
    }
    this.settings.mineru.outputFolder = this.settings.paths.rawParsed;
    this.settings.mineru.assetsFolder = this.settings.paths.assets;
    this.settings.architecture.sourceNoteTemplate = profile.sourceNoteTemplate || defaultSourceNoteTemplate();
    this.settings.architecture.topicExtractionPolicy = profile.topicExtractionPolicy || defaultTopicExtractionPolicy(this.settings.paths);
    this.settings.architecture.documentPrompt = profile.documentPrompt || defaultDocumentPrompt(this.settings.paths, this.settings.architecture.researchRequirements);
  }

  async applyArchitecture() {
    for (const folder of Object.values(this.settings.paths)) {
      await this.ensureFolder(folder);
    }
    await this.writeIfMissing(`${cleanPath(this.settings.paths.templates)}/Source Note.md`, this.settings.architecture.sourceNoteTemplate || defaultSourceNoteTemplate());
    await this.writeIfMissing(`${cleanPath(this.settings.paths.questions)}/Open Questions.md`, "# Open Questions\n\n");
    await this.syncCompanionSettings();
    new Notice("Architecture applied without overwriting existing files.");
  }

  async resetArchitectureDefaults() {
    this.settings.paths = deepMerge(DEFAULT_PATHS, {});
    this.settings.architecture.useCurrentVaultDefaults = true;
    this.applyArchitectureProfile(this.buildDefaultArchitectureProfile());
    await this.saveSettings();
    await this.syncCompanionSettings();
    new Notice("Current vault defaults restored.");
    this.refreshTaskCenter();
  }

  async draftSourceNoteFromFile(file) {
    const rawParsed = cleanPath(this.settings.paths.rawParsed);
    if (!file.path.startsWith(`${rawParsed}/`) && file.path !== rawParsed) {
      new Notice(`Current file is not under ${rawParsed}. Drafting anyway.`);
    }

    const text = await this.app.vault.read(file);
    const title = safeFileName(file.basename);
    const targetFolder = cleanPath(this.settings.paths.sources);
    await this.ensureFolder(targetFolder);
    let targetPath = normalizePath(`${targetFolder}/${title}.md`);
    let counter = 2;
    while (await this.app.vault.adapter.exists(targetPath)) {
      targetPath = normalizePath(`${targetFolder}/${title} ${counter}.md`);
      counter += 1;
    }

    const note = this.buildSourceNoteDraft(title, file.path, text);
    const created = await this.app.vault.create(targetPath, note);
    this.lastLog = `Draft source note created: ${targetPath}`;
    new Notice("Source note draft created.");
    await this.app.workspace.getLeaf(true).openFile(created);
    this.refreshTaskCenter();
  }

  buildSourceNoteDraft(title, sourcePath, sourceText) {
    const excerpt = sourceText.replace(/\r\n/g, "\n").slice(0, 5000);
    let note = this.settings.architecture.sourceNoteTemplate || defaultSourceNoteTemplate();
    note = note
      .replace(/\{\{title\}\}/g, title)
      .replace(/\{\{sourcePath\}\}/g, sourcePath)
      .replace(/\{\{createdAt\}\}/g, nowIso());
    if (!/^#\s+/m.test(note)) note = `# ${title}\n\n${note}`;
    if (!note.includes("source_path:")) note = note.replace(/^# .+$/m, `$&\n\nsource_path: ${sourcePath}\nStatus: draft`);
    for (const heading of REQUIRED_SOURCE_HEADINGS) {
      if (!note.includes(`## ${heading}`)) note += `\n## ${heading}\n\nNeeds verification\n`;
    }
    return [
      note.trimEnd(),
      "",
      "### Source Excerpt",
      "",
      "```text",
      excerpt,
      "```",
      ""
    ].join("\n");
  }

  async auditVault({ openReport = false } = {}) {
    const findings = [];
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const sourceFolder = `${cleanPath(this.settings.paths.sources)}/`;

    for (const file of markdownFiles) {
      if (!file.path.startsWith(sourceFolder)) continue;
      const text = await this.app.vault.read(file);
      const headings = new Set(markdownHeadings(text));
      const missing = REQUIRED_SOURCE_HEADINGS.filter((heading) => !headings.has(heading));
      if (missing.length) {
        findings.push({
          kind: "source_missing_headings",
          severity: "warning",
          path: file.path,
          message: `Missing source note headings: ${missing.join(", ")}`
        });
      }
      if (headings.has("Knowledge Graph Links")) {
        findings.push({
          kind: "legacy_heading",
          severity: "warning",
          path: file.path,
          message: "Legacy heading `Knowledge Graph Links`; use `Links To Existing Vault Topics`."
        });
      }
    }

    for (const folder of [
      this.settings.paths.concepts,
      this.settings.paths.materials,
      this.settings.paths.methods,
      this.settings.paths.questions
    ]) {
      const cleanFolder = `${cleanPath(folder)}/`;
      const seen = new Map();
      for (const file of markdownFiles.filter((item) => item.path.startsWith(cleanFolder))) {
        const title = file.basename;
        const key = normalizedTitleKey(title);
        if (looksInvalidTopicTitle(title)) {
          findings.push({
            kind: "invalid_topic_title",
            severity: "error",
            path: file.path,
            message: `Invalid topic title: ${title}`
          });
        }
        if (key && seen.has(key)) {
          findings.push({
            kind: "duplicate_topic",
            severity: "warning",
            path: file.path,
            message: `Possible duplicate topic: ${seen.get(key)}`
          });
        } else {
          seen.set(key, file.path);
        }
      }
    }

    for (const file of markdownFiles) {
      if (file.path === `${cleanPath(this.settings.paths.syntheses)}/Vault Pipeline Audit.md`) continue;
      const text = await this.app.vault.read(file);
      for (const link of wikiLinks(text)) {
        if (!link.startsWith("wiki/")) continue;
        if (link.startsWith("wiki/assets/")) {
          if (!(await this.app.vault.adapter.exists(link))) {
            findings.push({
              kind: "broken_asset_link",
              severity: "warning",
              path: file.path,
              message: `Broken asset link: [[${link}]]`
            });
          }
          continue;
        }
        const target = `${link}.md`;
        if (!(await this.app.vault.adapter.exists(target))) {
          findings.push({
            kind: "broken_wikilink",
            severity: "warning",
            path: file.path,
            message: `Broken wiki link: [[${link}]]`
          });
        }
      }
    }

    this.auditFindings = findings;
    await this.writeAuditReport(findings);
    this.lastLog = `Audit completed: ${findings.length} finding(s).`;
    new Notice(`Audit completed: ${findings.length} finding(s).`);
    this.refreshTaskCenter();

    if (openReport) {
      const reportPath = `${cleanPath(this.settings.paths.syntheses)}/Vault Pipeline Audit.md`;
      const report = this.app.vault.getAbstractFileByPath(reportPath);
      if (report instanceof TFile) await this.app.workspace.getLeaf(true).openFile(report);
    }
    return findings;
  }

  async writeAuditReport(findings) {
    const syntheses = cleanPath(this.settings.paths.syntheses);
    await this.ensureFolder(syntheses);
    const reportPath = `${syntheses}/Vault Pipeline Audit.md`;
    const lines = [
      "# Vault Pipeline Audit",
      "",
      "## Summary",
      "",
      `- Updated: ${nowIso()}`,
      `- Findings: ${findings.length}`,
      `- Errors: ${findings.filter((f) => f.severity === "error").length}`,
      `- Warnings: ${findings.filter((f) => f.severity === "warning").length}`,
      "",
      "## Findings",
      ""
    ];
    if (!findings.length) {
      lines.push("- No findings.");
    }
    for (const finding of findings) {
      lines.push(`### ${finding.kind}`, "", `- Severity: ${finding.severity}`, `- Path: \`${finding.path}\``, `- Message: ${finding.message}`, "");
    }
    await this.writeFile(reportPath, `${lines.join("\n").trim()}\n`);

    if (this.settings.safety.keepAuditJson) {
      const runtime = cleanPath(this.settings.paths.runtime);
      await this.ensureFolder(runtime);
      await this.writeFile(`${runtime}/vault_audit_findings.json`, `${JSON.stringify(findings, null, 2)}\n`);
    }
  }

  async writeFile(filePath, content) {
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(filePath, content);
    }
  }

  refreshTaskCenter() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && typeof leaf.view.render === "function") leaf.view.render();
    }
  }
}

class TaskCenterView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Obsidian Cat";
  }

  getIcon() {
    return "cat";
  }

  async onOpen() {
    this.render();
  }

  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("lcy-rw-view");
    root.createEl("h2", { text: "Obsidian Cat", cls: "lcy-rw-title" });
    root.createEl("p", {
      text: "Research-vault controls and the bundled desktop cat companion.",
      cls: "lcy-rw-subtitle"
    });

    const grid = root.createDiv({ cls: "lcy-rw-grid" });
    this.button(grid, "Start Cat", () => this.plugin.startDesktopCat({ showNotice: true }));
    this.button(grid, "Check Cat", () => this.plugin.checkDesktopCatStatus(true));
    this.button(grid, "Draft Source", () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) return new Notice("Open a parsed Markdown file first.");
      return this.plugin.draftSourceNoteFromFile(file);
    });
    this.button(grid, "Audit Vault", () => this.plugin.auditVault({ openReport: true }));

    const status = root.createDiv({ cls: "lcy-rw-card" });
    status.createEl("h3", { text: "Status" });
    status.createEl("div", { text: this.plugin.lastLog || "Ready.", cls: "lcy-rw-log" });

    const findings = root.createDiv({ cls: "lcy-rw-card" });
    findings.createEl("h3", { text: `Audit Findings (${this.plugin.auditFindings.length})` });
    if (!this.plugin.auditFindings.length) {
      findings.createEl("p", { text: "No findings in the current session." });
      return;
    }
    for (const finding of this.plugin.auditFindings.slice(0, 30)) {
      const item = findings.createDiv({ cls: "lcy-rw-finding" });
      item.createSpan({
        text: finding.severity,
        cls: `lcy-rw-badge lcy-rw-badge-${finding.severity}`
      });
      item.createSpan({ text: finding.kind });
      item.createEl("div", { text: finding.path });
      item.createEl("small", { text: finding.message });
    }
  }

  button(parent, text, callback) {
    const button = parent.createEl("button", { text, cls: "lcy-rw-button" });
    button.onclick = callback;
  }
}

class ResearchWikiSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const t = (key) => this.plugin.tr(key);
    containerEl.empty();
    containerEl.createEl("h2", { text: t("settingsTitle") });
    new Setting(containerEl)
      .setName(t("interfaceLanguage"))
      .setDesc(t("interfaceLanguageDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh-CN", "中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.uiLanguage || "zh-CN")
          .onChange(async (value) => {
            this.plugin.settings.uiLanguage = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    this.quickStartSection(containerEl);
    this.modelSection(containerEl);
    this.mineruSection(containerEl);
    this.architectureSection(containerEl);
    this.advancedSection(containerEl);
  }

  quickStartSection(containerEl) {
    const t = (key) => this.plugin.tr(key);
    containerEl.createEl("h3", { text: t("quickStart") });
    new Setting(containerEl)
      .setName(t("initialize"))
      .setDesc(t("initializeDesc"))
      .addButton((button) =>
        button.setButtonText(t("initializeButton")).onClick(() => this.plugin.initializeCurrentVault())
      );
    new Setting(containerEl)
      .setName(t("startCat"))
      .setDesc(t("startCatDesc"))
      .addButton((button) =>
        button.setButtonText(t("startCatButton")).onClick(() => this.plugin.startDesktopCat({ showNotice: true }))
      );
    new Setting(containerEl)
      .setName(t("sync"))
      .setDesc(t("syncDesc"))
      .addButton((button) => button.setButtonText(t("syncButton")).onClick(() => this.plugin.syncCompanionSettings()));
    new Setting(containerEl)
      .setName(t("companionStatus"))
      .setDesc(this.plugin.lastLog || t("companionStatusDesc"))
      .addButton((button) => button.setButtonText(t("check")).onClick(() => this.plugin.checkDesktopCatStatus(true)));
    new Setting(containerEl)
      .setName(t("autoStart"))
      .setDesc(t("autoStartDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.cat.autoStartOnObsidianLaunch).onChange(async (value) => {
          this.plugin.settings.cat.autoStartOnObsidianLaunch = value;
          await this.plugin.saveSettings();
        })
      );
  }

  modelSection(containerEl) {
    const t = (key) => this.plugin.tr(key);
    containerEl.createEl("h3", { text: t("modelApi") });
    new Setting(containerEl)
      .setName(t("dryRun"))
      .setDesc(t("dryRunDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.companion.dryRun).onChange(async (value) => {
          this.plugin.settings.companion.dryRun = value;
          await this.plugin.saveSettings();
          await this.plugin.syncCompanionSettings();
        })
      );
    this.objectTextSetting(containerEl, t("providerLabel"), this.plugin.settings.model, "providerName", t("providerLabelDesc"));
    this.objectTextSetting(containerEl, t("baseUrl"), this.plugin.settings.model, "baseUrl", t("baseUrlDesc"));
    this.objectTextSetting(containerEl, t("model"), this.plugin.settings.model, "model", t("modelDesc"));
    this.objectTextSetting(containerEl, t("apiKey"), this.plugin.settings.model, "apiKey", t("apiKeyDesc"), true);
    this.objectTextSetting(containerEl, t("apiKeyEnv"), this.plugin.settings.model, "apiKeyEnv", t("apiKeyEnvDesc"));
    this.objectNumberSetting(containerEl, t("temperature"), this.plugin.settings.model, "temperature");
    this.objectNumberSetting(containerEl, t("maxTokens"), this.plugin.settings.model, "maxTokens");
  }

  mineruSection(containerEl) {
    const t = (key) => this.plugin.tr(key);
    containerEl.createEl("h3", { text: t("mineruApi") });
    new Setting(containerEl)
      .setName(t("enableMinerU"))
      .setDesc(t("enableMinerUDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.mineru.enabled).onChange(async (value) => {
          this.plugin.settings.mineru.enabled = value;
          await this.plugin.saveSettings();
          await this.plugin.syncCompanionSettings();
        })
      );
    this.objectTextAreaSetting(containerEl, t("mineruTokens"), this.plugin.settings.mineru, "apiTokens", t("mineruTokensDesc"), 4, true);
    this.objectTextSetting(containerEl, t("parseLanguage"), this.plugin.settings.mineru, "language", t("parseLanguageDesc"));
    this.toggleSetting(containerEl, t("ocr"), this.plugin.settings.mineru, "isOcr", t("ocrDesc"));
    this.toggleSetting(containerEl, t("formula"), this.plugin.settings.mineru, "enableFormula", t("formulaDesc"));
    this.toggleSetting(containerEl, t("table"), this.plugin.settings.mineru, "enableTable", t("tableDesc"));
    this.pathSetting(containerEl, t("rawMineru"), "rawMineru", t("rawMineruDesc"));
    this.pathSetting(containerEl, t("rawParsed"), "rawParsed", t("rawParsedDesc"));
    this.pathSetting(containerEl, t("assets"), "assets", t("assetsDesc"));
    this.toggleSetting(containerEl, t("archivePdfs"), this.plugin.settings.mineru, "archiveOriginal", t("archivePdfsDesc"));
  }

  architectureSection(containerEl) {
    const t = (key) => this.plugin.tr(key);
    containerEl.createEl("h3", { text: t("wikiArchitecture") });
    new Setting(containerEl)
      .setName(t("folderPreset"))
      .setDesc(t("folderPresetDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.architecture.useCurrentVaultDefaults).onChange(async (value) => {
          this.plugin.settings.architecture.useCurrentVaultDefaults = value;
          await this.plugin.saveSettings();
        })
      );
    this.objectTextAreaSetting(containerEl, t("researchRequirements"), this.plugin.settings.architecture, "researchRequirements", t("researchRequirementsDesc"), 5);
    this.languageDropdown(containerEl);
    this.pathSetting(containerEl, t("rawFolder"), "raw", "Untouched source materials.");
    this.pathSetting(containerEl, t("sourceNotesFolder"), "sources", "One curated note per paper, lecture, dataset, or webpage.");
    this.pathSetting(containerEl, t("conceptsFolder"), "concepts", "Reusable mechanisms and theoretical concepts.");
    this.pathSetting(containerEl, t("methodsFolder"), "methods", "Experimental, simulation, algorithmic, and analysis methods.");
    this.pathSetting(containerEl, t("materialsFolder"), "materials", "Concrete material systems, interfaces, devices, and datasets-as-objects.");
    this.pathSetting(containerEl, t("questionsFolder"), "questions", "Open questions and follow-up tasks.");
    this.pathSetting(containerEl, t("synthesesFolder"), "syntheses", "Higher-level summaries, comparisons, and research maps.");
    this.pathSetting(containerEl, t("templatesFolder"), "templates", "Vault templates.");
    this.objectTextAreaSetting(containerEl, t("sourceNoteTemplate"), this.plugin.settings.architecture, "sourceNoteTemplate", "Used for plugin-generated drafts and synced to the companion.", 10);
    this.objectTextAreaSetting(containerEl, t("topicPolicy"), this.plugin.settings.architecture, "topicExtractionPolicy", "Controls concept/question/material/method extraction behavior.", 7);
    this.objectTextAreaSetting(containerEl, t("documentPrompt"), this.plugin.settings.architecture, "documentPrompt", "Architecture-aware prompt used by the companion for document processing.", 12);
    new Setting(containerEl)
      .setName(t("generateArchitecture"))
      .setDesc(t("generateArchitectureDesc"))
      .addButton((button) => button.setButtonText(t("generate")).onClick(() => this.plugin.generateArchitectureWithLlm()));
    new Setting(containerEl)
      .setName(t("applyArchitecture"))
      .setDesc(t("applyArchitectureDesc"))
      .addButton((button) => button.setButtonText(t("apply")).onClick(() => this.plugin.applyArchitecture()));
    new Setting(containerEl)
      .setName(t("resetDefaults"))
      .setDesc(t("resetDefaultsDesc"))
      .addButton((button) => button.setButtonText(t("reset")).onClick(() => this.plugin.resetArchitectureDefaults()));
  }

  advancedSection(containerEl) {
    const t = (key) => this.plugin.tr(key);
    const details = containerEl.createEl("details", { cls: "lcy-rw-settings-details" });
    details.open = Boolean(this.plugin.settings.advanced.show);
    details.addEventListener("toggle", async () => {
      this.plugin.settings.advanced.show = details.open;
      await this.plugin.saveSettings();
    });
    details.createEl("summary", { text: t("advanced") });
    const body = details.createDiv({ cls: "lcy-rw-settings-detail-body" });
    this.toggleSetting(body, t("preferBundledRuntime"), this.plugin.settings.cat, "preferBundledRuntime", t("preferBundledRuntimeDesc"));
    this.objectTextSetting(body, t("bundledRuntimeFolder"), this.plugin.settings.cat, "bundledRuntimeDir", t("bundledRuntimeFolderDesc"), false, cleanPath);
    this.objectTextSetting(body, t("executablePath"), this.plugin.settings.cat, "executablePath", t("executablePathDesc"));
    this.objectTextSetting(body, t("statusUrl"), this.plugin.settings.cat, "statusUrl", t("statusUrlDesc"));
    this.objectTextSetting(body, t("runtimeStateFolder"), this.plugin.settings.advanced, "runtimeStateFolder", t("runtimeStateFolderDesc"), false, cleanPath);
    this.objectNumberSetting(body, t("timeoutMs"), this.plugin.settings.advanced, "timeoutMs");
    this.objectNumberSetting(body, t("scanInterval"), this.plugin.settings.companion, "intervalSeconds");
  }

  languageDropdown(parent) {
    const t = (key) => this.plugin.tr(key);
    new Setting(parent)
      .setName(t("outputLanguage"))
      .setDesc(t("outputLanguageDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh-CN", "中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.architecture.outputLanguage || "zh-CN")
          .onChange(async (value) => {
            this.plugin.settings.architecture.outputLanguage = value;
            await this.plugin.saveSettings();
            await this.plugin.syncCompanionSettings();
          })
      );
  }

  pathSetting(parent, name, key, desc = "") {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text.setValue(this.plugin.settings.paths[key]).onChange(async (value) => {
          this.plugin.settings.paths[key] = cleanPath(value);
          if (key === "rawParsed") this.plugin.settings.mineru.outputFolder = this.plugin.settings.paths.rawParsed;
          if (key === "assets") this.plugin.settings.mineru.assetsFolder = this.plugin.settings.paths.assets;
          await this.plugin.saveSettings();
        })
      );
  }

  objectTextSetting(parent, name, target, key, desc = "", password = false, normalize = (value) => value) {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        {
          if (password) text.inputEl.type = "password";
          return text.setValue(String(target[key] || "")).onChange(async (value) => {
            target[key] = normalize(value);
            await this.plugin.saveSettings();
          });
        }
      );
  }

  objectTextAreaSetting(parent, name, target, key, desc = "", rows = 6, password = false) {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addTextArea((text) => {
        text.inputEl.rows = rows;
        text.inputEl.addClass("lcy-rw-settings-textarea");
        if (password) text.inputEl.addClass("lcy-rw-secret-textarea");
        return text.setValue(String(target[key] || "")).onChange(async (value) => {
          target[key] = value;
          await this.plugin.saveSettings();
        });
      });
  }

  objectNumberSetting(parent, name, target, key) {
    new Setting(parent)
      .setName(name)
      .addText((text) =>
        text.setValue(String(target[key] || "")).onChange(async (value) => {
          const number = Number(value);
          target[key] = Number.isFinite(number) ? number : target[key];
          await this.plugin.saveSettings();
        })
      );
  }

  toggleSetting(parent, name, target, key, desc = "") {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle.setValue(Boolean(target[key])).onChange(async (value) => {
          target[key] = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

module.exports = ResearchWikiPlugin;
