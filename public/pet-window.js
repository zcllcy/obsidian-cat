const pet = document.querySelector("#pet");
const dropZone = document.querySelector("#dropZone");
const statusText = document.querySelector("#statusText");
const queueFill = document.querySelector("#queueFill");

const API = "http://127.0.0.1:4317";

let lastProcessing = false;
let bubbleTimer = null;
let idleBubbleTimer = null;
let lastIdleBubbleAt = 0;
let modelLineInFlight = false;

const text = {
  idle: "\u62d6\u6587\u732e\u7ed9\u6211",
  backend: "\u540e\u53f0\u9192\u6765\u4e2d",
  drop: "\u653e\u8fd9\u91cc",
  queued: "\u5df2\u5165\u961f",
  processing: "\u6d88\u5316\u4e2d",
  done: "\u5403\u5b8c\u5566\uff0c\u5df2\u5165\u5e93",
  failed: "\u6709\u6587\u4ef6\u6d88\u5316\u5931\u8d25",
  feedFailed: "\u6295\u5582\u5931\u8d25",
  urlQueued: "\u7f51\u9875\u5df2\u5165\u961f",
  urlFailed: "\u7f51\u9875\u6293\u53d6\u5931\u8d25",
  textQueued: "\u6587\u672c\u5df2\u5165\u961f",
  textFailed: "\u6587\u672c\u5165\u5e93\u5931\u8d25",
  queue: "\u961f\u5217"
};

const idleLines = [
  "\u6211\u5728\u5de1\u903b\u77e5\u8bc6\u5e93",
  "\u6709\u65b0\u6587\u732e\u5c31\u62d6\u7ed9\u6211",
  "\u4eca\u5929\u4e5f\u8981\u628a\u94fe\u63a5\u7406\u987a",
  "\u6211\u4f1a\u7b49\u961f\u5217\u7a7a\u4e86\u518d\u6574\u7406"
];

function showBubble(message, duration = 3600) {
  if (!message) return;
  window.clearTimeout(bubbleTimer);
  statusText.textContent = message;
  statusText.classList.add("visible");
  bubbleTimer = window.setTimeout(() => {
    statusText.classList.remove("visible");
  }, duration);
}

function say(message, options = {}) {
  showBubble(message, options.duration ?? 3600);
}

function scheduleIdleBubble() {
  window.clearTimeout(idleBubbleTimer);
  idleBubbleTimer = window.setTimeout(async () => {
    const now = Date.now();
    if (now - lastIdleBubbleAt > 12000) {
      lastIdleBubbleAt = now;
      showBubble(await randomIdleLine(), 3200);
    }
    scheduleIdleBubble();
  }, 9000 + Math.random() * 14000);
}

async function randomIdleLine() {
  if (modelLineInFlight || Math.random() >= 0.01) {
    return idleLines[Math.floor(Math.random() * idleLines.length)];
  }
  modelLineInFlight = true;
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`${API}/api/pet-line`, { signal: controller.signal });
    window.clearTimeout(timeout);
    const data = await response.json();
    return data.line || idleLines[Math.floor(Math.random() * idleLines.length)];
  } catch {
    return idleLines[Math.floor(Math.random() * idleLines.length)];
  } finally {
    modelLineInFlight = false;
  }
}

function shortName(value, max = 18) {
  if (!value || value.length <= max) return value || "";
  const dot = value.lastIndexOf(".");
  const ext = dot > 0 ? value.slice(dot) : "";
  const base = ext ? value.slice(0, dot) : value;
  return `${base.slice(0, Math.max(6, max - ext.length - 1))}\u2026${ext}`;
}

function progressFor(status) {
  if (status.processing) return 72;
  if (status.queueLength > 0) return Math.min(64, 18 + status.queueLength * 10);
  if (status.errors?.length) return 100;
  return 0;
}

function extractUrl(event) {
  const values = [
    event.dataTransfer.getData("text/uri-list"),
    event.dataTransfer.getData("text/plain"),
    event.dataTransfer.getData("text/html")
  ].filter(Boolean);
  for (const value of values) {
    const match = value.match(/https?:\/\/[^\s"'<>]+/i);
    if (match) return match[0].replace(/[),.;\]]+$/, "");
  }
  return "";
}

function draggedText(event) {
  return (
    event.dataTransfer.getData("text/plain") ||
    event.dataTransfer.getData("text/html") ||
    ""
  ).trim();
}

function isSingleUrl(value) {
  return /^https?:\/\/[^\s"'<>]+$/i.test(value.trim());
}

async function refresh() {
  try {
    const response = await fetch(`${API}/api/status`);
    const status = await response.json();
    pet.classList.toggle("working", Boolean(status.processing));
    queueFill.style.width = `${progressFor(status)}%`;

    if (status.processing) {
      const file = status.activeFile ? shortName(status.activeFile.split(/[\\/]/).pop()) : "";
      say(`${text.processing}${file ? `: ${file}` : ""}`, { duration: 4200 });
      lastProcessing = true;
      return;
    }
    if (lastProcessing) {
      say(text.done, { duration: 4600 });
      queueFill.style.width = "100%";
      lastProcessing = false;
      setTimeout(refresh, 2500);
      return;
    }
    if (status.queueLength > 0) {
      say(`${text.queue}: ${status.queueLength}`, { duration: 3600 });
    } else if (status.errors?.length) {
      say(text.failed, { duration: 5200 });
    }
  } catch {
    say(text.backend, { duration: 4200 });
    queueFill.style.width = "12%";
  }
}

async function feed(files) {
  if (!files.length) return;
  say(`${text.queued}: ${files.length}`);
  queueFill.style.width = "36%";
  try {
    await window.catVaultAgent.feedFiles(files);
    await refresh();
  } catch {
    say(text.feedFailed);
    queueFill.style.width = "100%";
  }
}

async function feedUrl(url) {
  if (!url) return;
  say(text.urlQueued);
  queueFill.style.width = "36%";
  try {
    await window.catVaultAgent.feedUrl(url);
    await refresh();
  } catch {
    say(text.urlFailed);
    queueFill.style.width = "100%";
  }
}

async function feedText(value) {
  const content = value.trim();
  if (!content) return;
  say(text.textQueued);
  queueFill.style.width = "36%";
  try {
    await window.catVaultAgent.feedText(content, "desktop-drag");
    await refresh();
  } catch {
    say(text.textFailed);
    queueFill.style.width = "100%";
  }
}

for (const name of ["dragenter", "dragover"]) {
  dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
    say(text.drop);
    queueFill.style.width = "48%";
  });
}

for (const name of ["dragleave", "drop"]) {
  dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}

dropZone.addEventListener("drop", (event) => {
  const files = [...event.dataTransfer.files];
  if (files.length) {
    feed(files);
    return;
  }
  const value = draggedText(event);
  if (value && !isSingleUrl(value)) {
    feedText(value);
    return;
  }
  feedUrl(extractUrl(event));
});

refresh();
scheduleIdleBubble();
setInterval(refresh, 3000);
