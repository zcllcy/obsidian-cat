const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const AGENT_URL = "http://127.0.0.1:4317";

let mainWindow;
let tray;
let agentProcess;
let isQuitting = false;

function resolvePythonCommand() {
  const candidates = [
    process.env.WIKI_CAT_PYTHON,
    process.env.CAT_VAULT_PYTHON,
    "python"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "python" || fs.existsSync(candidate)) return candidate;
  }
  return "python";
}

async function isAgentOnline() {
  try {
    const response = await fetch(`${AGENT_URL}/api/status`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForAgentOnline(maxAttempts = 20) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await isAgentOnline()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function getVaultStatus() {
  try {
    const response = await fetch(`${AGENT_URL}/api/vault-status`);
    if (!response.ok) return { ready: false };
    return await response.json();
  } catch {
    return { ready: false };
  }
}

async function chooseKnowledgeVault() {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: "Choose or create a knowledge vault folder",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths.length) {
    await shell.openExternal(`${AGENT_URL}/#onboarding`);
    return false;
  }
  const vaultRoot = result.filePaths[0];
  await fetch(`${AGENT_URL}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ vaultRoot })
  });
  await shell.openExternal(`${AGENT_URL}/#onboarding`);
  return true;
}

function trayIcon() {
  const iconPath = path.join(ROOT, "assets", "wiki-cat.ico");
  if (fs.existsSync(iconPath)) return iconPath;
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfUlEQVR4AWNABf///z8DJYCJgUIwCkbBqBgFo2BUDKkGkJmZ+f8/AwPDf2QxAwPD/7E0iBqgGQwMDAyMjIx/QGQGEwMDA/8BCRgYGBgY/kcUMjAw/IfqEwMDw38GBgb+QxRkYGBg+I8qNjY2/oMoGBgY/wcAbX4YOnZLwj8AAAAASUVORK5CYII="
  );
}

async function startAgent() {
  if (agentProcess) return;
  if (await isAgentOnline()) return;
  agentProcess = spawn(resolvePythonCommand(), ["src/agent.py"], {
    cwd: ROOT,
    windowsHide: true,
    stdio: "ignore"
  });
  agentProcess.on("exit", () => {
    agentProcess = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 180,
    height: 170,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(ROOT, "public", "pet.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("Wiki Cat");
  updateTrayMenu();
}

function updateTrayMenu() {
  const login = app.getLoginItemSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Cat", click: () => mainWindow?.show() },
      { label: "Hide Cat", click: () => mainWindow?.hide() },
      { label: "Open Home", click: () => shell.openExternal(AGENT_URL) },
      { label: "Open Settings", click: () => shell.openExternal(`${AGENT_URL}/#settings`) },
      { label: "Choose Knowledge Vault...", click: () => chooseKnowledgeVault() },
      { label: "Run Queue Now", click: () => fetch(`${AGENT_URL}/api/run`, { method: "POST" }) },
      {
        label: "Feed Files...",
        click: async () => {
          const result = await dialog.showOpenDialog(mainWindow, {
            properties: ["openFile", "multiSelections"],
            filters: [{ name: "Research files", extensions: ["pdf", "md", "txt"] }]
          });
          if (result.canceled) return;
          for (const filePath of result.filePaths) {
            await fetch(`${AGENT_URL}/api/feed-path`, {
              method: "POST",
              headers: { "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ path: filePath })
            });
          }
        }
      },
      {
        label: "Start On Login",
        type: "checkbox",
        checked: login.openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            path: process.execPath
          });
          updateTrayMenu();
        }
      },
      { type: "separator" },
      { label: "Quit", click: () => { isQuitting = true; app.quit(); } }
    ])
  );
}

ipcMain.handle("feed-files", async (_event, filePaths) => {
  const results = [];
  for (const filePath of filePaths) {
    const response = await fetch(`${AGENT_URL}/api/feed-path`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ path: filePath })
    });
    results.push(await response.json());
  }
  return results;
});

ipcMain.handle("feed-url", async (_event, url) => {
  const response = await fetch(`${AGENT_URL}/api/feed-url`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ url })
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return await response.json();
});

ipcMain.handle("feed-text", async (_event, payload) => {
  const response = await fetch(`${AGENT_URL}/api/feed-text`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return await response.json();
});

ipcMain.handle("open-console", () => shell.openExternal(AGENT_URL));

app.whenReady().then(async () => {
  await startAgent();
  await waitForAgentOnline();
  createWindow();
  createTray();
  getVaultStatus().then((status) => {
    if (!status.ready) shell.openExternal(`${AGENT_URL}/#onboarding`);
  });
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
  if (!isQuitting) mainWindow?.hide();
});

app.on("before-quit", () => {
  if (agentProcess) agentProcess.kill();
});
