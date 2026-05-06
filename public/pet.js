const fields = {
  mood: document.querySelector("#mood"),
  lastRun: document.querySelector("#lastRun"),
  processed: document.querySelector("#processed"),
  pending: document.querySelector("#pending"),
  queueMirror: document.querySelector("#queueMirror"),
  mode: document.querySelector("#mode"),
  message: document.querySelector("#message"),
  pipelineStatus: document.querySelector("#pipelineStatus"),
  runVaultPipeline: document.querySelector("#runVaultPipeline"),
  settingsRunVaultPipeline: document.querySelector("#settingsRunVaultPipeline"),
  runNow: document.querySelector("#runNow"),
  dropZone: document.querySelector("#dropZone"),
  fileInput: document.querySelector("#fileInput"),
  settingsForm: document.querySelector("#settingsForm"),
  onboardingForm: document.querySelector("#onboardingForm"),
  setupVaultRoot: document.querySelector("#setupVaultRoot"),
  setupLanguage: document.querySelector("#setupLanguage"),
  setupRequirements: document.querySelector("#setupRequirements"),
  architectureDraft: document.querySelector("#architectureDraft"),
  designVault: document.querySelector("#designVault"),
  createVault: document.querySelector("#createVault"),
  vaultRoot: document.querySelector("#vaultRoot"),
  externalConfig: document.querySelector("#externalConfig"),
  outputLanguage: document.querySelector("#outputLanguage"),
  analysisPrompt: document.querySelector("#analysisPrompt"),
  mineruApiFile: document.querySelector("#mineruApiFile"),
  mineruLanguage: document.querySelector("#mineruLanguage"),
  intervalSeconds: document.querySelector("#intervalSeconds"),
  dryRun: document.querySelector("#dryRun"),
  providerName: document.querySelector("#providerName"),
  baseUrl: document.querySelector("#baseUrl"),
  modelName: document.querySelector("#modelName"),
  apiKeyEnv: document.querySelector("#apiKeyEnv"),
  apiKey: document.querySelector("#apiKey"),
  temperature: document.querySelector("#temperature"),
  maxTokens: document.querySelector("#maxTokens"),
  timeoutSeconds: document.querySelector("#timeoutSeconds"),
  enableThinking: document.querySelector("#enableThinking"),
  autoRunMaintenance: document.querySelector("#autoRunMaintenance"),
  askForm: document.querySelector("#askForm"),
  question: document.querySelector("#question"),
  answer: document.querySelector("#answer"),
  quickDock: document.querySelector("#quickDock"),
  dockToggle: document.querySelector("#dockToggle"),
  dockRunNow: document.querySelector("#dockRunNow")
};

const t = {
  live: "\u5b9e\u65f6",
  dry: "\u6f14\u7ec3",
  idle: "\u5f85\u547d",
  checking: "\u6b63\u5728\u770b\u77e5\u8bc6\u5e93",
  hasIssue: "\u6709\u4efb\u52a1\u9700\u8981\u68c0\u67e5",
  running: "\u6574\u7406\u4e2d",
  pipelineRunning: "\u7ef4\u62a4\u4e2d",
  pipelineRun: "\u8fd0\u884c\u77e5\u8bc6\u5e93\u7ef4\u62a4",
  pipelineConfirm: "\u786e\u5b9a\u8981\u8fd0\u884c\u77e5\u8bc6\u5e93 pipeline \u5417\uff1f\u8fd9\u4f1a\u6807\u51c6\u5316 source notes\uff0c\u8fd0\u884c\u4e8c\u6b21\u84b8\u998f\uff0c\u5e76\u66f4\u65b0\u5ba1\u8ba1\u62a5\u544a\u3002",
  pipelineDone: "\u77e5\u8bc6\u5e93\u7ef4\u62a4\u5b8c\u6210",
  pipelineFailed: "\u77e5\u8bc6\u5e93\u7ef4\u62a4\u5931\u8d25\uff0c\u8bf7\u770b logs/agent.log",
  runNow: "\u7acb\u5373\u6574\u7406",
  feeding: "\u6b63\u5728\u6d88\u5316",
  feedFailed: "\u6295\u5582\u5931\u8d25\uff0c\u8bf7\u770b logs/agent.log",
  saved: "\u8bbe\u7f6e\u5df2\u4fdd\u5b58"
};

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

