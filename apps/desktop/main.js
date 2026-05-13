const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startAgentServer, stopAgentServer } = require("../../src/node_agent");

const ROOT = path.resolve(__dirname, "../..");
const AGENT_URL = "http://127.0.0.1:4317";

let mainWindow;
let tray;
let isQuitting = false;
let topmostTimer;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });
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
    return false;
  }
  const vaultRoot = result.filePaths[0];
  await fetch(`${AGENT_URL}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ vaultRoot })
  });
  return true;
}

function trayIcon() {
  const iconPath = path.join(ROOT, "apps", "desktop", "tray.ico");
  if (fs.existsSync(iconPath)) return iconPath;
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfUlEQVR4AWNABf///z8DJYCJgUIwCkbBqBgFo2BUDKkGkJmZ+f8/AwPDf2QxAwPD/7E0iBqgGQwMDAyMjIx/QGQGEwMDA/8BCRgYGBgY/kcUMjAw/IfqEwMDw38GBgb+QxRkYGBg+I8qNjY2/oMoGBgY/wcAbX4YOnZLwj8AAAAASUVORK5CYII="
  );
}

async function startAgent() {
  if (await isAgentOnline()) return;
  startAgentServer();
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

  const enforceAlwaysOnTop = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  };

  mainWindow.loadFile(path.join(ROOT, "public", "pet.html"));
  mainWindow.once("ready-to-show", () => {
    enforceAlwaysOnTop();
    mainWindow.show();
  });
  mainWindow.on("show", enforceAlwaysOnTop);
  mainWindow.on("focus", enforceAlwaysOnTop);
  mainWindow.on("blur", enforceAlwaysOnTop);
  topmostTimer = setInterval(enforceAlwaysOnTop, 5000);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("Obsidian Cat");
  updateTrayMenu();
}

function updateTrayMenu() {
  const login = app.getLoginItemSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Cat", click: () => mainWindow?.show() },
      { label: "Hide Cat", click: () => mainWindow?.hide() },
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

ipcMain.handle("open-console", () => ({ ok: true, message: "Configure Obsidian Cat from the Obsidian plugin settings page." }));

if (singleInstanceLock) {
  app.whenReady().then(async () => {
    await startAgent();
    await waitForAgentOnline();
    createWindow();
    createTray();
  });
}

app.on("window-all-closed", (event) => {
  event.preventDefault();
  if (!isQuitting) mainWindow?.hide();
});

app.on("before-quit", () => {
  if (topmostTimer) clearInterval(topmostTimer);
  stopAgentServer();
});
