const pet = document.querySelector("#pet");
const dropZone = document.querySelector("#dropZone");
const statusText = document.querySelector("#statusText");
const queueFill = document.querySelector("#queueFill");

const API = "http://127.0.0.1:4317";

let lastProcessing = false;

const text = {
  idle: "Feed me sources",
  backend: "Waking backend...",
  drop: "Drop here",
  queued: "Queued",
  processing: "Curating",
  done: "Saved to wiki",
  failed: "Source failed",
  feedFailed: "Feed failed",
  urlQueued: "Link queued",
  urlFailed: "Link failed",
  textQueued: "Text queued",
  textFailed: "Text failed",
  queue: "Queue"
};

function say(message) {
  statusText.textContent = message;
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
      say(`${text.processing}${file ? `: ${file}` : ""}`);
      lastProcessing = true;
      return;
    }
    if (lastProcessing) {
      say(text.done);
      queueFill.style.width = "100%";
      lastProcessing = false;
      setTimeout(refresh, 2500);
      return;
    }
    if (status.queueLength > 0) {
      say(`${text.queue}: ${status.queueLength}`);
    } else if (status.errors?.length) {
      say(text.failed);
    } else {
      say(text.idle);
    }
  } catch {
    say(text.backend);
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
setInterval(refresh, 3000);
