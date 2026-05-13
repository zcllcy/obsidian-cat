const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config", "agent.config.json");
const EXAMPLE_CONFIG_PATH = path.join(PROJECT_ROOT, "config", "agent.config.example.json");
const APP_DATA_DIR = path.join(process.env.APPDATA || PROJECT_ROOT, "Obsidian Cat");
const STATE_DIR = process.env.CAT_VAULT_STATE_DIR || path.join(APP_DATA_DIR, "state");
const LOG_DIR = process.env.CAT_VAULT_LOG_DIR || path.join(APP_DATA_DIR, "logs");
const JOBS_PATH = path.join(STATE_DIR, "jobs.json");
const PROCESSED_PATH = path.join(STATE_DIR, "processed.json");
const LOG_PATH = path.join(LOG_DIR, "agent.log");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

const MINERU_UPLOAD_URL = "https://mineru.net/api/v4/file-urls/batch";
const MINERU_RESULT_URL = "https://mineru.net/api/v4/extract-results/batch/";

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

function defaultTopicExtractionPolicy(paths = {}) {
  return [
    `Source notes go to ${paths.sources || "wiki/sources"}.`,
    `Concepts go to ${paths.concepts || "wiki/concepts"}.`,
    `Methods go to ${paths.methods || "wiki/methods"}.`,
    `Materials go to ${paths.materials || "wiki/materials"}.`,
    `Questions go to ${paths.questions || "wiki/questions"}.`,
    "Do not fabricate metadata, topics, or evidence.",
    "Reject status markers such as Not found in extracted text, Needs verification, and Status: uncertain as topic titles."
  ].join("\n");
}

function defaultDocumentPrompt(config = {}) {
  const paths = config.architecture?.paths || {};
  return [
    "You are Obsidian Cat, a careful research-vault assistant.",
    `Research focus: ${config.architecture?.researchRequirements || "LLM research, phonon research, and their intersection."}`,
    "Create a complete Obsidian source note. Keep the required Markdown headings in English and write body content in Chinese unless requested otherwise.",
    "In `Research Classification`, include explicit `Materials/System:` and `Methods:` lines with comma-separated phrase-level items when supported by the source.",
    "In `Reusable Concepts` and `Follow-Up Questions`, prefer Obsidian wiki links to durable topic notes, for example [[wiki/concepts/Phonon Scattering]] and [[wiki/questions/Which phonon descriptors are useful for thermal conductivity prediction]].",
    "Do not invent bibliographic metadata. Missing fields must be written as `Not found in extracted text`.",
    "Mark uncertain statements as `Status: uncertain` or `Needs verification`.",
    "Every non-obvious scientific claim must be tied to source evidence when available.",
    "Preserve YAML frontmatter with `type: literature-note`, `status: processed`, `source_path`, and `created_by: Obsidian Cat`.",
    "`Research Classification` must include Source Type, Domain, Materials/System, Task/Problem, Methods, and Data/Code fields.",
    "`Results And Evidence`, `Figures And Tables`, and `Important Equations Or Variables` should be Markdown tables when evidence is available.",
    "Add `### Key Figure Gallery` inside `Figures And Tables` when parsed Markdown contains image links. Reuse the original Obsidian image links exactly.",
    "`Links To Existing Vault Topics` should group Concepts, Materials, Methods, Entities, Syntheses, and Questions.",
    "",
    "Vault paths:",
    `- Source notes: ${paths.sources || config.output?.sourceNotesFolder || "wiki/sources"}`,
    `- Concepts: ${paths.concepts || "wiki/concepts"}`,
    `- Methods: ${paths.methods || "wiki/methods"}`,
    `- Materials: ${paths.materials || "wiki/materials"}`,
    `- Questions: ${paths.questions || config.output?.questionsFolder || "wiki/questions"}`
  ].join("\n");
}

const status = {
  startedAt: new Date().toISOString(),
  lastRunAt: null,
  lastMessage: "starting",
  processedThisSession: 0,
  pending: 0,
  queueLength: 0,
  processing: false,
  activeFile: null,
  lastProcessed: null,
  dryRun: true,
  petMood: "curious",
  errors: []
};

let runPromise = null;
let server = null;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function log(message, extra = {}) {
  ensureDir(LOG_DIR);
  const line = JSON.stringify({ time: new Date().toISOString(), message, ...extra });
  fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
  status.lastMessage = message;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    ensureDir(path.dirname(CONFIG_PATH));
    fs.copyFileSync(EXAMPLE_CONFIG_PATH, CONFIG_PATH);
  }
  const config = readJson(CONFIG_PATH, {});
  config.host = config.host || "127.0.0.1";
  config.port = Number(config.port || 4317);
  config.vaultRoot = path.resolve(PROJECT_ROOT, config.vaultRoot || "..");
  config.intervalSeconds = Number(config.intervalSeconds || 300);
  config.ingest = config.ingest || {};
  config.ingest.feedFolder = config.ingest.feedFolder || "ingest";
  config.ingest.folders = config.ingest.folders || ["ingest", "inbox"];
  config.ingest.extensions = config.ingest.extensions || [".md", ".txt", ".pdf"];
  config.ingest.excludeFolders = config.ingest.excludeFolders || ["raw", "wiki", "templates"];
  config.ingest.maxCharsPerFile = Number(config.ingest.maxCharsPerFile || 30000);
  config.ingest.maxDraggedTextChars = Number(config.ingest.maxDraggedTextChars || 2000000);
  config.parser = config.parser || {};
  config.parser.mineru = config.parser.mineru || {};
  config.parser.mineru.enabled = config.parser.mineru.enabled !== false;
  config.parser.mineru.outputFolder = config.parser.mineru.outputFolder || "raw/parsed";
  config.parser.mineru.rawOutputFolder = config.parser.mineru.rawOutputFolder || "raw/mineru";
  config.parser.mineru.assetsFolder = config.parser.mineru.assetsFolder || "wiki/assets";
  config.parser.mineru.processedFolder = config.parser.mineru.processedFolder || "raw/processed_pdfs";
  config.parser.mineru.failedFolder = config.parser.mineru.failedFolder || "raw/failed_pdfs";
  config.parser.mineru.manifestPath = config.parser.mineru.manifestPath || "raw/mineru_manifest.csv";
  config.parser.mineru.apiTokens = config.parser.mineru.apiTokens || config.parser.mineru.apiToken || "";
  delete config.parser.mineru.apiFile;
  delete config.parser.mineru.apiToken;
  config.parser.mineru.language = config.parser.mineru.language || "ch";
  config.parser.mineru.isOcr = config.parser.mineru.isOcr !== false;
  config.parser.mineru.enableFormula = config.parser.mineru.enableFormula !== false;
  config.parser.mineru.enableTable = config.parser.mineru.enableTable !== false;
  config.output = config.output || {};
  config.output.sourceNotesFolder = config.output.sourceNotesFolder || "wiki/sources";
  config.output.questionsFolder = config.output.questionsFolder || "wiki/questions";
  config.output.language = config.output.language || "zh-CN";
  config.output.sourceNoteTemplate = config.output.sourceNoteTemplate || defaultSourceNoteTemplate();
  config.output.topicExtractionPolicy = config.output.topicExtractionPolicy || defaultTopicExtractionPolicy(config.architecture?.paths || {});
  config.output.analysisPrompt = config.output.analysisPrompt || defaultDocumentPrompt(config);
  config.model = config.model || {};
  delete config.model.externalConfig;
  delete config.model.legacyExternalConfig;
  config.maintenance = config.maintenance || {};
  status.dryRun = Boolean(config.dryRun);
  status.petMood = config.pet?.mood || "curious";
  return config;
}

