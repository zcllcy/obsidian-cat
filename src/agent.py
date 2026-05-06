from __future__ import annotations

import hashlib
import http.server
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
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
APP_DATA_DIR = Path(os.environ.get("APPDATA", PROJECT_ROOT)) / "Obsidian Cat"
STATE_DIR = Path(os.environ.get("OBSIDIAN_CAT_STATE_DIR", os.environ.get("WIKI_CAT_STATE_DIR", APP_DATA_DIR / "state")))
LOG_DIR = Path(os.environ.get("OBSIDIAN_CAT_LOG_DIR", os.environ.get("WIKI_CAT_LOG_DIR", APP_DATA_DIR / "logs")))
STATE_PATH = STATE_DIR / "processed.json"
JOBS_PATH = STATE_DIR / "jobs.json"
LOG_PATH = LOG_DIR / "agent.log"
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

DEFAULT_ANALYSIS_PROMPT = """Default to English unless the user chooses another output language. Keep the required Markdown headings unchanged for graph extraction.

You are a careful research knowledge-base curator. Convert incoming sources into durable Obsidian Markdown notes.

1. Detect the source type first: research paper, review, web page, conversation, lab note, dataset description, or general note. If unclear, write Status: uncertain.
2. Do not invent titles, authors, years, venues, DOI, URLs, datasets, or code repositories. Missing fields must be written as Not found in extracted text. Inferred fields must be marked Status: inferred.
3. For papers and reviews, extract Citation, Research Classification, One-Sentence Takeaway, Structured Abstract, Key Contributions, Methods And Experimental Design, Results And Evidence, Figures And Tables, Important Equations Or Variables, Limitations And Caveats, Reusable Concepts, Links To Existing Vault Topics, Follow-Up Questions, and Extraction Notes.
4. Bind every non-obvious claim to a source path, original evidence, figure/table number, equation number, or context note. If evidence is insufficient, write Needs verification.
5. Reusable Concepts must be short concept phrases, not full sentences. Follow-Up Questions must be concrete and actionable.
6. Use standard Markdown and wiki links such as [[wiki/concepts/Phonon]]. Tables must be valid Markdown tables.
7. Keep the output complete and information-dense; avoid unsupported expansion or marketing-style summaries.
"""
def repair_mojibake_text(value: str) -> str:
    if not isinstance(value, str) or not value:
        return value
    markers = ("榛", "涓", "锛", "鑱", "鐑", "绉", "鍥", "澹", "姝")
    if sum(value.count(marker) for marker in markers) < 3:
        return value
    try:
        repaired = value.encode("gbk", errors="strict").decode("utf-8", errors="strict")
    except UnicodeError:
        return value
    return repaired if repaired.count("�") <= value.count("�") else value


def repair_text_fields(value):
    if isinstance(value, str):
        return repair_mojibake_text(value)
    if isinstance(value, list):
        return [repair_text_fields(item) for item in value]
    if isinstance(value, dict):
        return {key: repair_text_fields(item) for key, item in value.items()}
    return value


def read_json(path: Path) -> dict:
    return repair_text_fields(json.loads(path.read_text(encoding="utf-8-sig")))


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


def default_architecture_plan(requirements: str = "", language: str = "zh-CN") -> dict:
    focus = requirements.strip() or "科研文献、LLM 研究、声子/材料科学及其交叉方向"
    return {
        "language": language or "zh-CN",
        "summary": f"围绕“{focus}”建立一个适合 Obsidian 和 LLM 自动维护的科研知识库。",
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
            "默认使用中文输出正文内容，但保留系统要求的英文 Markdown 标题以便自动建图。"
            "先判断来源类型：科研论文、网页、聊天记录、实验记录或普通笔记。"
            "对科研论文必须提取 citation、研究问题、材料/体系、方法、数据/代码、关键贡献、证据链、图表含义、重要公式、局限性、可复用概念和后续问题。"
            "对网页或聊天记录，应整理为可追溯的研究笔记、概念卡片和行动问题。"
            "禁止编造缺失元数据；缺失字段写 Not found in extracted text。"
            "每个非显然结论必须绑定来源路径、原文证据或图表编号。"
            "Reusable Concepts 使用短语级概念，避免整句；Follow-Up Questions 使用可执行研究问题。"
        ),
    }


