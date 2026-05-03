from __future__ import annotations

import hashlib
import http.server
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import socketserver
import threading
import time
import urllib.error
import urllib.request
import urllib.parse

from mineru_adapter import parse_pdf_with_mineru


PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / "config" / "agent.config.json"
EXAMPLE_CONFIG_PATH = PROJECT_ROOT / "config" / "agent.config.example.json"
STATE_PATH = PROJECT_ROOT / "state" / "processed.json"
JOBS_PATH = PROJECT_ROOT / "state" / "jobs.json"
LOG_PATH = PROJECT_ROOT / "logs" / "agent.log"
PUBLIC_DIR = PROJECT_ROOT / "public"
RUN_LOCK = threading.Lock()
RUN_EVENT = threading.Event()
RUN_THREAD_LOCK = threading.Lock()
RUN_THREAD: threading.Thread | None = None

STATUS = {
    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "lastRunAt": None,
    "lastMessage": "starting",
    "processedThisSession": 0,
    "pending": 0,
    "queueLength": 0,
    "processing": False,
    "activeFile": None,
    "lastProcessed": None,
    "dryRun": True,
    "petMood": "curious",
    "errors": [],
}


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_raw_config() -> dict:
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    return read_json(CONFIG_PATH)


def save_raw_config(config: dict) -> None:
    write_json(CONFIG_PATH, config)


def write_if_missing(path: Path, content: str) -> None:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.strip() + "\n", encoding="utf-8")


def safe_folder(folder: str) -> str | None:
    clean = folder.strip().strip("/\\")
    if not clean or clean.startswith("."):
        return clean if clean == ".obsidian" else None
    if ".." in Path(clean).parts:
        return None
    for char in '<>:"|?*':
        clean = clean.replace(char, " ")
    clean = "/".join(" ".join(part.split()) for part in clean.replace("\\", "/").split("/") if part.strip())
    return clean or None


def default_architecture_plan(requirements: str = "", language: str = "en-US") -> dict:
    focus = requirements.strip() or "research papers, notes, web clippings, concepts, methods, evidence, and open questions"
    return {
        "language": language or "en-US",
        "summary": f"An Obsidian wiki maintained by Wiki Cat for {focus}.",
        "folders": [
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
            "templates",
        ],
        "home": [
            "# Home",
            "",
            "## Navigation",
            "- [[wiki/Literature Index]]",
            "- [[wiki/Map of Contents]]",
            "- [[wiki/questions/Open Questions]]",
            "",
            "## Current Focus",
            f"- {focus}",
        ],
        "mapOfContents": [
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
            "- [[wiki/syntheses/Research Map]]",
        ],
        "analysisPrompt": (
            "Default to English. For each source, detect the source type, keep citation or URL metadata, "
            "extract the research problem, methods, systems, claims, evidence, figures, limitations, reusable "
            "concepts, entities, and open questions. Preserve source paths for every non-obvious claim."
        ),
    }


def normalize_architecture_plan(plan: dict | None, requirements: str = "", language: str = "en-US") -> dict:
    base = default_architecture_plan(requirements, language)
    if not isinstance(plan, dict):
        return base
    merged = {**base, **{key: value for key, value in plan.items() if value}}
    folders = []
    for folder in merged.get("folders", []):
        safe = safe_folder(str(folder))
        if safe and safe not in folders:
            folders.append(safe)
    for folder in base["folders"]:
        if folder not in folders:
            folders.append(folder)
    merged["folders"] = folders
    for key in ["home", "mapOfContents"]:
        value = merged.get(key)
        if isinstance(value, list):
            merged[key] = "\n".join(str(line) for line in value)
        elif not isinstance(value, str):
            merged[key] = "\n".join(base[key])
    merged["analysisPrompt"] = str(merged.get("analysisPrompt") or base["analysisPrompt"]).strip()
    merged["language"] = str(merged.get("language") or language or "en-US")
    merged["summary"] = str(merged.get("summary") or base["summary"]).strip()
    return merged


def initialize_vault(vault_path: str | Path, plan: dict | None = None) -> dict:
    vault = Path(vault_path).resolve()
    architecture = normalize_architecture_plan(plan)
    vault.mkdir(parents=True, exist_ok=True)
    for folder in architecture["folders"]:
        (vault / folder).mkdir(parents=True, exist_ok=True)

    app_json = vault / ".obsidian" / "app.json"
    app_data = {}
    if app_json.exists():
        try:
            app_data = json.loads(app_json.read_text(encoding="utf-8-sig"))
        except Exception:
            app_data = {}
    ignore = set(app_data.get("userIgnoreFilters", []))
    ignore.update(["raw/", "ingest/", "inbox/", "templates/", "RE_MD/", "LLM_API/", "README.md", "AGENTS.md"])
    app_data["userIgnoreFilters"] = sorted(ignore)
    write_json(app_json, app_data)

    write_if_missing(vault / "wiki" / "Home.md", architecture["home"])
    write_if_missing(vault / "wiki" / "Literature Index.md", "# Literature Index\n\nAutomatically updated list of processed literature notes.\n\n## Papers")
    write_if_missing(vault / "wiki" / "Map of Contents.md", architecture["mapOfContents"])
    write_if_missing(vault / "wiki" / "concepts" / "Phonon.md", "# Phonon\n\nA quantized collective vibration of atoms in a lattice.")
    write_if_missing(vault / "wiki" / "concepts" / "Lattice Dynamics.md", "# Lattice Dynamics\n\nStudy of atomic vibrations in solids.")
    write_if_missing(vault / "wiki" / "questions" / "Open Questions.md", "# Open Questions\n\n- ")
    write_if_missing(vault / "wiki" / "syntheses" / "Research Map.md", "# Research Map\n\n## Scope\n\n" + architecture["summary"])
    write_if_missing(vault / "templates" / "Source Note.md", "# {{title}}\n\n## Citation\n\n## Summary")
    write_json(vault / "cat-vault-architecture.json", architecture)

    config = load_raw_config()
    config["vaultRoot"] = str(vault)
    config.setdefault("parser", {}).setdefault("mineru", {})["language"] = config.get("parser", {}).get("mineru", {}).get("language", "ch")
    config.setdefault("output", {})["language"] = architecture["language"]
    config.setdefault("output", {})["analysisPrompt"] = architecture["analysisPrompt"]
    save_raw_config(config)
    return {"ok": True, "vaultRoot": str(vault), "architecture": architecture}


