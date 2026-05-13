# Obsidian Cat

Obsidian Cat is an Obsidian plugin for research-vault ingestion, PDF parsing, and LLM-assisted literature notes. It bundles a desktop cat companion, so users can drag papers onto the cat and keep working inside Obsidian.

## Features

- Native Obsidian settings page with Chinese/English UI switching.
- Bundled desktop cat runtime; no separate installer is required.
- Node.js companion backend; Python is not required.
- Model API and MinerU API configured through text fields.
- PDF workflow: `ingest/` -> MinerU -> `raw/parsed/` + `wiki/assets/` -> `wiki/sources/`.
- Source notes use paper-title filenames and preserve the vault schema: frontmatter, fixed English headings, evidence tables, Key Figure Gallery, concepts, methods, materials, and follow-up questions.
- Existing desktop cat is reused when Obsidian reopens.

## Install

1. Download `obsidian-cat-plugin-0.1.0.zip` from Releases.
2. Extract it to:

```text
<vault>/.obsidian/plugins/obsidian-cat
```

3. Enable `Obsidian Cat` in Obsidian community plugins.
4. Configure Model API and MinerU tokens in `Settings -> Obsidian Cat`.
5. Click `Initialize`, then `Sync`.

## Usage

Chinese quick start: [docs/中文快速开始.md](docs/中文快速开始.md)

Full guide: [docs/USAGE.md](docs/USAGE.md)

## Development

```powershell
npm install
npm run plugin:check
npm run dist:win
npm run plugin:bundle-runtime
```

Create the install zip:

```powershell
Compress-Archive -Path obsidian-plugin/obsidian-cat/* -DestinationPath dist/obsidian-cat-plugin-0.1.0.zip -Force
```

## Notes

- Do not commit `data.json`, `agent.config.json`, API keys, logs, runtime state, or generated release zips.
- The old web console is not the primary UI; configuration lives in Obsidian settings.