async function refresh() {
  const response = await fetch("/api/status");
  const status = await response.json();
  fields.lastRun.textContent = formatTime(status.lastRunAt);
  fields.processed.textContent = status.processedThisSession;
  fields.pending.textContent = status.queueLength ?? status.pending;
  if (fields.queueMirror) fields.queueMirror.textContent = status.queueLength ?? status.pending ?? 0;
  fields.mode.textContent = status.dryRun ? t.dry : t.live;
  fields.message.textContent = status.lastMessage || t.idle;
  fields.mood.textContent = status.errors?.length ? t.hasIssue : t.checking;
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  fields.vaultRoot.value = config.vaultRoot || "";
  if (fields.setupVaultRoot) fields.setupVaultRoot.value = config.vaultRoot || "";
  fields.externalConfig.value = config.model?.externalConfig || "";
  fields.providerName.value = config.model?.providerName || "openai-compatible";
  fields.baseUrl.value = config.model?.baseUrl || "";
  fields.modelName.value = config.model?.model || "";
  fields.apiKeyEnv.value = config.model?.apiKeyEnv || "";
  fields.apiKey.value = config.model?.apiKey || "";
  fields.temperature.value = config.model?.temperature ?? 0.2;
  fields.maxTokens.value = config.model?.maxTokens ?? 1800;
  fields.timeoutSeconds.value = config.model?.timeoutSeconds ?? 120;
  fields.enableThinking.checked = Boolean(config.model?.enableThinking);
  fields.mineruApiFile.value = config.parser?.mineru?.apiFile || "";
  fields.mineruLanguage.value = config.parser?.mineru?.language || "ch";
  if (fields.outputLanguage) fields.outputLanguage.value = config.output?.language || "zh-CN";
  if (fields.setupLanguage) fields.setupLanguage.value = config.output?.language || "zh-CN";
  if (fields.analysisPrompt) fields.analysisPrompt.value = config.output?.analysisPrompt || "";
  fields.intervalSeconds.value = config.intervalSeconds || 300;
  fields.dryRun.checked = Boolean(config.dryRun);
  fields.autoRunMaintenance.checked = config.maintenance?.autoRunAfterQueue !== false;
}

async function loadVaultStatus() {
  const response = await fetch("/api/vault-status");
  const status = await response.json();
  if (!status.ready || window.location.hash === "#onboarding") {
    document.querySelector("#onboarding")?.scrollIntoView();
  }
}

fields.runNow.addEventListener("click", async () => {
  fields.runNow.disabled = true;
  fields.runNow.textContent = t.running;
  try {
    await fetch("/api/run", { method: "POST" });
    await refresh();
  } finally {
    fields.runNow.disabled = false;
    fields.runNow.textContent = t.runNow;
  }
});

async function runVaultPipeline(button) {
  if (!window.confirm(t.pipelineConfirm)) return;
  const buttons = [fields.runVaultPipeline, fields.settingsRunVaultPipeline].filter(Boolean);
  buttons.forEach((item) => {
    item.disabled = true;
    item.textContent = t.pipelineRunning;
  });
  if (fields.pipelineStatus) fields.pipelineStatus.textContent = "\u6b63\u5728\u8fd0\u884c tools/run_pipeline.py...";
  try {
    const response = await fetch("/api/run-vault-pipeline", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ confirm: true })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || data.stderr || "pipeline failed");
    fields.message.textContent = t.pipelineDone;
    if (fields.pipelineStatus) fields.pipelineStatus.textContent = `${t.pipelineDone}\uff1a${data.finishedAt || ""}`;
    await refresh();
  } catch (error) {
    fields.message.textContent = t.pipelineFailed;
    if (fields.pipelineStatus) fields.pipelineStatus.textContent = error.message || t.pipelineFailed;
  } finally {
    buttons.forEach((item) => {
      item.disabled = false;
      item.textContent = item === fields.settingsRunVaultPipeline ? "\u786e\u8ba4\u540e\u8fd0\u884c" : t.pipelineRun;
    });
  }
}

fields.runVaultPipeline?.addEventListener("click", () => runVaultPipeline(fields.runVaultPipeline));
fields.settingsRunVaultPipeline?.addEventListener("click", () => runVaultPipeline(fields.settingsRunVaultPipeline));

if (fields.dockToggle && fields.quickDock) {
  fields.dockToggle.addEventListener("click", () => {
    const open = fields.quickDock.classList.toggle("open");
    fields.dockToggle.setAttribute("aria-expanded", String(open));
  });
}

if (fields.dockRunNow) {
  fields.dockRunNow.addEventListener("click", () => fields.runNow.click());
}