def vault_status(config: dict | None = None) -> dict:
    raw = config or load_raw_config()
    vault = Path(raw.get("vaultRoot", "")).resolve()
    return {
        "vaultRoot": str(vault),
        "exists": vault.exists(),
        "hasObsidian": (vault / ".obsidian").exists(),
        "hasWiki": (vault / "wiki").exists(),
        "ready": vault.exists() and (vault / ".obsidian").exists() and (vault / "wiki").exists(),
    }


def load_jobs() -> dict:
    if not JOBS_PATH.exists():
        return {"jobs": []}
    data = read_json(JOBS_PATH)
    data.setdefault("jobs", [])
    return data


def save_jobs(data: dict) -> None:
    write_json(JOBS_PATH, data)


def log(message: str, **extra: object) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "message": message, **extra}
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    STATUS["lastMessage"] = message


def refresh_queue_status() -> None:
    try:
        config = load_config()
        state = load_state()
        jobs = sync_jobs(config, state).get("jobs", [])
        active = [job for job in jobs if job.get("status") in {"queued", "running"}]
        STATUS["queueLength"] = len(active)
        if not STATUS["processing"]:
            STATUS["pending"] = len(active)
    except Exception as error:
        log("queue refresh failed", error=str(error))


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8"), encoding="utf-8")
        log("created config from example; edit config/agent.config.json before live API calls")
    config = read_json(CONFIG_PATH)
    config["vaultRoot"] = str((PROJECT_ROOT / config.get("vaultRoot", "..")).resolve())
    config = merge_external_model_config(config)
    STATUS["dryRun"] = bool(config.get("dryRun", True))
    STATUS["petMood"] = config.get("pet", {}).get("mood", "curious")
    return config


def merge_external_model_config(config: dict) -> dict:
    model = config.get("model", {})
    external = model.get("externalConfig")
    if not external:
        return config

    external_path = (PROJECT_ROOT / external).resolve()
    if not external_path.exists():
        log("external model config not found", path=str(external_path))
        return config

    data = read_json(external_path)
    base_url = data.get("base_url") or model.get("baseUrl")
    if base_url and not base_url.rstrip("/").endswith("/chat/completions"):
        base_url = base_url.rstrip("/") + "/chat/completions"

    fallback = data.get("model_fallback") or []
    selected_model = fallback[0] if fallback else model.get("model")
    api_key_file = data.get("api_key_file")
    api_key = ""
    if api_key_file:
        key_path = Path(api_key_file)
        if key_path.exists():
            api_key = key_path.read_text(encoding="utf-8").strip()
        else:
            log("external api_key_file not found", path=str(key_path))
    if not api_key:
        api_key = data.get("api_key") or model.get("apiKey", "")

    model.update(
        {
            "baseUrl": base_url,
            "apiKey": api_key,
            "model": selected_model,
            "temperature": model.get("temperature", 0.2),
            "timeoutSeconds": data.get("timeout_s", model.get("timeoutSeconds", 180)),
            "maxRetriesPerModel": data.get("max_retries_per_model", model.get("maxRetriesPerModel", 2)),
            "enableThinking": data.get("enable_thinking", model.get("enableThinking", False)),
        }
    )
    config["model"] = model
    return config


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {"processed": {}}
    return read_json(STATE_PATH)


