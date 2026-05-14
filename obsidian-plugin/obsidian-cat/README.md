# Obsidian Cat

Obsidian Cat is an Obsidian plugin for LLM-driven literature management with a bundled desktop cat companion.

Drop a PDF onto the desktop cat, and the plugin can parse it with MinerU, extract figures into `wiki/assets/`, generate a structured source note in `wiki/sources/`, and update the vault's literature index.

## Highlights

- Native Obsidian settings page.
- Chinese and English interface switching.
- Chinese or English source-note body language.
- OpenAI-compatible model API settings.
- MinerU PDF parsing settings.
- Bundled desktop cat companion.
- Drag-and-drop paper feeding.
- Paper-title source-note filenames.
- Key Figure Gallery support.
- Automatic `wiki/Literature Index.md` updates.

## Quick Install

1. Copy this `obsidian-cat` folder to:

```text
<your-vault>/.obsidian/plugins/obsidian-cat
```

2. Enable `Obsidian Cat` in Obsidian community plugins.
3. Open `Settings -> Obsidian Cat`.
4. Click `Initialize`.
5. Configure Model API and MinerU tokens.
6. Click `Sync`.
7. Click `Start Desktop Cat`, then drag a PDF onto the cat.

## Default Output

```text
ingest/                  files dropped onto the cat
raw/parsed/              parsed Markdown
raw/processed_pdfs/      processed PDFs
wiki/assets/             extracted figures
wiki/sources/            literature notes
wiki/concepts/           reusable concepts
wiki/methods/            methods and workflows
wiki/materials/          materials and systems
wiki/questions/          follow-up questions
wiki/Literature Index.md literature index
```

## Docs

- `docs/QUICKSTART.zh-CN.md`
- `docs/USAGE.md`

## Commands

- `Obsidian Cat: Open Obsidian Cat Center`
- `Obsidian Cat: Start Desktop Cat`
- `Obsidian Cat: Check Desktop Cat Status`
- `Obsidian Cat: Draft Source Note From Current Parsed Markdown`
- `Obsidian Cat: Audit Vault`

## Requirements

- Obsidian desktop app.
- Windows for the bundled desktop cat runtime.
- MinerU token for PDF parsing.
- OpenAI-compatible model API for full LLM source-note generation.

Core plugin features do not require Python.