fields.designVault?.addEventListener("click", async () => {
  fields.designVault.disabled = true;
  fields.designVault.textContent = "\u751f\u6210\u4e2d";
  fields.architectureDraft.value = "\u6b63\u5728\u8bf7\u5927\u6a21\u578b\u8bbe\u8ba1\u77e5\u8bc6\u5e93\u67b6\u6784...";
  try {
    const response = await fetch("/api/design-vault", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        requirements: fields.setupRequirements.value,
        language: fields.setupLanguage.value
      })
    });
    const data = await response.json();
    fields.architectureDraft.value = JSON.stringify(data.architecture, null, 2);
  } finally {
    fields.designVault.disabled = false;
    fields.designVault.textContent = "\u751f\u6210\u67b6\u6784\u8349\u6848";
  }
});

fields.onboardingForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  let architecture = null;
  if (fields.architectureDraft.value.trim()) {
    try {
      architecture = JSON.parse(fields.architectureDraft.value);
    } catch {
      fields.message.textContent = "\u67b6\u6784\u8349\u6848 JSON \u683c\u5f0f\u9700\u8981\u5148\u4fee\u6b63";
      return;
    }
  }
  fields.createVault.disabled = true;
  fields.createVault.textContent = "\u521b\u5efa\u4e2d";
  try {
    const response = await fetch("/api/setup-vault", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        vaultRoot: fields.setupVaultRoot.value,
        architecture
      })
    });
    if (!response.ok) throw new Error(await response.text());
    fields.message.textContent = "\u77e5\u8bc6\u5e93\u5df2\u5efa\u7acb";
    await loadConfig();
    await refresh();
  } catch {
    fields.message.textContent = "\u77e5\u8bc6\u5e93\u521d\u59cb\u5316\u5931\u8d25";
  } finally {
    fields.createVault.disabled = false;
    fields.createVault.textContent = "\u786e\u8ba4\u5e76\u521b\u5efa";
  }
});

async function feedFiles(files) {
  if (!files.length) return;
  fields.message.textContent = `${t.feeding} ${files.length}`;
  const body = new FormData();
  for (const file of files) body.append("files", file, file.name);
  const response = await fetch("/api/feed-upload", { method: "POST", body });
  if (!response.ok) {
    fields.message.textContent = t.feedFailed;
    return;
  }
  await refresh();
}

fields.fileInput.addEventListener("change", () => {
  feedFiles([...fields.fileInput.files]);
  fields.fileInput.value = "";
});

for (const eventName of ["dragenter", "dragover"]) {
  fields.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    fields.dropZone.classList.add("dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  fields.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    fields.dropZone.classList.remove("dragging");
  });
}

fields.dropZone.addEventListener("drop", (event) => {
  feedFiles([...event.dataTransfer.files]);
});

fields.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      vaultRoot: fields.vaultRoot.value,
      intervalSeconds: Number(fields.intervalSeconds.value || 300),
      dryRun: fields.dryRun.checked,
      maintenance: { autoRunAfterQueue: fields.autoRunMaintenance.checked },
      model: {
        externalConfig: fields.externalConfig.value,
        providerName: fields.providerName.value,
        baseUrl: fields.baseUrl.value,
        model: fields.modelName.value,
        apiKeyEnv: fields.apiKeyEnv.value,
        apiKey: fields.apiKey.value,
        temperature: Number(fields.temperature.value || 0.2),
        maxTokens: Number(fields.maxTokens.value || 1800),
        timeoutSeconds: Number(fields.timeoutSeconds.value || 120),
        enableThinking: fields.enableThinking.checked
      },
      output: { language: fields.outputLanguage.value, analysisPrompt: fields.analysisPrompt.value },
      parser: { mineru: { apiFile: fields.mineruApiFile.value, language: fields.mineruLanguage.value } }
    })
  });
  fields.message.textContent = t.saved;
  await refresh();
});

fields.askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = fields.question.value.trim();
  if (!question) return;
  fields.answer.textContent = "\u6b63\u5728\u68c0\u7d22\u77e5\u8bc6\u5e93...";
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ question })
  });
  if (!response.ok) {
    fields.answer.textContent = "\u95ee\u7b54\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u5fd7\u3002";
    return;
  }
  const data = await response.json();
  const sources = (data.sources || []).map((item) => `- ${item.path}`).join("\n");
  fields.answer.textContent = `${data.answer}\n\nSources:\n${sources}`;
});

refresh();
loadConfig();
loadVaultStatus();
setInterval(refresh, 5000);