def is_inside(parent: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def file_hash(path: Path) -> str:
    stat = path.stat()
    value = f"{path}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def note_slug(path: Path) -> str:
    bad = '<>:"/\\|?*'
    name = path.stem
    for char in bad:
        name = name.replace(char, " ")
    name = " ".join(name.split()).strip()
    return (name or f"source-{int(time.time())}")[:120]


def title_slug(title: str) -> str:
    name = title.strip().lstrip("#").strip()
    for char in '<>:"/\\|?*\n\r\t':
        name = name.replace(char, " ")
    name = " ".join(name.split()).strip()
    return (name or f"literature-{int(time.time())}")[:140]


def wikilink_slug(title: str) -> str:
    return title_slug(title)


def extract_section(markdown: str, heading: str) -> str:
    lines = markdown.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip() == f"## {heading}":
            start = index + 1
            break
    if start is None:
        return ""
    out = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        out.append(line)
    return "\n".join(out).strip()


def clean_item(text: str) -> str:
    item = text.strip().strip("-*").strip()
    item = item.split(":")[0].strip() if ":" in item and len(item.split(":")[0]) < 80 else item
    item = item.replace("[[", "").replace("]]", "").strip()
    return item.strip(" .;，。；")


def split_field_items(section: str, field: str) -> list[str]:
    for line in section.splitlines():
        if line.strip().lower().startswith(f"- {field.lower()}:"):
            value = line.split(":", 1)[1]
            raw = value.replace(" and ", ",").replace("；", ",").replace("，", ",").split(",")
            return [clean_item(item) for item in raw if clean_item(item)]
    return []


def bullet_items(section: str, limit: int = 12) -> list[str]:
    items = []
    for line in section.splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            item = clean_item(stripped[2:])
            if item and item.lower() not in {"not found in extracted text", "if relevant"}:
                items.append(item)
        if len(items) >= limit:
            break
    return items


def append_unique(path: Path, text: str) -> None:
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if text.strip() in existing:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(existing.rstrip() + "\n\n" + text.strip() + "\n", encoding="utf-8")


def create_graph_note(vault_root: Path, folder: str, name: str, source_link: str, note_title: str) -> str | None:
    clean = clean_item(name)
    if not clean or len(clean) > 100:
        return None
    rel = f"wiki/{folder}/{wikilink_slug(clean)}"
    path = vault_root / f"{rel}.md"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# {clean}\n\n## Linked Literature\n\n- [[{source_link}|{note_title}]]\n", encoding="utf-8")
    else:
        append_unique(path, f"- [[{source_link}|{note_title}]]")
    return f"[[{rel}|{clean}]]"


def expand_research_graph(config: dict, output_path: Path, markdown: str) -> str:
    vault_root = Path(config["vaultRoot"])
    note_title = markdown_title(markdown, output_path.stem)
    source_link = output_path.relative_to(vault_root).with_suffix("").as_posix()
    classification = extract_section(markdown, "Research Classification")
    reusable = extract_section(markdown, "Reusable Concepts")
    questions = extract_section(markdown, "Follow-Up Questions")

    links: list[str] = []
    for material in split_field_items(classification, "Materials/System")[:10]:
        link = create_graph_note(vault_root, "materials", material, source_link, note_title)
        if link:
            links.append(f"- Material: {link}")
    for method in split_field_items(classification, "Methods")[:10]:
        link = create_graph_note(vault_root, "methods", method, source_link, note_title)
        if link:
            links.append(f"- Method: {link}")
    for concept in bullet_items(reusable, limit=12):
        link = create_graph_note(vault_root, "concepts", concept, source_link, note_title)
        if link:
            links.append(f"- Concept: {link}")

    question_lines = []
    for question in bullet_items(questions, limit=8):
        question_lines.append(f"- {question} ([[{source_link}|{note_title}]])")
    if question_lines:
        append_unique(vault_root / "wiki" / "questions" / "Open Questions.md", "\n".join(question_lines))

    if not links:
        return markdown
    graph_block = "\n\n## Knowledge Graph Links\n\n" + "\n".join(dict.fromkeys(links)) + "\n"
    if "## Knowledge Graph Links" in markdown:
        return markdown
    return markdown.rstrip() + graph_block


def markdown_title(markdown: str, fallback: str) -> str:
    for line in markdown.splitlines():
        if line.startswith("# "):
            return line[2:].strip() or fallback
    return fallback


def unique_note_path(folder: Path, title: str) -> Path:
    base = title_slug(title)
    candidate = folder / f"{base}.md"
    index = 2
    while candidate.exists():
        candidate = folder / f"{base} ({index}).md"
        index += 1
    return candidate


def copy_to_feed(config: dict, source: Path) -> Path:
    vault_root = Path(config["vaultRoot"])
    feed_folder = config.get("ingest", {}).get("feedFolder", "ingest")
    feed_dir = (vault_root / feed_folder).resolve()
    if not is_inside(vault_root, feed_dir):
        raise RuntimeError(f"feed folder is outside vault: {feed_dir}")
    feed_dir.mkdir(parents=True, exist_ok=True)
    target = feed_dir / source.name
    if target.exists():
        target = feed_dir / f"{source.stem}-{int(time.time())}{source.suffix}"
    shutil.copy2(source, target)
    log("fed file copied into vault", source=str(source), target=str(target))
    return target


def save_uploaded_file(config: dict, filename: str, data: bytes) -> Path:
    vault_root = Path(config["vaultRoot"])
    feed_folder = config.get("ingest", {}).get("feedFolder", "ingest")
    feed_dir = (vault_root / feed_folder).resolve()
    if not is_inside(vault_root, feed_dir):
        raise RuntimeError(f"feed folder is outside vault: {feed_dir}")
    feed_dir.mkdir(parents=True, exist_ok=True)
    safe_name = note_slug(Path(filename)) + Path(filename).suffix.lower()
    target = feed_dir / safe_name
    if target.exists():
        target = feed_dir / f"{Path(safe_name).stem}-{int(time.time())}{Path(safe_name).suffix}"
    target.write_bytes(data)
    log("uploaded file saved into vault", target=str(target))
    return target


class ReadableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self._in_title = False
        self._skip_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True
        if tag in {"p", "div", "section", "article", "br", "li", "tr", "h1", "h2", "h3", "h4"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False
        if tag in {"p", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        text = " ".join(data.split())
        if not text:
            return
        if self._in_title:
            self.title = (self.title + " " + text).strip()
            return
        if self._skip_depth:
            return
        self.parts.append(text)

    def readable_text(self) -> str:
        text = " ".join(self.parts)
        text = re.sub(r"\s*\n\s*", "\n", text)
        text = re.sub(r"[ \t]{2,}", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def url_filename(url: str, suffix: str = ".md") -> str:
    parsed = urllib.parse.urlparse(url)
    seed = f"{parsed.netloc} {parsed.path}".strip() or "web-source"
    seed = urllib.parse.unquote(seed)
    seed = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._ -]+", " ", seed)
    seed = " ".join(seed.split()).strip(" ._-")
    return f"{(seed or 'web-source')[:90]}{suffix}"


def save_url_to_feed(config: dict, url: str) -> Path:
    parsed = urllib.parse.urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError("expected an http or https URL")

    request = urllib.request.Request(
        urllib.parse.urlunparse(parsed),
        headers={"User-Agent": "CatVaultAgent/0.1 (+local research vault)"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        content_type = response.headers.get("Content-Type", "")
        data = response.read(12_000_000)

    if "application/pdf" in content_type.lower() or parsed.path.lower().endswith(".pdf"):
        return save_uploaded_file(config, url_filename(url, ".pdf"), data)

    charset = "utf-8"
    match = re.search(r"charset=([^;]+)", content_type, flags=re.I)
    if match:
        charset = match.group(1).strip()
    html_text = data.decode(charset, errors="replace")
    parser = ReadableHTMLParser()
    parser.feed(html_text)
    title = parser.title or parsed.netloc
    readable = parser.readable_text()
    if not readable:
        readable = html_text[: int(config["ingest"].get("maxCharsPerFile", 30000))]

    markdown = "\n".join(
        [
            "---",
            "type: web-source",
            f"source_url: {url}",
            f"captured_at: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}",
            "created_by: Wiki Cat",
            "---",
            "",
            f"# {title}",
            "",
            f"Source URL: {url}",
            "",
            "## Captured Text",
            "",
            readable,
            "",
        ]
    )
    target = save_uploaded_file(config, url_filename(url, ".md"), markdown.encode("utf-8"))
    log("web url saved into vault", url=url, target=str(target))
    return target


def text_title(text: str) -> str:
    for line in text.splitlines():
        clean = " ".join(line.strip().lstrip("#>- ").split())
        if len(clean) >= 6:
            return clean[:70]
    return f"text-capture-{time.strftime('%Y%m%d-%H%M%S')}"


def save_text_to_feed(config: dict, text: str, source: str = "dragged-text") -> Path:
    text = text.strip()
    if not text:
        raise RuntimeError("text is empty")
    max_chars = int(config.get("ingest", {}).get("maxDraggedTextChars", 2_000_000))
    if len(text) > max_chars:
        raise RuntimeError(f"text is too large; maxDraggedTextChars={max_chars}")
    title = text_title(text)
    markdown = "\n".join(
        [
            "---",
            "type: text-capture",
            f"source: {source}",
            f"captured_at: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}",
            "created_by: Wiki Cat",
            "---",
            "",
            f"# {title}",
            "",
            "## Captured Text",
            "",
            text,
            "",
        ]
    )
    filename = f"{title_slug(title)}.md"
    target = save_uploaded_file(config, filename, markdown.encode("utf-8"))
    log("dragged text saved into vault", target=str(target), chars=len(text))
    return target


def collect_candidates(config: dict, state: dict) -> list[dict]:
    vault_root = Path(config["vaultRoot"])
    extensions = {ext.lower() for ext in config["ingest"]["extensions"]}
    excluded = [
        (vault_root / folder).resolve()
        for folder in config.get("ingest", {}).get("excludeFolders", [])
    ]
    files: list[dict] = []
    folders = list(config["ingest"]["folders"])
    if config["ingest"].get("feedFolder") not in folders:
        folders.append(config["ingest"].get("feedFolder", "ingest"))
    for folder in folders:
        folder_path = (vault_root / folder).resolve()
        if not is_inside(vault_root, folder_path):
            continue
        if not folder_path.exists():
            continue
        for path in folder_path.rglob("*"):
            if any(path.resolve() == excluded_path or is_inside(excluded_path, path.resolve()) for excluded_path in excluded):
                continue
            if not path.is_file() or path.suffix.lower() not in extensions:
                continue
            digest = file_hash(path)
            key = str(path)
            if state["processed"].get(key) == digest:
                continue
            files.append({"filePath": path, "hash": digest})
    return files


def sync_jobs(config: dict, state: dict) -> dict:
    data = load_jobs()
    known = {(job.get("filePath"), job.get("hash")) for job in data["jobs"]}
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    for item in collect_candidates(config, state):
        key = (str(item["filePath"]), item["hash"])
        if key in known:
            continue
        data["jobs"].append(
            {
                "id": hashlib.sha256(f"{key[0]}|{key[1]}".encode("utf-8")).hexdigest()[:16],
                "filePath": key[0],
                "hash": key[1],
                "status": "queued",
                "createdAt": now,
                "updatedAt": now,
                "error": None,
                "outputPath": None,
            }
        )
    save_jobs(data)
    return data


def build_prompt(config: dict, path: Path, text: str) -> str:
    rel = path.relative_to(Path(config["vaultRoot"])).as_posix()
    output = config.get("output", {})
    language = output.get("language", "en-US")
    analysis_prompt = output.get(
        "analysisPrompt",
        "Default to English. Extract reusable concepts, methods, systems, evidence chains, limitations, and open questions.",
    )
    return "\n".join(
        [
            "You maintain an Obsidian vault for scientific literature and research knowledge management.",
            "The vault focuses on LLM research, phonon/lattice-dynamics research, materials science, and adjacent computational research.",
            f"Output language: {language}. Use Chinese by default unless the source explicitly requires another language.",
            f"Vault-specific analysis instructions: {analysis_prompt}",
            "Create a structured Obsidian Markdown literature note from the source content.",
            "Be precise, evidence-aware, and useful for future research synthesis.",
            "Do not invent metadata. If a field is missing, write 'Not found in extracted text'.",
            "Use wiki links for reusable concepts, e.g. [[wiki/concepts/Phonon]], [[wiki/concepts/Thermal Conductivity]].",
            "Preserve figure/table references if present in the text, and mention associated image paths when visible.",
            "",
            "Use this exact structure:",
            "---",
            "type: literature-note",
            "status: processed",
            "source_path: <source path>",
            "created_by: Wiki Cat",
            "---",
            "",
            "# <paper title>",
            "## Citation",
            "- Title:",
            "- Authors:",
            "- Year:",
            "- Journal/Conference:",
            "- DOI/URL:",
            "",
            "## Research Classification",
            "- Domain:",
            "- Materials/System:",
            "- Task/Problem:",
            "- Methods:",
            "- Data/Code:",
            "",
            "## One-Sentence Takeaway",
            "## Structured Abstract",
            "- Background:",
            "- Objective:",
            "- Approach:",
            "- Main Results:",
            "- Significance:",
            "",
            "## Key Contributions",
            "- ",
            "",
            "## Methods And Experimental Design",
            "- ",
            "",
            "## Results And Evidence",
            "| Claim | Evidence from paper | Figure/Table | Confidence |",
            "|---|---|---|---|",
            "",
            "## Figures And Tables",
            "| Item | What it shows | Why it matters | Asset/link if available |",
            "|---|---|---|---|",
            "",
            "## Important Equations Or Variables",
            "- ",
            "",
            "## Limitations And Caveats",
            "- ",
            "",
            "## Reusable Concepts",
            "- ",
            "",
            "## Links To Existing Vault Topics",
            "- [[wiki/concepts/Phonon]] if relevant",
            "- [[wiki/concepts/Lattice Dynamics]] if relevant",
            "- [[wiki/concepts/LLM Knowledge Base]] if relevant",
            "",
            "## Follow-Up Questions",
            "- ",
            "",
            "## Extraction Notes",
            "- Source path:",
            "- Missing metadata:",
            "- OCR or parsing issues:",
            "",
            "Now create the literature note.",
            "",
            f"Source path: {rel}",
            "",
            "Source content:",
            text,
        ]
    )


def update_literature_index(config: dict, output_path: Path, markdown: str) -> None:
    vault_root = Path(config["vaultRoot"])
    index_path = vault_root / "wiki" / "Literature Index.md"
    if not is_inside(vault_root, index_path):
        return
    index_path.parent.mkdir(parents=True, exist_ok=True)
    title = output_path.stem
    for line in markdown.splitlines():
        if line.startswith("# "):
            title = line[2:].strip() or title
            break
    rel_note = output_path.relative_to(vault_root).with_suffix("").as_posix()
    entry = f"- [[{rel_note}|{title}]]"
    if index_path.exists():
        existing = index_path.read_text(encoding="utf-8")
        if entry in existing or rel_note in existing:
            return
        content = existing.rstrip() + "\n" + entry + "\n"
    else:
        content = "\n".join(
            [
                "# Literature Index",
                "",
                "Automatically updated list of processed literature notes.",
                "",
                "## Papers",
                "",
                entry,
                "",
            ]
        )
    index_path.write_text(content, encoding="utf-8")


def update_map_of_contents(config: dict) -> None:
    vault_root = Path(config["vaultRoot"])
    moc_path = vault_root / "wiki" / "Map of Contents.md"
    if not moc_path.exists():
        return
    text = moc_path.read_text(encoding="utf-8")
    link = "- [[wiki/Literature Index]]"
    if link not in text:
        text = text.rstrip() + "\n\n## Literature\n\n" + link + "\n"
        moc_path.write_text(text, encoding="utf-8")


def call_model(config: dict, prompt: str) -> str:
    model = config["model"]
    api_key = model.get("apiKey") or os.environ.get(model.get("apiKeyEnv", ""))
    base_url = model["baseUrl"]
    if not api_key and "127.0.0.1" not in base_url and "localhost" not in base_url:
        raise RuntimeError(f"missing API key; set {model.get('apiKeyEnv')} or model.apiKey")

    body = {
        "model": model["model"],
        "temperature": model.get("temperature", 0.2),
        "max_tokens": model.get("maxTokens", 1800),
        "messages": [
            {"role": "system", "content": "You are a careful scientific knowledge-base curator."},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    extra_body = {}
    if "dashscope" in base_url or "aliyuncs.com" in base_url:
        extra_body["enable_thinking"] = bool(model.get("enableThinking", False))

    request = urllib.request.Request(
        base_url,
        data=json.dumps({**body, **extra_body}).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=int(model.get("timeoutSeconds", 120))) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"model API failed {error.code}: {detail}") from error
    return data.get("choices", [{}])[0].get("message", {}).get("content", "")


def note_text(path: Path, max_chars: int = 5000) -> str:
    return path.read_text(encoding="utf-8", errors="replace")[:max_chars]


TERM_ALIASES = {
    "导热": ["thermal conductivity", "thermal transport", "heat conduction"],
    "热导率": ["thermal conductivity", "thermal conductance"],
    "界面": ["interface", "interfacial", "interface engineering"],
    "声子": ["phonon", "phonons"],
    "晶格动力学": ["lattice dynamics"],
    "环氧": ["epoxy", "epoxy resin"],
    "石墨": ["graphite", "expanded graphite"],
    "大模型": ["llm", "large language model"],
    "知识库": ["knowledge base", "vault", "rag"],
    "检索增强": ["retrieval augmented generation", "rag"],
    "复合材料": ["composite", "composites"],
}


def cjk_ngrams(text: str) -> list[str]:
    chars = re.findall(r"[\u4e00-\u9fff]", text)
    joined = "".join(chars)
    tokens: list[str] = []
    for size in (2, 3, 4):
        for index in range(max(0, len(joined) - size + 1)):
            tokens.append(joined[index : index + size])
    return tokens


def query_terms(query: str) -> list[str]:
    normalized = query.lower()
    normalized = re.sub(r"[，。！？；：、,.!?;:()\[\]{}<>\"'`~|/\\]+", " ", normalized)
    tokens = [term for term in normalized.split() if len(term) > 1]
    tokens += re.findall(r"[a-z][a-z0-9+-]{1,}", normalized)
    tokens += cjk_ngrams(query)
    for key, aliases in TERM_ALIASES.items():
        if key in query or any(alias in normalized for alias in aliases):
            tokens.append(key.lower())
            tokens.extend(alias.lower() for alias in aliases)
    seen = set()
    unique = []
    for token in tokens:
        token = token.strip()
        if len(token) < 2 or token in seen:
            continue
        seen.add(token)
        unique.append(token)
    return unique


def score_note(query: str, terms: list[str], path: Path, text: str) -> int:
    lower = text.lower()
    title = path.stem.lower()
    rel = path.as_posix().lower()
    score = 0
    if query and query.lower() in lower:
        score += 25
    for term in terms:
        count = lower.count(term)
        if not count:
            continue
        weight = 1
        if term in title:
            weight += 8
        if term in rel:
            weight += 3
        if len(term) >= 4:
            weight += 1
        score += min(count, 12) * weight
    return score


def retrieve_notes(config: dict, query: str, limit: int = 6) -> list[dict]:
    vault_root = Path(config["vaultRoot"])
    wiki_root = vault_root / "wiki"
    terms = [term.lower() for term in query.replace("，", " ").replace(",", " ").split() if len(term.strip()) > 1]
    scored = []
    for path in wiki_root.rglob("*.md"):
        text = note_text(path, max_chars=8000)
        lower = text.lower()
        score = sum(lower.count(term) for term in terms)
        if query.lower() in lower:
            score += 5
        if score <= 0 and terms:
            continue
        if not terms:
            score = 1
        scored.append((score, path, text))
    scored.sort(key=lambda item: item[0], reverse=True)
    results = []
    for score, path, text in scored[:limit]:
        results.append(
            {
                "path": path.relative_to(vault_root).as_posix(),
                "score": score,
                "text": text[:5000],
            }
        )
    return results


def retrieve_notes(config: dict, query: str, limit: int = 8) -> list[dict]:
    vault_root = Path(config["vaultRoot"])
    wiki_root = vault_root / "wiki"
    terms = query_terms(query)
    scored = []
    if not wiki_root.exists():
        return []
    for path in wiki_root.rglob("*.md"):
        text = note_text(path, max_chars=12000)
        score = score_note(query, terms, path.relative_to(vault_root), text)
        if score <= 0:
            continue
        scored.append((score, path, text))
    scored.sort(key=lambda item: item[0], reverse=True)
    results = []
    for score, path, text in scored[:limit]:
        results.append(
            {
                "path": path.relative_to(vault_root).as_posix(),
                "score": score,
                "text": text[:6000],
            }
        )
    return results


def answer_question(config: dict, question: str) -> dict:
    contexts = retrieve_notes(config, question)
    context_text = "\n\n".join(
        f"[{item['path']}]\n{item['text']}" for item in contexts
    )
    prompt = "\n".join(
        [
            "You answer questions using a local Obsidian scientific literature knowledge base.",
            "Use only the provided context when possible. If the context is insufficient, say what is missing.",
            "Answer in Chinese unless the user asks otherwise.",
            "Cite note paths inline, for example (wiki/sources/example.md).",
            "",
            "Question:",
            question,
            "",
            "Context:",
            context_text or "No relevant notes found.",
        ]
    )
    return {"answer": call_model(config, prompt), "sources": [{"path": item["path"], "score": item["score"]} for item in contexts]}


def extract_json_object(text: str) -> dict:
    clean = text.strip()
    if clean.startswith("```"):
        clean = re.sub(r"^```(?:json)?\s*", "", clean)
        clean = re.sub(r"\s*```$", "", clean)
    start = clean.find("{")
    end = clean.rfind("}")
    if start >= 0 and end > start:
        clean = clean[start : end + 1]
    return json.loads(clean)


def design_architecture(config: dict, requirements: str, language: str = "en-US") -> dict:
    fallback = default_architecture_plan(requirements, language)
    prompt = "\n".join(
        [
            "You are a knowledge-base architect designing an Obsidian wiki that will be maintained by a local LLM agent.",
            "Return one valid JSON object only. Do not return Markdown outside the JSON object. Do not explain.",
            f"Use this output language for user-facing wiki content: {language}.",
            "",
            "JSON schema:",
            "{",
            '  "language": "en-US",',
            '  "summary": "one-sentence positioning of the wiki",',
            '  "folders": ["wiki/sources", "wiki/concepts", "..."],',
            '  "home": "complete Markdown content for Home.md",',
            '  "mapOfContents": "complete Markdown content for Map of Contents.md",',
            '  "analysisPrompt": "the system prompt used later to analyze sources; preserve sources and support research knowledge management"',
            "}",
            "",
            "Required folders: wiki/sources, wiki/concepts, wiki/syntheses, wiki/questions, raw, ingest, inbox, templates.",
            "Do not use absolute paths. Do not use .. paths. Keep folder names Obsidian-friendly.",
            "",
            "User requirements:",
            requirements.strip() or fallback["summary"],
        ]
    )
    try:
        generated = extract_json_object(call_model(config, prompt))
        return normalize_architecture_plan(generated, requirements, language)
    except Exception as error:
        log("architecture design fallback used", error=str(error))
        return fallback


def process_file(config: dict, state: dict, item: dict) -> None:
    source_path = Path(item["filePath"])
    STATUS["processing"] = True
    STATUS["activeFile"] = str(source_path)
    original_path = source_path
    if source_path.suffix.lower() == ".pdf":
        if config.get("dryRun", True):
            output_dir = Path(config["vaultRoot"]) / config["parser"]["mineru"].get("outputFolder", "raw/mineru-md")
            log("dry run: would parse PDF with MinerU", filePath=str(source_path), outputFolder=str(output_dir))
            return
        source_path = parse_pdf_with_mineru(source_path, config, config["vaultRoot"])

    max_chars = int(config["ingest"].get("maxCharsPerFile", 30000))
    text = source_path.read_text(encoding="utf-8", errors="replace")[:max_chars]
    output_dir = Path(config["vaultRoot"]) / config["output"]["sourceNotesFolder"]
    if config.get("dryRun", True):
        output_path = output_dir / f"{note_slug(original_path)}.md"
        log("dry run: would process file", filePath=str(source_path), outputPath=str(output_path))
        return str(output_path)

    markdown = call_model(config, build_prompt(config, source_path, text))
    output_dir.mkdir(parents=True, exist_ok=True)
    title = markdown_title(markdown, note_slug(original_path))
    output_path = unique_note_path(output_dir, title)
    if not is_inside(Path(config["vaultRoot"]), output_path):
        raise RuntimeError(f"refusing to write outside vault: {output_path}")
    markdown = expand_research_graph(config, output_path, markdown)
    output_path.write_text(markdown.strip() + "\n", encoding="utf-8")
    update_literature_index(config, output_path, markdown)
    update_map_of_contents(config)
    state["processed"][str(original_path)] = item["hash"]
    STATUS["lastProcessed"] = str(original_path)
    log("processed file", filePath=str(source_path), outputPath=str(output_path))
    return str(output_path)


def run_once() -> None:
    with RUN_LOCK:
        _run_once_locked()


def request_run() -> None:
    global RUN_THREAD
    RUN_EVENT.set()
    with RUN_THREAD_LOCK:
        if RUN_THREAD and RUN_THREAD.is_alive():
            return
        RUN_THREAD = threading.Thread(target=run_worker, daemon=True)
        RUN_THREAD.start()


def run_worker() -> None:
    while RUN_EVENT.is_set():
        RUN_EVENT.clear()
        try:
            run_once()
        except Exception as error:
            log("run failed", error=str(error))


def _run_once_locked() -> None:
    config = load_config()
    state = load_state()
    jobs_data = sync_jobs(config, state)
    jobs = [job for job in jobs_data["jobs"] if job.get("status") in {"queued", "running"}]
    for job in jobs:
        if job.get("status") == "running":
            job["status"] = "queued"
    save_jobs(jobs_data)
    STATUS["pending"] = len(jobs)
    STATUS["queueLength"] = len(jobs)
    STATUS["lastRunAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    log("scan complete", pending=len(jobs))

    for index, job in enumerate(jobs):
        try:
            STATUS["pending"] = len(jobs) - index
            STATUS["queueLength"] = len(jobs) - index
            job["status"] = "running"
            job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            save_jobs(jobs_data)
            output_path = process_file(config, state, {"filePath": job["filePath"], "hash": job["hash"]})
            job["status"] = "done"
            job["outputPath"] = output_path
            job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            job["error"] = None
            STATUS["processedThisSession"] += 1
            write_json(STATE_PATH, state)
            save_jobs(jobs_data)
        except Exception as error:
            message = str(error)
            job["status"] = "failed"
            job["error"] = message
            job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            save_jobs(jobs_data)
            STATUS["errors"].insert(
                0, {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "message": message, "filePath": str(job["filePath"])},
            )
            del STATUS["errors"][10:]
            log("processing error", error=message, filePath=str(job["filePath"]))
    STATUS["pending"] = 0
    STATUS["queueLength"] = 0
    STATUS["processing"] = False
    STATUS["activeFile"] = None


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/api/status":
            refresh_queue_status()
            STATUS["jobs"] = load_jobs().get("jobs", [])[-20:]
            self.send_json(STATUS)
            return
        if self.path == "/api/config":
            self.send_json(load_raw_config())
            return
        if self.path == "/api/vault-status":
            self.send_json(vault_status())
            return
        if self.path.startswith("/api/search"):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("q", [""])[0]
            config = load_config()
            self.send_json({"query": query, "terms": query_terms(query), "results": retrieve_notes(config, query)})
            return
        if self.path in {"/", "/index.html"}:
            self.serve_file(PUBLIC_DIR / "index.html", "text/html; charset=utf-8")
            return
        if self.path == "/style.css":
            self.serve_file(PUBLIC_DIR / "style.css", "text/css; charset=utf-8")
            return
        if self.path == "/pet.js":
            self.serve_file(PUBLIC_DIR / "pet.js", "application/javascript; charset=utf-8")
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path == "/api/run":
            request_run()
            self.send_json({"ok": True, "queued": True, "status": STATUS})
            return
        if self.path == "/api/feed-path":
            self.handle_feed_path()
            return
        if self.path == "/api/feed-upload":
            self.handle_feed_upload()
            return
        if self.path == "/api/feed-url":
            self.handle_feed_url()
            return
        if self.path == "/api/feed-text":
            self.handle_feed_text()
            return
        if self.path == "/api/config":
            self.handle_config_update()
            return
        if self.path == "/api/setup-vault":
            self.handle_setup_vault()
            return
        if self.path == "/api/design-vault":
            self.handle_design_vault()
            return
        if self.path == "/api/ask":
            self.handle_ask()
            return
        self.send_error(404)

    def handle_ask(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        question = payload.get("question", "").strip()
        if not question:
            self.send_error(400, "question is required")
            return
        self.send_json(answer_question(load_config(), question))

    def handle_setup_vault(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        vault_path = payload.get("vaultRoot")
        if not vault_path:
            self.send_error(400, "vaultRoot is required")
            return
        self.send_json(initialize_vault(vault_path, payload.get("architecture")))

    def handle_design_vault(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        requirements = payload.get("requirements", "")
        language = payload.get("language", "en-US")
        self.send_json({"ok": True, "architecture": design_architecture(load_config(), requirements, language)})

    def handle_config_update(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        config = load_raw_config()

        for key in ["vaultRoot", "intervalSeconds", "dryRun"]:
            if key in payload:
                config[key] = payload[key]
        if "model" in payload:
            config.setdefault("model", {})
            for key in ["externalConfig", "baseUrl", "model", "temperature", "maxTokens"]:
                if key in payload["model"]:
                    config["model"][key] = payload["model"][key]
        if "output" in payload:
            config.setdefault("output", {})
            for key in ["sourceNotesFolder", "questionsFolder", "language", "analysisPrompt"]:
                if key in payload["output"]:
                    config["output"][key] = payload["output"][key]
        if "parser" in payload and "mineru" in payload["parser"]:
            config.setdefault("parser", {}).setdefault("mineru", {})
            for key in ["apiFile", "outputFolder", "assetsFolder", "language", "enableFormula", "enableTable", "isOcr"]:
                if key in payload["parser"]["mineru"]:
                    config["parser"]["mineru"][key] = payload["parser"]["mineru"][key]

        save_raw_config(config)
        self.send_json({"ok": True, "config": config})

    def handle_feed_path(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        source = Path(payload.get("path", "")).resolve()
        config = load_config()
        if not source.exists() or not source.is_file():
            self.send_error(400, "file does not exist")
            return
        fed = copy_to_feed(config, source)
        request_run()
        self.send_json({"ok": True, "fedPath": str(fed), "queued": True, "status": STATUS})

    def handle_feed_upload(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type or "boundary=" not in content_type:
            self.send_error(400, "expected multipart/form-data")
            return
        boundary = content_type.split("boundary=", 1)[1].encode("utf-8")
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        config = load_config()
        saved: list[str] = []

        for part in body.split(b"--" + boundary):
            if b"Content-Disposition" not in part or b"\r\n\r\n" not in part:
                continue
            head, data = part.split(b"\r\n\r\n", 1)
            data = data.rstrip(b"\r\n-")
            disposition = head.decode("utf-8", errors="replace")
            marker = 'filename="'
            if marker not in disposition:
                continue
            filename = disposition.split(marker, 1)[1].split('"', 1)[0]
            filename = urllib.parse.unquote(filename)
            target = save_uploaded_file(config, filename, data)
            saved.append(str(target))

        if not saved:
            self.send_error(400, "no files found")
            return
        request_run()
        self.send_json({"ok": True, "saved": saved, "queued": True, "status": STATUS})

    def handle_feed_url(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        url = payload.get("url", "").strip()
        if not url:
            self.send_error(400, "url is required")
            return
        try:
            target = save_url_to_feed(load_config(), url)
        except Exception as error:
            self.send_error(400, str(error))
            return
        request_run()
        self.send_json({"ok": True, "saved": str(target), "queued": True, "status": STATUS})

    def handle_feed_text(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        text = payload.get("text", "")
        source = payload.get("source", "dragged-text")
        try:
            target = save_text_to_feed(load_config(), text, source)
        except Exception as error:
            self.send_error(400, str(error))
            return
        request_run()
        self.send_json({"ok": True, "saved": str(target), "queued": True, "status": STATUS})

    def send_json(self, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, path: Path, content_type: str) -> None:
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def loop(interval_seconds: int) -> None:
    while True:
        time.sleep(max(30, interval_seconds))
        try:
            run_once()
        except Exception as error:
            log("run failed", error=str(error))


def main() -> None:
    config = load_config()
    worker = threading.Thread(target=loop, args=(int(config.get("intervalSeconds", 300)),), daemon=True)
    worker.start()

    with socketserver.TCPServer((config.get("host", "127.0.0.1"), int(config.get("port", 4317))), Handler) as server:
        log("server started", url=f"http://{config.get('host', '127.0.0.1')}:{config.get('port', 4317)}")
        request_run()
        server.serve_forever()


if __name__ == "__main__":
    main()