function saveConfigPatch(patch) {
  const old = loadConfig();
  const merged = deepMerge(old, patch || {});
  writeJson(CONFIG_PATH, merged);
  return merged;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) out[key] = deepMerge(base[key] || {}, value);
    else out[key] = value;
  }
  return out;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeName(value, fallback = "source") {
  const clean = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean || `${fallback}-${Date.now()}`;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function fileHash(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function loadJobs() {
  const data = readJson(JOBS_PATH, { jobs: [] });
  data.jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return data;
}

function saveJobs(data) {
  writeJson(JOBS_PATH, data);
  status.queueLength = data.jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  status.pending = status.queueLength;
}

function loadProcessed() {
  const state = readJson(PROCESSED_PATH, { processed: {}, processedHashes: {} });
  state.processed = state.processed || {};
  state.processedHashes = state.processedHashes || {};
  return state;
}

function saveProcessed(state) {
  writeJson(PROCESSED_PATH, state);
}

function enqueueFile(config, filePath) {
  const source = path.resolve(filePath);
  if (!fs.existsSync(source)) throw new Error(`file not found: ${source}`);
  const vault = path.resolve(config.vaultRoot);
  const digest = fileHash(source);
  const jobs = loadJobs();
  const processed = loadProcessed();

  const old = jobs.jobs.find((job) => job.hash === digest || path.resolve(job.filePath) === source);
  if (old && old.status === "failed") {
    old.status = "queued";
    old.message = "re-queued failed job";
    old.updatedAt = new Date().toISOString();
    saveJobs(jobs);
    return old;
  }
  if (old && ["queued", "running"].includes(old.status)) return old;
  if (processed.processedHashes[digest]) return { status: "processed", filePath: source, hash: digest };

  const job = {
    id: `job_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    filePath: source,
    hash: digest,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  jobs.jobs.push(job);
  saveJobs(jobs);
  log("file queued", { filePath: source, vault });
  return job;
}

function copyIntoIngest(config, sourcePath) {
  const vault = path.resolve(config.vaultRoot);
  const ingest = path.join(vault, config.ingest.feedFolder || "ingest");
  ensureDir(ingest);
  const source = path.resolve(sourcePath);
  const digest = fileHash(source);
  for (const existing of walk(ingest)) {
    if (fs.statSync(existing).isFile() && fileHash(existing) === digest) return existing;
  }
  let target = path.join(ingest, path.basename(source));
  if (fs.existsSync(target)) {
    const ext = path.extname(source);
    target = path.join(ingest, `${path.basename(source, ext)}-${Date.now()}${ext}`);
  }
  if (source !== target) fs.copyFileSync(source, target);
  return target;
}

function collectCandidates(config) {
  const vault = path.resolve(config.vaultRoot);
  const exts = new Set((config.ingest.extensions || []).map((item) => item.toLowerCase()));
  const folders = [...new Set([config.ingest.feedFolder || "ingest", ...(config.ingest.folders || [])])];
  const processed = loadProcessed();
  const jobs = loadJobs();
  const known = new Set(jobs.jobs.filter((job) => job.status !== "failed").map((job) => path.resolve(job.filePath)));
  const knownHashes = new Set(jobs.jobs.filter((job) => job.status !== "failed").map((job) => job.hash));
  for (const folder of folders) {
    const dir = path.resolve(vault, folder);
    if (!isInside(vault, dir)) continue;
    for (const filePath of walk(dir)) {
      if (!exts.has(path.extname(filePath).toLowerCase())) continue;
      const digest = fileHash(filePath);
      if (processed.processedHashes[digest]) {
        archiveAlreadyProcessedFile(config, filePath);
        continue;
      }
      if (known.has(path.resolve(filePath)) || knownHashes.has(digest)) continue;
      jobs.jobs.push({
        id: `job_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        filePath,
        hash: digest,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
  }
  saveJobs(jobs);
}

function archiveAlreadyProcessedFile(config, filePath) {
  if (path.extname(filePath).toLowerCase() !== ".pdf") return;
  const vault = path.resolve(config.vaultRoot);
  const ingest = path.resolve(vault, config.ingest.feedFolder || "ingest");
  const source = path.resolve(filePath);
  if (!isInside(ingest, source)) return;
  movePdf(source, path.resolve(vault, config.parser?.mineru?.processedFolder || "raw/processed_pdfs"));
}

async function runQueue() {
  if (runPromise) return runPromise;
  runPromise = runQueueInner().finally(() => {
    runPromise = null;
  });
  return runPromise;
}

async function runQueueInner() {
  const config = loadConfig();
  collectCandidates(config);
  const data = loadJobs();
  status.lastRunAt = new Date().toISOString();
  const queued = data.jobs.filter((job) => job.status === "queued");
  saveJobs(data);
  log("scan complete", { pending: queued.length });

  for (const job of queued) {
    status.processing = true;
    status.activeFile = job.filePath;
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    saveJobs(data);
    try {
      await processJob(config, job);
      job.status = "done";
      job.updatedAt = new Date().toISOString();
      job.message = "processed";
      status.processedThisSession += 1;
      status.lastProcessed = job.filePath;
    } catch (error) {
      job.status = "failed";
      job.updatedAt = new Date().toISOString();
      job.message = error.message || String(error);
      status.errors.unshift({ time: new Date().toISOString(), message: job.message, filePath: job.filePath });
      status.errors = status.errors.slice(0, 10);
      log("processing error", { error: job.message, filePath: job.filePath });
    } finally {
      status.processing = false;
      status.activeFile = null;
      saveJobs(data);
    }
  }
}

async function processJob(config, job) {
  let source = job.filePath;
  if (path.extname(source).toLowerCase() === ".pdf") {
    if (!config.parser.mineru.enabled) throw new Error("PDF parser is disabled");
    source = await parsePdfWithMineru(source, config);
  }
  const text = fs.readFileSync(source, "utf8").slice(0, config.ingest.maxCharsPerFile);
  const markdown = config.dryRun ? buildSourceNoteDraft(config, source, text) : await generateSourceNote(config, source, text);
  const outputDir = path.resolve(config.vaultRoot, config.output.sourceNotesFolder);
  ensureDir(outputDir);
  const outputTitle = sourceNoteTitle(markdown, text) || path.basename(source, path.extname(source));
  let outputPath = path.join(outputDir, `${safeName(outputTitle)}.md`);
  let count = 2;
  while (fs.existsSync(outputPath)) {
    outputPath = path.join(outputDir, `${safeName(outputTitle)} ${count}.md`);
    count += 1;
  }
  fs.writeFileSync(outputPath, markdown.trim() + "\n", "utf8");
  promoteTopicsFromSourceNote(config, outputPath);

  const processed = loadProcessed();
  processed.processed[job.filePath] = job.hash;
  processed.processedHashes[job.hash] = job.filePath;
  saveProcessed(processed);
  log("processed file", { filePath: job.filePath, outputPath });
}

function firstMarkdownTitle(markdown) {
  const match = /^#\s+(.+)$/m.exec(markdown || "");
  return match ? match[1].trim() : "";
}

function sourceNoteTitle(markdown, sourceText) {
  const heading = firstMarkdownTitle(markdown);
  if (heading && !looksLikeParsedSlug(heading)) return heading;
  const citationTitle = /^\s*-\s*Title\s*:\s*(.+?)\s*$/im.exec(markdown || "")?.[1]?.trim();
  if (citationTitle && !isMissingValue(citationTitle)) return citationTitle;
  const sourceTitle = firstMarkdownTitle(sourceText);
  if (sourceTitle && !looksLikeParsedSlug(sourceTitle)) return sourceTitle;
  return heading || citationTitle || sourceTitle || "";
}

function looksLikeParsedSlug(value) {
  const text = String(value || "").trim();
  return /^[a-f0-9]{8,}$/i.test(text) || /-[a-f0-9]{8,}$/i.test(text) || /^full$/i.test(text);
}

function isMissingValue(value) {
  return /^(not found in extracted text|needs verification|status:)/i.test(String(value || "").trim());
}

function buildSourceNoteDraft(config, source, text) {
  const rel = path.relative(config.vaultRoot, source).replaceAll("\\", "/");
  const title = safeName(path.basename(source, path.extname(source)));
  let note = config.output.sourceNoteTemplate || defaultSourceNoteTemplate();
  note = note
    .replaceAll("{{title}}", title)
    .replaceAll("{{sourcePath}}", rel)
    .replaceAll("{{createdAt}}", new Date().toISOString());
  if (!/^#\s+/m.test(note)) note = `# ${title}\n\n${note}`;
  if (!note.includes("source_path:")) note = note.replace(/^# .+$/m, `$&\n\nsource_path: ${rel}\nStatus: draft`);
  for (const heading of REQUIRED_SOURCE_HEADINGS) {
    if (!note.includes(`## ${heading}`)) note += `\n## ${heading}\n\n${placeholderFor(heading)}\n`;
  }
  return [
    note.trimEnd(),
    "",
    "### Source Excerpt",
    "",
    "```text",
    text.slice(0, 5000),
    "```"
  ].join("\n");
}

function placeholderFor(heading) {
  if (heading === "Citation" || heading === "Figures And Tables" || heading === "Important Equations Or Variables") {
    return "Not found in extracted text";
  }
  if (heading === "Reusable Concepts" || heading === "Links To Existing Vault Topics" || heading === "Follow-Up Questions") {
    return "- Not found in extracted text";
  }
  return "Needs verification";
}

async function generateSourceNote(config, source, text) {
  const modelConfig = resolveModelConfig(config);
  if (!modelConfig.baseUrl || !modelConfig.model) return buildSourceNoteDraft(config, source, text);
  const sourceImages = extractSourceImages(text);
  const prompt = buildPromptV2(config, source, text);
  try {
    const content = await callModel(modelConfig, prompt);
    return ensureSourceNoteShape(config, source, ensureSourceHeadings(content || buildSourceNoteDraft(config, source, text)), sourceImages);
  } catch (error) {
    log("model generation failed; using draft", { error: error.message });
    return buildSourceNoteDraft(config, source, text);
  }
}

function resolveModelConfig(config) {
  const merged = { ...(config.model || {}) };
  merged.baseUrl = merged.baseUrl || merged.base_url || "";
  merged.model = merged.model || merged.model_fallback || "";
  if (Array.isArray(merged.model)) merged.model = merged.model[0] || "";
  if (!merged.apiKey && merged.api_key) merged.apiKey = merged.api_key;
  if (!merged.apiKey && merged.apiKeyEnv) merged.apiKey = process.env[merged.apiKeyEnv] || "";
  return merged;
}

function buildPrompt(config, source, text) {
  const rel = path.relative(config.vaultRoot, source).replaceAll("\\", "/");
  const headings = REQUIRED_SOURCE_HEADINGS.map((h) => `## ${h}`).join("\n");
  return [
    config.output.analysisPrompt || "你是一个严谨的科研知识库整理助手。正文用中文，Markdown 模板标题保持英文。",
    "",
    "Create a complete Obsidian source note using exactly these second-level headings:",
    headings,
    "",
    "Rules:",
    "- Do not invent bibliographic metadata.",
    "- Missing fields must be `Not found in extracted text`.",
    "- Uncertain claims must include `Status: uncertain` or `Needs verification`.",
    "- Link non-obvious claims to source evidence when available.",
    "",
    `Source path: ${rel}`,
    "",
    "Source content:",
    text
  ].join("\n");
}

function buildPromptV2(config, source, text) {
  const rel = path.relative(config.vaultRoot, source).replaceAll("\\", "/");
  const headings = REQUIRED_SOURCE_HEADINGS.map((h) => `## ${h}`).join("\n");
  return [
    config.output.analysisPrompt || defaultDocumentPrompt(config),
    "",
    "Target source-note template/schema:",
    "```markdown",
    config.output.sourceNoteTemplate || defaultSourceNoteTemplate(),
    "```",
    "",
    "Create a complete Obsidian source note using exactly these second-level headings:",
    headings,
    "",
    "Topic extraction policy:",
    config.output.topicExtractionPolicy || defaultTopicExtractionPolicy(config.architecture?.paths || {}),
    "",
    "Rules:",
    "- Do not invent bibliographic metadata.",
    "- Missing fields must be `Not found in extracted text`.",
    "- Uncertain claims must include `Status: uncertain` or `Needs verification`.",
    "- Link non-obvious claims to source evidence when available.",
    "- Preserve the previous vault source-note format, including YAML frontmatter, classification fields, evidence tables, Key Figure Gallery, and grouped vault links.",
    "- If image links are present in the parsed Markdown, include the most important ones in `### Key Figure Gallery` without changing their paths.",
    "",
    `Source path: ${rel}`,
    "",
    "Source content:",
    text
  ].join("\n");
}

async function callModel(modelConfig, prompt) {
  const headers = { "content-type": "application/json" };
  if (modelConfig.apiKey) headers.authorization = `Bearer ${modelConfig.apiKey}`;
  const response = await fetch(chatCompletionsUrl(modelConfig.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelConfig.model,
      temperature: Number(modelConfig.temperature ?? 0.2),
      max_tokens: Number(modelConfig.maxTokens || modelConfig.max_tokens || 1800),
      messages: [
        { role: "system", content: "You are a careful scientific knowledge-base curator." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!response.ok) throw new Error(`model API failed ${response.status}: ${(await response.text()).slice(0, 400)}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

function chatCompletionsUrl(baseUrl) {
  const clean = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(clean)) return clean;
  if (/\/v\d+$/i.test(clean) || /\/compatible-mode\/v\d+$/i.test(clean)) return `${clean}/chat/completions`;
  return clean;
}

function ensureSourceHeadings(text) {
  let out = text.trim();
  for (const heading of REQUIRED_SOURCE_HEADINGS) {
    if (!new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").test(out)) {
      out += `\n\n## ${heading}\n\nNot found in extracted text`;
    }
  }
  return out;
}

function ensureSourceNoteShape(config, source, text, sourceImages = []) {
  const relPath = path.relative(config.vaultRoot, source).replaceAll("\\", "/");
  let out = text.trim();
  if (!/^---\s*[\s\S]*?\n---/m.test(out)) {
    out = [
      "---",
      "type: literature-note",
      "status: processed",
      `source_path: ${relPath}`,
      "created_by: Obsidian Cat",
      `created_at: ${new Date().toISOString()}`,
      "---",
      "",
      out
    ].join("\n");
  } else {
    out = out.replace(/^---\s*([\s\S]*?)\n---/m, (match, body) => {
      const lines = body.split(/\r?\n/).filter((line) => line.trim());
      const ensureField = (key, value) => {
        if (!lines.some((line) => new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line))) lines.push(`${key}: ${value}`);
      };
      ensureField("type", "literature-note");
      ensureField("status", "processed");
      ensureField("source_path", relPath);
      ensureField("created_by", "Obsidian Cat");
      return ["---", ...lines, "---"].join("\n");
    });
  }
  if (!out.includes("### Key Figure Gallery") && /!\[\[wiki\/assets\//.test(out)) {
    out = out.replace(/(^## Figures And Tables\s*$)/m, "$1\n\n### Key Figure Gallery\n");
  }
  if (sourceImages.length && !/!\[\[wiki\/assets\//.test(out)) {
    const gallery = [
      "### Key Figure Gallery",
      "",
      ...sourceImages.slice(0, 6).flatMap((item, index) => [
        `#### Key Figure ${index + 1}`,
        "",
        item.link,
        "",
        `- 中文图注：${item.caption || "Needs verification"}`,
        ""
      ])
    ].join("\n");
    if (out.includes("### Key Figure Gallery")) {
      out = out.replace(/### Key Figure Gallery\s*/, `${gallery}\n`);
    } else if (/^## Figures And Tables\s*$/m.test(out)) {
      out = out.replace(/(^## Figures And Tables\s*$)/m, `$1\n\n${gallery}`);
    }
  }
  return out;
}

function extractSourceImages(text) {
  const lines = String(text || "").split(/\r?\n/);
  const images = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /!\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/.exec(lines[i]);
    if (!match || !match[1].startsWith("wiki/assets/")) continue;
    const caption = nearbyCaption(lines, i);
    images.push({ link: `![[${match[1]}]]`, caption });
  }
  return images;
}

function nearbyCaption(lines, index) {
  const window = lines.slice(index + 1, Math.min(lines.length, index + 6)).join(" ").trim();
  const match = /(Fig(?:ure)?\.?\s*\d+[^。.\n]*[。.]?)/i.exec(window);
  return (match ? match[1] : window).replace(/\s+/g, " ").slice(0, 500);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function parsePdfWithMineru(sourcePath, config) {
  const mineru = config.parser.mineru;
  const tokens = mineruTokens(mineru);
  const token = tokens[0];
  if (!token) throw new Error("MinerU token not configured. Add tokens in Obsidian Cat settings or set MINERU_TOKEN.");

  const vault = path.resolve(config.vaultRoot);
  const pdfStem = safeName(path.basename(sourcePath, ".pdf"));
  const slug = pdfStem.slice(0, 120);
  const rawMineruDir = path.resolve(vault, mineru.rawOutputFolder || "raw/mineru");
  const outFolder = path.join(rawMineruDir, slug);
  const parsedDir = path.resolve(vault, mineru.outputFolder || "raw/parsed");
  ensureDir(rawMineruDir);
  ensureDir(parsedDir);

  if (fs.existsSync(outFolder)) {
    const existing = copyMineruMarkdownToParsed(outFolder, parsedDir, vault, mineru.assetsFolder || "wiki/assets", pdfStem);
    appendMineruManifest(config, { pdf: path.basename(sourcePath), data_id: "", batch_id: "", raw_output_dir: rel(vault, outFolder), parsed_files: rel(vault, existing), status: "skipped", message: "MinerU output folder already exists; copied markdown files to raw/parsed." });
    fs.rmSync(outFolder, { recursive: true, force: true });
    movePdf(sourcePath, path.resolve(vault, mineru.processedFolder || "raw/processed_pdfs"));
    return existing;
  }

  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const dataId = crypto.randomUUID();
  const payload = {
    enable_formula: mineru.enableFormula !== false,
    language: mineru.language || "ch",
    enable_table: mineru.enableTable !== false,
    files: [{ name: path.basename(sourcePath), is_ocr: mineru.isOcr !== false, data_id: dataId }]
  };
  let batchId = "";
  try {
    const uploadInfo = await jsonFetch(MINERU_UPLOAD_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    if (uploadInfo.code !== 0) throw new Error(`MinerU upload URL request failed: ${JSON.stringify(uploadInfo).slice(0, 400)}`);
    batchId = uploadInfo.data.batch_id;
    const uploadUrl = uploadInfo.data.file_urls[0];
    const put = await fetch(uploadUrl, { method: "PUT", body: fs.readFileSync(sourcePath) });
    if (!put.ok) throw new Error(`MinerU upload failed ${put.status}: ${(await put.text()).slice(0, 400)}`);

    let zipUrl = "";
    for (;;) {
      await sleep(5000);
      const result = await jsonFetch(`${MINERU_RESULT_URL}${batchId}`, { headers: { authorization: `Bearer ${token}` } });
      if (result.code !== 0) throw new Error(`MinerU polling failed: ${JSON.stringify(result).slice(0, 400)}`);
      const item = result.data?.extract_result?.[0];
      if (!item) continue;
      if (item.state === "failed") throw new Error(`MinerU failed: ${item.err_msg || "unknown error"}`);
      if (item.state === "done") {
        zipUrl = item.full_zip_url;
        break;
      }
    }

    const zipPath = path.join(outFolder, "result.zip");
    fs.rmSync(outFolder, { recursive: true, force: true });
    ensureDir(outFolder);
    await downloadToFile(zipUrl, zipPath);
    expandZip(zipPath, outFolder);
    for (const file of walk(outFolder)) {
      if (path.extname(file).toLowerCase() === ".pdf") fs.rmSync(file, { force: true });
    }
    const parsedPath = copyMineruMarkdownToParsed(outFolder, parsedDir, vault, mineru.assetsFolder || "wiki/assets", pdfStem);
    appendMineruManifest(config, { pdf: path.basename(sourcePath), data_id: dataId, batch_id: batchId, raw_output_dir: rel(vault, outFolder), parsed_files: rel(vault, parsedPath), status: "done", message: "Downloaded MinerU zip and copied markdown files to raw/parsed." });
    fs.rmSync(outFolder, { recursive: true, force: true });
    movePdf(sourcePath, path.resolve(vault, mineru.processedFolder || "raw/processed_pdfs"));
    return parsedPath;
  } catch (error) {
    appendMineruManifest(config, { pdf: path.basename(sourcePath), data_id: dataId, batch_id: batchId, raw_output_dir: rel(vault, outFolder), parsed_files: "", status: "failed", message: error.message || String(error) });
    fs.rmSync(outFolder, { recursive: true, force: true });
    movePdf(sourcePath, path.resolve(vault, mineru.failedFolder || "raw/failed_pdfs"));
    throw error;
  }
}

function mineruTokens(mineru) {
  const envTokens = [process.env.MINERU_TOKEN || "", ...(process.env.MINERU_TOKENS || "").split(/\r?\n/)];
  const settingTokens = String(mineru.apiTokens || "").split(/\r?\n/);
  return [...new Set([...envTokens, ...settingTokens].map((item) => item.trim()).filter(Boolean))];
}

function copyMineruMarkdownToParsed(outFolder, parsedDir, vault, assetFolder, preferredStem) {
  const md = walk(outFolder).find((file) => file.toLowerCase().endsWith(".md"));
  if (!md) throw new Error("MinerU produced no Markdown");
  const incoming = fs.readFileSync(md, "utf8");
  const baseStem = safeName(preferredStem || path.basename(md, ".md"));
  let target = path.join(parsedDir, `${baseStem}.md`);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf8");
    if (existing === normalizeMineruMarkdown(incoming, outFolder, vault, assetFolder, safeName(path.basename(target, ".md")))) return target;
    const ext = path.extname(target);
    target = path.join(parsedDir, `${path.basename(target, ext)}-${crypto.createHash("sha1").update(incoming).digest("hex").slice(0, 8)}${ext}`);
  }
  const slug = safeName(path.basename(target, ".md"));
  fs.writeFileSync(target, normalizeMineruMarkdown(fs.readFileSync(md, "utf8"), outFolder, vault, assetFolder, slug), "utf8");
  return target;
}

function normalizeMineruMarkdown(text, outFolder, vault, assetFolder, slug) {
  return rewriteAssetLinks(text, outFolder, vault, assetFolder, slug);
}

function appendMineruManifest(config, row) {
  const manifest = path.resolve(config.vaultRoot, config.parser.mineru.manifestPath || "raw/mineru_manifest.csv");
  ensureDir(path.dirname(manifest));
  const fields = ["pdf", "data_id", "batch_id", "raw_output_dir", "parsed_files", "status", "message"];
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, `${fields.join(",")}\n`, "utf8");
  fs.appendFileSync(manifest, `${fields.map((field) => csvCell(row[field] || "")).join(",")}\n`, "utf8");
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function movePdf(sourcePath, targetDir) {
  ensureDir(targetDir);
  let target = path.join(targetDir, path.basename(sourcePath));
  if (fs.existsSync(target)) {
    const ext = path.extname(target);
    target = path.join(targetDir, `${path.basename(target, ext)}-${crypto.createHash("sha1").update(fs.readFileSync(sourcePath)).digest("hex").slice(0, 8)}${ext}`);
  }
  fs.renameSync(sourcePath, target);
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
  return await response.json();
}

async function downloadToFile(url, target) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "ObsidianCat/0.1" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(target, buffer);
      return;
    } catch (error) {
      lastError = error;
      await sleep(Math.min(20000, attempt * 3000));
    }
  }
  const curl = spawnSync("curl.exe", ["-L", "--fail", "--silent", "--show-error", "--ssl-no-revoke", "--retry", "5", "-o", target, url], {
    encoding: "utf8",
    timeout: 420000
  });
  if (curl.status !== 0) throw new Error(`download failed: ${lastError?.message || ""}; curl: ${curl.stderr || curl.stdout}`);
}

function expandZip(zipPath, targetDir) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`], {
    encoding: "utf8",
    timeout: 120000
  });
  if (result.status !== 0) throw new Error(`zip extraction failed: ${result.stderr || result.stdout}`);
}

function rewriteAssetLinks(text, sourceRoot, vaultRoot, assetFolder, slug) {
  const assetsRoot = path.resolve(vaultRoot, assetFolder);
  const noteAssetDir = path.join(assetsRoot, slug);
  ensureDir(noteAssetDir);
  const media = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
  const replacements = new Map();
  for (const file of walk(sourceRoot)) {
    if (!media.has(path.extname(file).toLowerCase())) continue;
    const target = path.join(noteAssetDir, path.basename(file));
    fs.copyFileSync(file, target);
    const rel = path.relative(vaultRoot, target).replaceAll("\\", "/");
    replacements.set(path.basename(file), rel);
    replacements.set(path.relative(sourceRoot, file).replaceAll("\\", "/"), rel);
  }
  return normalizeMarkdownAssetLinks(text, replacements);
}

function normalizeMarkdownAssetLinks(text, replacements = new Map()) {
  const markdownImage = /!\[([^\]]*)\]\((.*?\.(?:png|jpg|jpeg|gif|webp|bmp|svg)(?:[?#][^\s)]*)?)\)/gi;
  let out = text.replace(markdownImage, (_match, _alt, rawPath) => {
    const normalized = normalizeAssetPath(rawPath, replacements);
    return normalized ? `![[${normalized}]]` : _match;
  });
  out = out.replace(/!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|webp|bmp|svg)(?:[?#][^\]]*)?)\]\]/gi, (_match, rawPath) => {
    const normalized = normalizeAssetPath(rawPath, replacements);
    return normalized ? `![[${normalized}]]` : _match;
  });
  return out;
}

function normalizeAssetPath(rawPath, replacements = new Map()) {
  let clean = String(rawPath || "").replaceAll("\\", "/").trim().replace(/^<|>$/g, "");
  clean = clean.split("#", 1)[0].split("?", 1)[0];
  clean = clean.replace(/^\.?\//, "").replace(/^\/+/, "");
  const marker = "wiki/assets/";
  if (clean.includes(marker)) clean = marker + clean.split(marker).pop();
  clean = clean.replace(/^images\//i, "");
  const direct = replacements.get(clean) || replacements.get(path.basename(clean));
  if (direct) return direct.replaceAll("\\", "/");
  if (clean.includes(marker)) return clean;
  return clean;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runMaintenance(config) {
  const normalizedLinks = normalizeVaultAssetLinks(config);
  const findings = auditVault(config);
  const reportPath = path.join(config.vaultRoot, "wiki", "syntheses", "Vault Pipeline Audit.md");
  ensureDir(path.dirname(reportPath));
  const lines = [
    "# Vault Pipeline Audit",
    "",
    "## Summary",
    "",
    `- Updated: ${new Date().toISOString()}`,
    `- Findings: ${findings.length}`,
    `- Normalized asset links: ${normalizedLinks}`,
    `- Errors: ${findings.filter((f) => f.severity === "error").length}`,
    `- Warnings: ${findings.filter((f) => f.severity === "warning").length}`,
    "",
    "## Findings",
    ""
  ];
  for (const item of findings) lines.push(`### ${item.kind}`, "", `- Severity: ${item.severity}`, `- Path: \`${item.path}\``, `- Message: ${item.message}`, "");
  if (!findings.length) lines.push("- No findings.");
  fs.writeFileSync(reportPath, lines.join("\n").trim() + "\n", "utf8");
  return findings;
}

function normalizeVaultAssetLinks(config) {
  const vault = path.resolve(config.vaultRoot);
  const targets = [
    path.join(vault, config.parser?.mineru?.outputFolder || "raw/parsed"),
    path.join(vault, config.output?.sourceNotesFolder || "wiki/sources")
  ];
  let count = 0;
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir).filter((item) => item.endsWith(".md"))) {
      const original = fs.readFileSync(file, "utf8");
      const normalized = normalizeMarkdownAssetLinks(original);
      if (normalized !== original) {
        fs.writeFileSync(file, normalized, "utf8");
        count += 1;
      }
    }
  }
  return count;
}

function promoteTopicsFromSourceNote(config, sourceNotePath) {
  const vault = path.resolve(config.vaultRoot);
  const text = fs.readFileSync(sourceNotePath, "utf8");
  const sourceRel = rel(vault, sourceNotePath).replace(/\.md$/i, "");
  const classification = sectionText(text, "Research Classification");
  const concepts = [
    ...wikiLinkTargets(sectionText(text, "Reusable Concepts")),
    ...wikiLinkTargets(sectionText(text, "Links To Existing Vault Topics")).filter((item) => item.includes("/concepts/"))
  ];
  const questions = [
    ...wikiLinkTargets(sectionText(text, "Follow-Up Questions")),
    ...wikiLinkTargets(sectionText(text, "Links To Existing Vault Topics")).filter((item) => item.includes("/questions/"))
  ];
  const methods = classificationField(classification, "Methods");
  const materials = classificationField(classification, "Materials/System");

  for (const title of uniqueTopicTitles(concepts)) writeTopicNote(vault, config.architecture?.paths?.concepts || "wiki/concepts", title, "concept", sourceRel);
  for (const title of uniqueTopicTitles(methods)) writeTopicNote(vault, config.architecture?.paths?.methods || "wiki/methods", title, "method", sourceRel);
  for (const title of uniqueTopicTitles(materials)) writeTopicNote(vault, config.architecture?.paths?.materials || "wiki/materials", title, "material", sourceRel);
  const questionTitles = uniqueTopicTitles(questions);
  for (const title of questionTitles) writeTopicNote(vault, config.architecture?.paths?.questions || "wiki/questions", title, "question", sourceRel);
  updateOpenQuestions(vault, config.architecture?.paths?.questions || "wiki/questions", questionTitles);
}

function sectionText(text, heading) {
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "im");
  const match = re.exec(text);
  return match ? match[1].trim() : "";
}

function wikiLinkTargets(text) {
  return [...String(text || "").matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function classificationField(text, label) {
  const re = new RegExp(`^\\s*-?\\s*${escapeRegExp(label)}\\s*:\\s*(.+)$`, "im");
  const match = re.exec(text || "");
  if (!match) return [];
  return splitTopicList(match[1]);
}

function splitTopicList(value) {
  return String(value || "")
    .replace(/\[\[|\]\]/g, "")
    .split(/[,;，；、]/)
    .map((item) => item.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

function uniqueTopicTitles(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const title = path.basename(String(item || "").replace(/\\/g, "/")).trim();
    const key = title.toLowerCase();
    if (!title || seen.has(key) || invalidTopicTitle(title)) continue;
    seen.add(key);
    out.push(title);
  }
  return out.slice(0, 12);
}

function invalidTopicTitle(title) {
  return /^(not found in extracted text|needs verification|status:|none|n\/a)$/i.test(title)
    || title.length < 2
    || title.length > 120
    || (title.match(/\(/g) || []).length !== (title.match(/\)/g) || []).length
    || (title.match(/\[/g) || []).length !== (title.match(/\]/g) || []).length;
}

function writeTopicNote(vault, folder, title, kind, sourceRel) {
  const dir = path.resolve(vault, folder);
  ensureDir(dir);
  const file = path.join(dir, `${safeName(title)}.md`);
  const link = `[[${sourceRel}]]`;
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, "utf8");
    if (!current.includes(link)) fs.appendFileSync(file, `\n## Supporting Sources\n\n- ${link}\n`, "utf8");
    return;
  }
  fs.writeFileSync(file, [
    `# ${title}`,
    "",
    `type: ${kind}`,
    "Status: draft",
    "",
    "## Definition",
    "",
    "Needs verification",
    "",
    "## Why It Matters",
    "",
    "Needs verification",
    "",
    "## Supporting Sources",
    "",
    `- ${link}`,
    ""
  ].join("\n"), "utf8");
}

function updateOpenQuestions(vault, questionsFolder, titles) {
  if (!titles.length) return;
  const file = path.resolve(vault, questionsFolder, "Open Questions.md");
  ensureDir(path.dirname(file));
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Open Questions\n\n";
  const additions = titles
    .map((title) => `- [[${questionsFolder}/${safeName(title)}|${title}]]`)
    .filter((line) => !current.includes(line));
  if (additions.length) fs.writeFileSync(file, `${current.trim()}\n${additions.join("\n")}\n`, "utf8");
}

function auditVault(config) {
  const vault = config.vaultRoot;
  const files = walk(path.join(vault, "wiki")).filter((file) => file.endsWith(".md"));
  const findings = [];
  for (const file of files.filter((f) => f.includes(`${path.sep}sources${path.sep}`))) {
    const text = fs.readFileSync(file, "utf8");
    const headings = new Set([...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()));
    const missing = REQUIRED_SOURCE_HEADINGS.filter((heading) => !headings.has(heading));
    if (missing.length) findings.push({ kind: "source_missing_headings", severity: "warning", path: rel(vault, file), message: missing.join(", ") });
  }
  const allSet = new Set(files.map((file) => rel(vault, file).replace(/\.md$/i, "")));
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
      const link = match[1].trim();
      if (link.startsWith("wiki/") && !link.startsWith("wiki/assets/") && !allSet.has(link)) {
        findings.push({ kind: "broken_wikilink", severity: "warning", path: rel(vault, file), message: `Broken wiki link: [[${link}]]` });
      }
    }
  }
  return findings;
}

function rel(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function vaultReady(config) {
  return fs.existsSync(path.join(config.vaultRoot, "wiki")) && fs.existsSync(path.join(config.vaultRoot, "raw"));
}

function defaultArchitecturePlan(requirements = "", language = "zh-CN") {
  const focus = requirements.trim() || "LLM research, phonon research, and their intersection";
  return {
    language,
    summary: `围绕 ${focus} 建立一个 Obsidian + LLM 维护的科研知识库。`,
    folders: [
      ".obsidian",
      "wiki",
      "wiki/sources",
      "wiki/concepts",
      "wiki/materials",
      "wiki/methods",
      "wiki/entities",
      "wiki/syntheses",
      "wiki/questions",
      "raw",
      "raw/parsed",
      "wiki/assets",
      "ingest",
      "inbox",
      "templates"
    ],
    home: [
      "# Home",
      "",
      "## Navigation",
      "- [[wiki/Literature Index]]",
      "- [[wiki/Map of Contents]]",
      "- [[wiki/questions/Open Questions]]",
      "",
      "## Current Focus",
      `- ${focus}`
    ],
    mapOfContents: [
      "# Map of Contents",
      "",
      "## Literature",
      "- [[wiki/Literature Index]]",
      "",
      "## Concepts",
      "- [[wiki/concepts/Phonon]]",
      "- [[wiki/concepts/Lattice Dynamics]]",
      "",
      "## Synthesis",
      "- [[wiki/syntheses/Research Map]]"
    ]
  };
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, Array.isArray(content) ? content.join("\n") + "\n" : `${content.trim()}\n`, "utf8");
}

function initializeVault(vaultRoot, architecture) {
  const vault = path.resolve(vaultRoot);
  const plan = architecture && typeof architecture === "object" ? architecture : defaultArchitecturePlan();
  ensureDir(vault);
  for (const folder of plan.folders || defaultArchitecturePlan().folders) {
    const target = path.resolve(vault, String(folder).replace(/\\/g, "/"));
    if (isInside(vault, target)) ensureDir(target);
  }
  writeIfMissing(path.join(vault, "wiki", "Home.md"), plan.home || defaultArchitecturePlan().home);
  writeIfMissing(path.join(vault, "wiki", "Literature Index.md"), "# Literature Index\n\n## Papers\n");
  writeIfMissing(path.join(vault, "wiki", "Map of Contents.md"), plan.mapOfContents || defaultArchitecturePlan().mapOfContents);
  writeIfMissing(path.join(vault, "wiki", "concepts", "Phonon.md"), "# Phonon\n\n声子是晶格振动的量子化集体激发。\n");
  writeIfMissing(path.join(vault, "wiki", "concepts", "Lattice Dynamics.md"), "# Lattice Dynamics\n\n晶格动力学研究固体中原子的振动模式与热输运相关性质。\n");
  writeIfMissing(path.join(vault, "wiki", "questions", "Open Questions.md"), "# Open Questions\n\n");
  writeIfMissing(path.join(vault, "wiki", "syntheses", "Research Map.md"), `# Research Map\n\n## Scope\n\n${plan.summary || ""}\n`);
  writeIfMissing(path.join(vault, "templates", "Source Note.md"), ["# {{title}}", "", ...REQUIRED_SOURCE_HEADINGS.flatMap((h) => [`## ${h}`, ""])]);
  saveConfigPatch({ vaultRoot: vault });
  return { vaultRoot: vault, architecture: plan };
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!boundaryMatch) return [];
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const raw = buffer.toString("binary");
  const parts = raw.split(boundary).slice(1, -1);
  const files = [];
  for (const part of parts) {
    const clean = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const splitAt = clean.indexOf("\r\n\r\n");
    if (splitAt < 0) continue;
    const headers = clean.slice(0, splitAt);
    const body = clean.slice(splitAt + 4);
    const filenameMatch = /filename="([^"]*)"/i.exec(headers);
    if (!filenameMatch || !filenameMatch[1]) continue;
    files.push({
      filename: path.basename(filenameMatch[1]),
      data: Buffer.from(body, "binary")
    });
  }
  return files;
}

function collectSearchContext(config, question) {
  const wiki = path.join(config.vaultRoot, "wiki");
  const terms = String(question || "")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((term) => term.length > 1);
  const candidates = walk(wiki).filter((file) => file.endsWith(".md"));
  const scored = [];
  for (const file of candidates) {
    const text = fs.readFileSync(file, "utf8");
    const lower = text.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    if (score > 0) scored.push({ path: rel(config.vaultRoot, file), text: text.slice(0, 2400), score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 6);
}

function sendJson(res, data, code = 200) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = urlPath === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, urlPath.replace(/^\/+/, ""));
  if (!isInside(PUBLIC_DIR, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8";
  res.writeHead(200, { "content-type": type });
  res.end(fs.readFileSync(file));
}

async function handleRequest(req, res) {
  const config = loadConfig();
  const url = (req.url || "/").split("?")[0];
  try {
    if (req.method === "GET" && url === "/api/status") {
      const jobs = loadJobs();
      status.queueLength = jobs.jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
      return sendJson(res, status);
    }
    if (req.method === "GET" && url === "/api/config") return sendJson(res, config);
    if (req.method === "GET" && url === "/api/vault-status") return sendJson(res, { ready: vaultReady(config), vaultRoot: config.vaultRoot });
    if (req.method === "GET" && url === "/api/pet-line") {
      const lines = ["我在巡逻知识库", "有新文献就拖给我", "今天也要把链接理顺", "队列空了我就继续整理"];
      return sendJson(res, { line: lines[Math.floor(Math.random() * lines.length)] });
    }
    if (req.method === "POST" && url === "/api/config") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      return sendJson(res, saveConfigPatch(body));
    }
    if (req.method === "POST" && url === "/api/feed-path") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const copied = copyIntoIngest(config, body.path);
      const job = enqueueFile(config, copied);
      runQueue().catch((error) => log("run failed", { error: error.message }));
      return sendJson(res, { ok: true, queued: job.status !== "processed", job, jobCount: status.queueLength });
    }
    if (req.method === "POST" && url === "/api/feed-text") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const ingest = path.join(config.vaultRoot, config.ingest.feedFolder || "ingest");
      ensureDir(ingest);
      const target = path.join(ingest, `${safeName(body.source || "text-capture")}-${Date.now()}.md`);
      fs.writeFileSync(target, String(body.text || "").slice(0, config.ingest.maxDraggedTextChars), "utf8");
      const job = enqueueFile(config, target);
      runQueue().catch((error) => log("run failed", { error: error.message }));
      return sendJson(res, { ok: true, queued: true, job });
    }
    if (req.method === "POST" && url === "/api/feed-upload") {
      const body = await readBody(req);
      const files = parseMultipart(body, req.headers["content-type"]);
      const ingest = path.join(config.vaultRoot, config.ingest.feedFolder || "ingest");
      ensureDir(ingest);
      const jobs = [];
      for (const file of files) {
        let target = path.join(ingest, safeName(file.filename, "upload"));
        if (fs.existsSync(target)) {
          const ext = path.extname(target);
          target = path.join(ingest, `${path.basename(target, ext)}-${Date.now()}${ext}`);
        }
        fs.writeFileSync(target, file.data);
        jobs.push(enqueueFile(config, target));
      }
      runQueue().catch((error) => log("run failed", { error: error.message }));
      return sendJson(res, { ok: true, queued: jobs.length > 0, jobs });
    }
    if (req.method === "POST" && url === "/api/feed-url") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const ingest = path.join(config.vaultRoot, config.ingest.feedFolder || "ingest");
      ensureDir(ingest);
      const target = path.join(ingest, `${safeName(body.url || "url-capture")}-${Date.now()}.md`);
      fs.writeFileSync(target, `# URL Capture\n\nSource URL: ${body.url}\n\nNeeds verification\n`, "utf8");
      const job = enqueueFile(config, target);
      runQueue().catch((error) => log("run failed", { error: error.message }));
      return sendJson(res, { ok: true, queued: true, job });
    }
    if (req.method === "POST" && url === "/api/run") {
      await runQueue();
      return sendJson(res, { ok: true, status });
    }
    if (req.method === "POST" && url === "/api/run-vault-pipeline") {
      const findings = runMaintenance(config);
      return sendJson(res, { ok: true, findings, finishedAt: new Date().toISOString() });
    }
    if (req.method === "POST" && url === "/api/design-vault") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      return sendJson(res, { ok: true, architecture: defaultArchitecturePlan(body.requirements || "", body.language || "zh-CN") });
    }
    if (req.method === "POST" && url === "/api/setup-vault") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!body.vaultRoot) return sendJson(res, { ok: false, error: "vaultRoot is required" }, 400);
      return sendJson(res, { ok: true, ...initializeVault(body.vaultRoot, body.architecture) });
    }
    if (req.method === "POST" && url === "/api/ask") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const sources = collectSearchContext(config, body.question);
      const modelConfig = resolveModelConfig(config);
      if (!sources.length) return sendJson(res, { answer: "没有在当前 wiki 中找到足够相关的笔记。", sources: [], question: body.question });
      if (!modelConfig.baseUrl || !modelConfig.model) {
        return sendJson(res, {
          answer: `找到 ${sources.length} 条相关笔记，但当前未配置可用 LLM。请先阅读下方 sources。`,
          sources: sources.map(({ path }) => ({ path })),
          question: body.question
        });
      }
      const context = sources.map((item) => `Source: ${item.path}\n${item.text}`).join("\n\n---\n\n");
      const answer = await callModel(modelConfig, [
        "请基于给定 Obsidian 笔记上下文回答问题。正文用中文，避免编造。若证据不足，请明确说明。",
        "",
        `Question: ${body.question}`,
        "",
        "Context:",
        context
      ].join("\n"));
      return sendJson(res, { answer, sources: sources.map(({ path }) => ({ path })), question: body.question });
    }
    return serveStatic(req, res);
  } catch (error) {
    log("request failed", { url, error: error.message });
    return sendJson(res, { ok: false, error: error.message }, 500);
  }
}

function startAgentServer() {
  if (server) return server;
  const config = loadConfig();
  ensureDir(STATE_DIR);
  ensureDir(LOG_DIR);
  server = http.createServer((req, res) => handleRequest(req, res));
  server.listen(config.port, config.host, () => log("node agent server started", { url: `http://${config.host}:${config.port}` }));
  collectCandidates(config);
  return server;
}

function stopAgentServer() {
  if (server) server.close();
  server = null;
}

if (require.main === module) startAgentServer();

module.exports = { startAgentServer, stopAgentServer };