def normalize_architecture_plan(plan: dict | None, requirements: str = "", language: str = "zh-CN") -> dict:
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
    merged["language"] = str(merged.get("language") or language or "zh-CN")
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
    has_wiki = (vault / "wiki").exists()
    return {
        "vaultRoot": str(vault),
        "exists": vault.exists(),
        "hasObsidian": (vault / ".obsidian").exists(),
        "hasWiki": has_wiki,
        "ready": vault.exists() and has_wiki,
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
        jobs = sync_jobs(config, state, enqueue_missing=False).get("jobs", [])
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


INVALID_GRAPH_TOPIC_PATTERNS = [
    re.compile(r"^not found in extracted text$", re.I),
    re.compile(r"^needs verification$", re.I),
    re.compile(r"^status:\s*(uncertain|inferred)$", re.I),
    re.compile(r"^if relevant$", re.I),
    re.compile(r"^specifically\b", re.I),
    re.compile(r"^x\s*=", re.I),
    re.compile(r"^[a-z]{1,3}\)$", re.I),
]


def clean_item(text: str) -> str:
    item = repair_mojibake_text(text or "")
    item = item.strip().strip("-*").strip()
    item = re.sub(r"^\d+[.)]\s*", "", item)
    item = re.sub(r"^e\.g\.,?\s*", "", item, flags=re.I)
    item = re.sub(r"\s+", " ", item)
    item = item.replace("[[", "").replace("]]", "").strip()
    if "|" in item:
        item = item.split("|", 1)[-1].strip()
    if ":" in item and len(item.split(":", 1)[0]) < 80:
        item = item.split(":", 1)[0].strip()
    return item.strip(" \t\r\n\"'`.,;:，。；、")


def split_list_value(value: str) -> list[str]:
    items: list[str] = []
    current: list[str] = []
    depth = 0
    pairs = {"(": ")", "[": "]", "{": "}"}
    closing = set(pairs.values())
    for char in value:
        if char in pairs:
            depth += 1
        elif char in closing and depth > 0:
            depth -= 1
        if char in {",", ";", "，", "；", "、"} and depth == 0:
            item = "".join(current).strip()
            if item:
                items.append(item)
            current = []
            continue
        current.append(char)
    item = "".join(current).strip()
    if item:
        items.append(item)
    return items


def looks_invalid_graph_topic(title: str) -> bool:
    normalized = clean_item(title)
    if len(normalized) < 2 or len(normalized) > 100:
        return True
    if normalized.count("(") != normalized.count(")"):
        return True
    if normalized.count("[") != normalized.count("]"):
        return True
    if normalized.count("{") != normalized.count("}"):
        return True
    if normalized.endswith((")", "]", "}")) and not re.search(r"[\(\[\{]", normalized):
        return True
    if re.search(r"[\(\[\{]\s*$", normalized):
        return True
    if re.search(r"^\W+|\W+$", normalized):
        return True
    return any(pattern.match(normalized) for pattern in INVALID_GRAPH_TOPIC_PATTERNS)


def split_field_items(section: str, field: str) -> list[str]:
    for line in section.splitlines():
        if line.strip().lower().startswith(f"- {field.lower()}:"):
            value = line.split(":", 1)[1]
            items: list[str] = []
            for item in split_list_value(value):
                cleaned = clean_item(item)
                if cleaned and not looks_invalid_graph_topic(cleaned):
                    items.append(cleaned)
            return list(dict.fromkeys(items))
    return []


def bullet_items(section: str, limit: int = 12) -> list[str]:
    items = []
    for line in section.splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            item = clean_item(stripped[2:])
            if item and not looks_invalid_graph_topic(item):
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
    if looks_invalid_graph_topic(clean):
        log("skipped invalid graph topic", folder=folder, topic=name)
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
            "created_by: Obsidian Cat",
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
            "created_by: Obsidian Cat",
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


def sync_jobs(config: dict, state: dict, enqueue_missing: bool = True) -> dict:
    data = load_jobs()
    changed = False
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    for job in data["jobs"]:
        if job.get("status") in {"queued", "running"} and state.get("processed", {}).get(job.get("filePath")) == job.get("hash"):
            job["status"] = "done"
            job["updatedAt"] = now
            job["error"] = None
            changed = True
    known = {(job.get("filePath"), job.get("hash")) for job in data["jobs"]}
    if enqueue_missing:
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
            changed = True
    if changed:
        save_jobs(data)
    return data


def build_prompt(config: dict, path: Path, text: str) -> str:
    rel = path.relative_to(Path(config["vaultRoot"])).as_posix()
    output = config.get("output", {})
    language = output.get("language", "zh-CN")
    analysis_prompt = repair_mojibake_text(output.get("analysisPrompt") or DEFAULT_ANALYSIS_PROMPT)
    return "\n".join(
        [
            "You maintain an Obsidian vault for scientific literature and research knowledge management.",
            "The vault focuses on LLM research, phonon/lattice-dynamics research, materials science, and adjacent computational research.",
            f"Output language: {language}. Use Chinese by default unless the source explicitly requires another language.",
            f"Vault-specific analysis instructions: {analysis_prompt}",
            "Follow the output contract strictly. Keep all Markdown section headings exactly as specified below, even when writing the content in Chinese.",
            "Use concise, information-dense bullets. Prefer source-grounded evidence over generic summaries.",
            "Create a structured Obsidian Markdown literature note from the source content.",
            "Be precise, evidence-aware, and useful for future research synthesis.",
            "Do not invent metadata. If a field is missing, write 'Not found in extracted text'.",
            "Use wiki links for reusable concepts, e.g. [[wiki/concepts/Phonon]], [[wiki/concepts/Thermal Conductivity]].",
            "Preserve figure/table references if present in the text, and mention associated image paths when visible.",
            "If the source content contains Markdown image links, embed up to 3 key figures under 'Figures And Tables' using the original relative image path, e.g. ![](wiki/assets/example.jpg), followed by a concise Chinese note explaining what the figure shows and why it matters.",
            "",
            "Use this exact structure:",
            "---",
            "type: literature-note",
            "status: processed",
            "source_path: <source path>",
            "created_by: Obsidian Cat",
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


def extract_key_images(source_text: str, limit: int = 3) -> list[dict[str, str]]:
    lines = source_text.splitlines()
    candidates: list[dict[str, str]] = []
    image_pattern = re.compile(r"!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)")
    media_suffixes = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg")

    for index, line in enumerate(lines):
        match = image_pattern.search(line)
        if not match:
            continue
        image_path = normalize_image_path((match.group(1) or match.group(2)).strip())
        if not image_path.lower().split("?", 1)[0].endswith(media_suffixes):
            continue
        context_parts: list[str] = []
        for lookahead in range(index + 1, min(index + 5, len(lines))):
            candidate = lines[lookahead].strip()
            if not candidate:
                continue
            if image_pattern.search(candidate):
                break
            context_parts.append(candidate)
            if len(" ".join(context_parts)) > 260:
                break
        context = " ".join(context_parts).strip()
        score = 0
        lowered = context.lower()
        if re.search(r"\bfig(?:ure)?\.?\s*\d+|图\s*\d+", context, flags=re.I):
            score += 5
        if any(term in lowered for term in ["schematic", "mechanism", "result", "thermal", "phonon", "conductivity", "pdos", "vdos", "tbc"]):
            score += 2
        candidates.append({"path": image_path, "context": context[:360], "score": str(score), "order": str(index)})

    candidates.sort(key=lambda item: (-int(item["score"]), int(item["order"])))
    unique: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in candidates:
        if item["path"] in seen:
            continue
        seen.add(item["path"])
        unique.append(item)
        if len(unique) >= limit:
            break
    return unique


def normalize_image_path(path: str) -> str:
    clean = path.replace("\\", "/").strip()
    clean = re.sub(r"^/?images/", "", clean)
    marker = "wiki/assets/"
    if clean.count(marker) > 1:
        clean = marker + clean.rsplit(marker, 1)[1]
    return clean


def chinese_figure_caption(context: str, index: int) -> str:
    figure_match = re.search(r"\bFig(?:ure)?\.?\s*(\d+)|图\s*(\d+)", context, flags=re.I)
    figure = figure_match.group(1) or figure_match.group(2) if figure_match else str(index)
    lowered = context.lower()
    if any(term in lowered for term in ["thermal boundary", "tbc", "conductance", "conductivity"]):
        return f"Fig. {figure}：热边界导热或热导率结果，展示不同频率、结构或温度条件下的热输运贡献。"
    if any(term in lowered for term in ["molecular", "md", "pdos", "dos", "density"]):
        return f"Fig. {figure}：分子动力学或声子态密度分析，展示界面附近原子振动态密度与界面声子模式。"
    if any(term in lowered for term in ["raman", "eels", "haadf", "interfacial mode"]):
        return f"Fig. {figure}：空间分辨 Raman/EELS 等表征结果，用于识别界面局域声子模式及其频率分布。"
    if any(term in lowered for term in ["schematic", "diagram", "structure", "microstructure"]):
        return f"Fig. {figure}：结构示意图或微观形貌图，用于说明样品结构、界面构型或实验/模拟体系。"
    return f"Fig. {figure}：原文关键图，展示论文中的主要证据或机制；具体含义需结合正文和原图核对。"


def enrich_markdown_with_key_figures(markdown: str, source_text: str) -> str:
    if "### Key Figure Gallery" in markdown:
        return markdown
    images = extract_key_images(source_text)
    if not images:
        return markdown

    body = ["### Key Figure Gallery", ""]
    for index, item in enumerate(images, start=1):
        body.extend(
            [
                f"#### Key Figure {index}",
                "",
                f"![[{item['path']}]]",
                "",
                f"- 中文图注：{chinese_figure_caption(item['context'], index)}",
                "",
            ]
        )
    gallery = "\n".join(body).rstrip()

    bounds = re.search(r"^## Figures And Tables\s*$", markdown, flags=re.MULTILINE)
    if not bounds:
        return markdown.rstrip() + "\n\n## Figures And Tables\n\n" + gallery + "\n"
    next_section = re.search(r"^## .+$", markdown[bounds.end() :], flags=re.MULTILINE)
    insert_at = bounds.end() + next_section.start() if next_section else len(markdown)
    return markdown[:insert_at].rstrip() + "\n\n" + gallery + "\n\n" + markdown[insert_at:].lstrip()


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


def decode_http_body(raw: bytes, content_type: str = "") -> str:
    charset = "utf-8"
    match = re.search(r"charset=([^;]+)", content_type, flags=re.IGNORECASE)
    if match:
        charset = match.group(1).strip().strip('"')
    try:
        return raw.decode(charset)
    except (LookupError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace")


def extract_model_content(data: dict) -> str:
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0] or {}
        message = first.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = []
                for item in content:
                    if isinstance(item, str):
                        parts.append(item)
                    elif isinstance(item, dict):
                        text = item.get("text") or item.get("content")
                        if isinstance(text, str):
                            parts.append(text)
                return "\n".join(parts)
        text = first.get("text")
        if isinstance(text, str):
            return text
    output_text = data.get("output_text")
    if isinstance(output_text, str):
        return output_text
    output = data.get("output")
    if isinstance(output, list):
        parts = []
        for item in output:
            if isinstance(item, dict):
                for content_item in item.get("content", []):
                    if isinstance(content_item, dict) and isinstance(content_item.get("text"), str):
                        parts.append(content_item["text"])
        if parts:
            return "\n".join(parts)
    return ""


def call_model(config: dict, prompt: str, *, max_tokens: int | None = None, temperature: float | None = None) -> str:
    model = config["model"]
    api_key = model.get("apiKey") or os.environ.get(model.get("apiKeyEnv", ""))
    base_url = model["baseUrl"]
    if not api_key and "127.0.0.1" not in base_url and "localhost" not in base_url:
        raise RuntimeError(f"missing API key; set {model.get('apiKeyEnv')} or model.apiKey")

    body = {
        "model": model["model"],
        "temperature": model.get("temperature", 0.2) if temperature is None else temperature,
        "max_tokens": model.get("maxTokens", 1800) if max_tokens is None else max_tokens,
        "messages": [
            {"role": "system", "content": "You are a careful scientific knowledge-base curator."},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "Accept-Charset": "utf-8",
    }
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
            data = json.loads(decode_http_body(response.read(), response.headers.get("Content-Type", "")))
    except urllib.error.HTTPError as error:
        detail = decode_http_body(error.read(), error.headers.get("Content-Type", ""))[:500]
        raise RuntimeError(f"model API failed {error.code}: {detail}") from error
    return repair_mojibake_text(extract_model_content(data)).strip()


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


PET_FALLBACK_LINES = [
    "我把知识链路舔顺了。",
    "今天也在巡逻文献。",
    "新论文可以拖给我。",
    "等队列空了我再整理。",
    "我刚刚看了一眼图谱。",
]


def pet_line(config: dict) -> dict:
    prompt = (
        "请为一个像素风科研桌面宠物猫写一句中文短台词。"
        "要求：可爱、克制、像游戏 NPC；不超过 16 个中文字符；"
        "主题围绕文献、知识库、图谱、整理、等待队列；只输出一句台词。"
    )
    try:
        line = call_model(config, prompt, max_tokens=40, temperature=0.9)
        line = re.sub(r"[\r\n\"“”]+", "", line).strip()
        if not line or len(line) > 24:
            raise RuntimeError("pet line out of bounds")
        return {"ok": True, "line": line, "source": "model"}
    except Exception as error:
        log("pet line fallback used", error=str(error))
        return {"ok": True, "line": random.choice(PET_FALLBACK_LINES), "source": "fallback"}


def active_queue_jobs(config: dict | None = None, enqueue_missing: bool = False) -> list[dict]:
    raw = config or load_config()
    state = load_state()
    jobs = sync_jobs(raw, state, enqueue_missing=enqueue_missing).get("jobs", [])
    return [job for job in jobs if job.get("status") in {"queued", "running"}]


def run_vault_pipeline(config: dict, require_idle: bool = True) -> dict:
    if require_idle and (STATUS.get("processing") or active_queue_jobs(config, enqueue_missing=True)):
        raise RuntimeError("文献解析队列尚未完成，请等待 queued/running 任务结束后再运行维护。")

    vault_root = Path(config.get("vaultRoot", "")).resolve()
    script = vault_root / "tools" / "run_pipeline.py"
    if not vault_root.exists():
        raise RuntimeError(f"vaultRoot does not exist: {vault_root}")
    if not script.exists():
        raise RuntimeError(f"pipeline script not found: {script}")
    if not is_inside(vault_root, script):
        raise RuntimeError(f"refusing to run script outside vault: {script}")

    started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=str(vault_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        check=False,
    )
    finished = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    log(
        "vault pipeline completed" if result.returncode == 0 else "vault pipeline failed",
        returnCode=result.returncode,
        vaultRoot=str(vault_root),
    )
    return {
        "ok": result.returncode == 0,
        "returnCode": result.returncode,
        "startedAt": started,
        "finishedAt": finished,
        "vaultRoot": str(vault_root),
        "stdout": result.stdout[-12000:],
        "stderr": result.stderr[-12000:],
    }


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


def design_architecture(config: dict, requirements: str, language: str = "zh-CN") -> dict:
    fallback = default_architecture_plan(requirements, language)
    prompt = "\n".join(
        [
            "你是科研知识库架构师，正在为一个 Obsidian + LLM 自动维护的本地知识库设计初始化结构。",
            "请根据用户需求输出一个可直接落地的 JSON 对象。不要输出 Markdown，不要解释。",
            "语言必须优先使用中文。",
            "",
            "JSON schema:",
            "{",
            '  "language": "zh-CN",',
            '  "summary": "一句话说明知识库定位",',
            '  "folders": ["wiki/sources", "wiki/concepts", "..."],',
            '  "home": "Home.md 的完整 Markdown 内容",',
            '  "mapOfContents": "Map of Contents.md 的完整 Markdown 内容",',
            '  "analysisPrompt": "后续分析来源材料时应使用的系统化提示词，要求中文输出、保留来源、适合科研知识管理"',
            "}",
            "",
            "必须包含这些基础目录：wiki/sources, wiki/concepts, wiki/syntheses, wiki/questions, raw, ingest, inbox, templates。",
            "不要使用绝对路径。不要使用 ..。目录名保持 Obsidian 友好。",
            "",
            "用户需求：",
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
    markdown = enrich_markdown_with_key_figures(markdown, text)
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
    jobs_data = sync_jobs(config, state, enqueue_missing=True)
    jobs = [job for job in jobs_data["jobs"] if job.get("status") in {"queued", "running"}]
    for job in jobs:
        if job.get("status") == "running":
            job["status"] = "queued"
    save_jobs(jobs_data)
    STATUS["pending"] = len(jobs)
    STATUS["queueLength"] = len(jobs)
    STATUS["lastRunAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    log("scan complete", pending=len(jobs))

    batch_errors = False
    processed_any = False
    for index, job in enumerate(jobs):
        try:
            STATUS["pending"] = len(jobs) - index
            STATUS["queueLength"] = len(jobs) - index
            job["status"] = "running"
            job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            save_jobs(jobs_data)
            output_path = process_file(config, state, {"filePath": job["filePath"], "hash": job["hash"]})
            processed_any = True
            job["status"] = "done"
            job["outputPath"] = output_path
            job["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            job["error"] = None
            STATUS["processedThisSession"] += 1
            write_json(STATE_PATH, state)
            save_jobs(jobs_data)
        except Exception as error:
            batch_errors = True
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
    if (
        processed_any
        and not batch_errors
        and not config.get("dryRun", True)
        and config.get("maintenance", {}).get("autoRunAfterQueue", True)
    ):
        STATUS["lastMessage"] = "文献队列已完成，正在运行知识库维护"
        try:
            run_vault_pipeline(config, require_idle=False)
            STATUS["lastMessage"] = "文献队列已完成，知识库维护已完成"
        except Exception as error:
            STATUS["lastMessage"] = "文献队列已完成，但知识库维护失败"
            STATUS.setdefault("errors", []).append(str(error))
            log("auto maintenance failed", error=str(error))


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith("/images/") or self.path.startswith("/vault/") or self.path.startswith("/wiki/assets/"):
            self.serve_vault_asset()
            return
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
        if self.path == "/api/pet-line":
            self.send_json(pet_line(load_config()))
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
        if self.path == "/api/run-vault-pipeline":
            self.handle_run_vault_pipeline()
            return
        self.send_error(404)

    def handle_ask(self) -> None:
        payload = self.read_json_payload()
        question = payload.get("question", "").strip()
        if not question:
            self.send_error(400, "question is required")
            return
        self.send_json(answer_question(load_config(), question))

    def handle_run_vault_pipeline(self) -> None:
        payload = self.read_json_payload()
        if payload.get("confirm") is not True:
            self.send_error(400, "confirmation is required")
            return
        try:
            self.send_json(run_vault_pipeline(load_config()))
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)})

    def handle_setup_vault(self) -> None:
        payload = self.read_json_payload()
        vault_path = payload.get("vaultRoot")
        if not vault_path:
            self.send_error(400, "vaultRoot is required")
            return
        self.send_json(initialize_vault(vault_path, payload.get("architecture")))

    def handle_design_vault(self) -> None:
        payload = self.read_json_payload()
        requirements = payload.get("requirements", "")
        language = payload.get("language", "zh-CN")
        self.send_json({"ok": True, "architecture": design_architecture(load_config(), requirements, language)})

    def handle_config_update(self) -> None:
        payload = self.read_json_payload()
        config = load_raw_config()

        for key in ["vaultRoot", "intervalSeconds", "dryRun"]:
            if key in payload:
                config[key] = payload[key]
        if "model" in payload:
            config.setdefault("model", {})
            for key in [
                "externalConfig",
                "providerName",
                "baseUrl",
                "apiKeyEnv",
                "apiKey",
                "model",
                "temperature",
                "maxTokens",
                "timeoutSeconds",
                "enableThinking",
            ]:
                if key in payload["model"]:
                    config["model"][key] = payload["model"][key]
        if "maintenance" in payload:
            config.setdefault("maintenance", {})
            for key in ["autoRunAfterQueue"]:
                if key in payload["maintenance"]:
                    config["maintenance"][key] = payload["maintenance"][key]
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
        payload = self.read_json_payload()
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
        payload = self.read_json_payload()
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
        payload = self.read_json_payload()
        text = payload.get("text", "")
        source = payload.get("source", "dragged-text")
        try:
            target = save_text_to_feed(load_config(), text, source)
        except Exception as error:
            self.send_error(400, str(error))
            return
        request_run()
        self.send_json({"ok": True, "saved": str(target), "queued": True, "status": STATUS})

    def read_json_payload(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        payload = json.loads(decode_http_body(body, self.headers.get("Content-Type", "")))
        return repair_text_fields(payload)

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

    def serve_vault_asset(self) -> None:
        config = load_config()
        vault_root = Path(config["vaultRoot"]).resolve()
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/images/"):
            prefix = "/images/"
        elif parsed.path.startswith("/vault/"):
            prefix = "/vault/"
        else:
            prefix = "/"
        rel = urllib.parse.unquote(parsed.path[len(prefix):]).lstrip("/\\")
        target = (vault_root / rel).resolve()
        if not is_inside(vault_root, target) or not target.is_file():
            self.send_error(404)
            return
        content_type = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
            ".bmp": "image/bmp",
        }.get(target.suffix.lower(), "application/octet-stream")
        self.serve_file(target, content_type)

    def log_message(self, format: str, *args: object) -> None:
        return


def loop(interval_seconds: int) -> None:
    while True:
        time.sleep(max(30, interval_seconds))
        try:
            run_once()
        except Exception as error:
            log("run failed", error=str(error))


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    config = load_config()
    worker = threading.Thread(target=loop, args=(int(config.get("intervalSeconds", 300)),), daemon=True)
    worker.start()

    with ThreadingTCPServer((config.get("host", "127.0.0.1"), int(config.get("port", 4317))), Handler) as server:
        log("server started", url=f"http://{config.get('host', '127.0.0.1')}:{config.get('port', 4317)}")
        server.serve_forever()


if __name__ == "__main__":
    main()
