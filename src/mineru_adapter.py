from __future__ import annotations

import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid
import urllib.error
import urllib.request
import zipfile

import requests


MINERU_UPLOAD_URL = "https://mineru.net/api/v4/file-urls/batch"
MINERU_RESULT_URL = "https://mineru.net/api/v4/extract-results/batch/{batch_id}"


def _request_json(url: str, *, method: str = "GET", headers: dict | None = None, payload: dict | None = None) -> dict:
    try:
        if method == "POST":
            response = requests.post(url, headers=headers or {}, json=payload, timeout=120)
        else:
            response = requests.get(url, headers=headers or {}, timeout=120)
        response.raise_for_status()
        return response.json()
    except requests.HTTPError as error:
        body = error.response.text[:500] if error.response is not None else ""
        raise RuntimeError(f"MinerU {method} {url} failed: HTTP {error.response.status_code} {body}") from error


def _download(url: str) -> bytes:
    last_error: Exception | None = None
    headers = {"User-Agent": "CatVaultAgent/0.1", "Connection": "close"}
    for attempt in range(1, 6):
        try:
            with requests.get(url, headers=headers, timeout=300, stream=True) as response:
                response.raise_for_status()
                chunks = [chunk for chunk in response.iter_content(chunk_size=1024 * 1024) if chunk]
                return b"".join(chunks)
        except Exception as error:
            last_error = error
            time.sleep(min(20, attempt * 3))

    try:
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.read()
    except Exception as error:
        urllib_error = error

    curl_path = shutil.which("curl.exe") or shutil.which("curl")
    if curl_path:
        temp_zip = Path(os.environ.get("TEMP", ".")) / f"cat-vault-mineru-{uuid.uuid4().hex}.zip"
        result = subprocess.run(
            [
                curl_path,
                "-L",
                "--fail",
                "--silent",
                "--show-error",
                "--ssl-no-revoke",
                "--retry",
                "5",
                "--retry-delay",
                "3",
                "-A",
                "CatVaultAgent/0.1",
                "-o",
                str(temp_zip),
                url,
            ],
            capture_output=True,
            text=True,
            timeout=420,
        )
        if result.returncode == 0 and temp_zip.exists():
            data = temp_zip.read_bytes()
            temp_zip.unlink(missing_ok=True)
            return data
        temp_zip.unlink(missing_ok=True)
        raise RuntimeError(
            "MinerU zip download failed after retries: "
            f"{last_error}; urllib fallback: {urllib_error}; curl fallback: {result.stderr[:500]}"
        )

    raise RuntimeError(f"MinerU zip download failed after retries: {last_error}; urllib fallback: {urllib_error}")


def _upload(url: str, file_path: Path) -> None:
    with file_path.open("rb") as handle:
        response = requests.put(url, data=handle, timeout=240)
    try:
        response.raise_for_status()
    except requests.HTTPError as error:
        raise RuntimeError(f"MinerU upload PUT failed: HTTP {response.status_code} {response.text[:500]}") from error


def _tokens(api_file: Path) -> list[str]:
    if not api_file.exists():
        raise FileNotFoundError(f"MinerU api file not found: {api_file}")
    return [line.strip() for line in api_file.read_text(encoding="utf-8").splitlines() if line.strip()]


def _safe_slug(path: Path) -> str:
    name = path.stem
    for char in '<>:"/\\|?*':
        name = name.replace(char, " ")
    return " ".join(name.split()).strip()[:120] or f"mineru-{int(time.time())}"


def _rewrite_asset_links(md_path: Path, source_root: Path, asset_root: Path, note_slug: str, vault_root: Path) -> str:
    text = md_path.read_text(encoding="utf-8", errors="replace")
    asset_root.mkdir(parents=True, exist_ok=True)
    note_asset_dir = asset_root / note_slug
    note_asset_dir.mkdir(parents=True, exist_ok=True)

    media_suffixes = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
    replacements: dict[str, str] = {}

    for asset in source_root.rglob("*"):
        if not asset.is_file() or asset.suffix.lower() not in media_suffixes:
            continue
        target = note_asset_dir / asset.name
        if target.exists():
            target = note_asset_dir / f"{asset.stem}-{uuid.uuid4().hex[:8]}{asset.suffix}"
        shutil.copy2(asset, target)
        rel_from_vault = target.relative_to(vault_root).as_posix()
        replacements[asset.name] = rel_from_vault
        replacements[asset.relative_to(source_root).as_posix()] = rel_from_vault

    for old, new in replacements.items():
        text = text.replace(old, new)
    return text


def parse_pdf_with_mineru(file_path: str | Path, config: dict, vault_root: str | Path) -> Path:
    source = Path(file_path).resolve()
    vault = Path(vault_root).resolve()
    mineru = config["parser"]["mineru"]
    api_file = (Path(__file__).resolve().parent.parent / mineru["apiFile"]).resolve()
    tokens = _tokens(api_file)
    token = tokens[0]

    note_slug = _safe_slug(source)
    parsed_root = vault / mineru.get("outputFolder", "raw/parsed")
    parsed_md = parsed_root / f"{note_slug}.md"
    assets_root = vault / mineru.get("assetsFolder", "wiki/assets")
    work_root = Path(__file__).resolve().parent.parent / "state" / "mineru-work"
    extract_dir = work_root / note_slug

    if parsed_md.exists():
        return parsed_md

    if extract_dir.exists():
        shutil.rmtree(extract_dir)

    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    payload = {
        "enable_formula": bool(mineru.get("enableFormula", True)),
        "language": mineru.get("language", "en"),
        "enable_table": bool(mineru.get("enableTable", True)),
        "files": [{"name": source.name, "is_ocr": bool(mineru.get("isOcr", True)), "data_id": uuid.uuid4().hex}],
    }

    response = _request_json(MINERU_UPLOAD_URL, method="POST", headers=headers, payload=payload)
    if response.get("code") != 0:
        raise RuntimeError(f"MinerU upload URL request failed: {response}")

    batch_id = response["data"]["batch_id"]
    upload_url = response["data"]["file_urls"][0]
    _upload(upload_url, source)

    poll_headers = {"Authorization": f"Bearer {token}"}
    while True:
        time.sleep(5)
        result = _request_json(MINERU_RESULT_URL.format(batch_id=batch_id), headers=poll_headers)
        if result.get("code") != 0:
            raise RuntimeError(f"MinerU polling failed: {result}")
        extract_results = result["data"].get("extract_result", [])
        if not extract_results:
            continue
        item = extract_results[0]
        state = item.get("state")
        if state == "failed":
            raise RuntimeError(f"MinerU processing failed: {item.get('err_msg')}")
        if state != "done":
            continue

        zip_url = item.get("full_zip_url")
        if not zip_url:
            raise RuntimeError("MinerU result did not include full_zip_url")
        extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(_download(zip_url))) as archive:
            archive.extractall(extract_dir)
        break

    md_files = list(extract_dir.rglob("*.md"))
    if not md_files:
        raise RuntimeError(f"MinerU produced no Markdown under {extract_dir}")

    md_path = md_files[0]
    rewritten = _rewrite_asset_links(md_path, extract_dir, assets_root, note_slug, vault)
    parsed_root.mkdir(parents=True, exist_ok=True)
    parsed_md.write_text(rewritten, encoding="utf-8")
    shutil.rmtree(extract_dir, ignore_errors=True)
    return parsed_md
