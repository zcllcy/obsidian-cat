const fields = {
  mood: document.querySelector("#mood"),
  processed: document.querySelector("#processed"),
  pending: document.querySelector("#pending"),
  queueMirror: document.querySelector("#queueMirror"),
  mode: document.querySelector("#mode"),
  message: document.querySelector("#message"),
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
  askForm: document.querySelector("#askForm"),
  question: document.querySelector("#question"),
  answer: document.querySelector("#answer"),
  quickDock: document.querySelector("#quickDock"),
  dockToggle: document.querySelector("#dockToggle"),
  dockRunNow: document.querySelector("#dockRunNow")
};

const text = {
  live: "Live",
  dry: "Dry run",
  idle: "Idle",
  running: "Running...",
  runNow: "Run queue",
  feeding: "Queued",
  feedFailed: "Feed failed. Check logs/agent.log.",
  saved: "Settings saved.",
  setupDone: "Wiki created.",
  setupFailed: "Wiki setup failed.",
  badJson: "Fix the architecture JSON before creating the wiki."
};

function switchView(name) {
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${name}`);
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === name);
  });
  if (fields.quickDock) fields.quickDock.classList.remove("open");
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

document.querySelectorAll("[data-view-jump]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.viewJump));
});

function showMessage(value) {
  if (fields.message) fields.message.textContent = value;
}

async function refresh() {
  const response = await fetch("/api/status");
  const status = await response.json();
  fields.processed.textContent = status.processedThisSession ?? 0;
  fields.pending.textContent = status.queueLength ?? status.pending ?? 0;
  if (fields.queueMirror) fields.queueMirror.textContent = status.queueLength ?? status.pending ?? 0;
  fields.mode.textContent = status.dryRun ? text.dry : text.live;
  showMessage(status.lastMessage || text.idle);
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  fields.vaultRoot.value = config.vaultRoot || "";
  if (fields.setupVaultRoot) fields.setupVaultRoot.value = config.vaultRoot || "";
  fields.externalConfig.value = config.model?.externalConfig || "";
  fields.mineruApiFile.value = config.parser?.mineru?.apiFile || "";
  fields.mineruLanguage.value = config.parser?.mineru?.language || "en";
  fields.outputLanguage.value = config.output?.language || "en-US";
  fields.setupLanguage.value = config.output?.language || "en-US";
  fields.analysisPrompt.value = config.output?.analysisPrompt || "";
  fields.intervalSeconds.value = config.intervalSeconds || 300;
  fields.dryRun.checked = Boolean(config.dryRun);
}

async function loadVaultStatus() {
  const response = await fetch("/api/vault-status");
  const status = await response.json();
  const hashView = { "#onboarding": "setup", "#setup": "setup", "#feed": "feed", "#ask": "ask", "#settings": "settings" }[window.location.hash];
  if (hashView) switchView(hashView);
  if (!status.ready) switchView("setup");
}

fields.runNow.addEventListener("click", async () => {
  fields.runNow.disabled = true;
  fields.runNow.textContent = text.running;
  try {
    await fetch("/api/run", { method: "POST" });
    await refresh();
  } finally {
    fields.runNow.disabled = false;
    fields.runNow.textContent = text.runNow;
  }
});

fields.dockToggle?.addEventListener("click", () => {
  const open = fields.quickDock.classList.toggle("open");
  fields.dockToggle.setAttribute("aria-expanded", String(open));
});

fields.dockRunNow?.addEventListener("click", () => fields.runNow.click());

fields.designVault?.addEventListener("click", async () => {
  fields.designVault.disabled = true;
  fields.designVault.textContent = "Generating...";
  fields.architectureDraft.value = "Asking the model to design your wiki architecture...";
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
    fields.designVault.textContent = "Generate architecture";
  }
});

fields.onboardingForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  let architecture = null;
  if (fields.architectureDraft.value.trim()) {
    try {
      architecture = JSON.parse(fields.architectureDraft.value);
    } catch {
      showMessage(text.badJson);
      return;
    }
  }
  fields.createVault.disabled = true;
  fields.createVault.textContent = "Creating...";
  try {
    const response = await fetch("/api/setup-vault", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ vaultRoot: fields.setupVaultRoot.value, architecture })
    });
    if (!response.ok) throw new Error(await response.text());
    showMessage(text.setupDone);
    await loadConfig();
    await refresh();
  } catch {
    showMessage(text.setupFailed);
  } finally {
    fields.createVault.disabled = false;
    fields.createVault.textContent = "Create wiki";
  }
});

async function feedFiles(files) {
  if (!files.length) return;
  showMessage(`${text.feeding}: ${files.length}`);
  const body = new FormData();
  for (const file of files) body.append("files", file, file.name);
  const response = await fetch("/api/feed-upload", { method: "POST", body });
  if (!response.ok) {
    showMessage(text.feedFailed);
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
      model: { externalConfig: fields.externalConfig.value },
      output: { language: fields.outputLanguage.value, analysisPrompt: fields.analysisPrompt.value },
      parser: { mineru: { apiFile: fields.mineruApiFile.value, language: fields.mineruLanguage.value } }
    })
  });
  showMessage(text.saved);
  await refresh();
});

fields.askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = fields.question.value.trim();
  if (!question) return;
  fields.answer.textContent = "Searching the wiki...";
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ question })
  });
  if (!response.ok) {
    fields.answer.textContent = "Ask failed. Check logs/agent.log.";
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
