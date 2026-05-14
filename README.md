# Obsidian Cat

**Obsidian Cat is an Obsidian plugin that turns paper ingestion into a lightweight desktop-pet workflow: drag a PDF onto the cat, let MinerU parse it, and let an LLM organize the result into a research wiki.**

It is built for researchers who use [Obsidian](https://obsidian.md/) as a local knowledge base and want a practical, low-friction way to manage literature notes, extracted figures, reusable concepts, and follow-up research questions.

## What It Does

- **Obsidian-first literature management**  
  Runs as a normal Obsidian community plugin with a native settings page, commands, and vault-aware paths.

- **LLM-driven source notes**  
  Converts parsed papers into structured notes under `wiki/sources/`, using paper-title filenames, YAML frontmatter, fixed academic sections, evidence tables, and follow-up questions.

- **Desktop pet interaction**  
  Ships with a bundled desktop cat companion. Drop PDFs, Markdown, text, or snippets onto the cat to feed your vault without opening a separate console.

- **PDF parsing with MinerU**  
  Sends PDFs through MinerU, writes parsed Markdown to `raw/parsed/`, and normalizes extracted figures into `wiki/assets/` with Obsidian-compatible image links.

- **Research wiki maintenance**  
  Promotes concepts, methods, materials, and questions into dedicated folders, updates `wiki/Literature Index.md`, and keeps raw materials separate from curated notes.

## Workflow

```text
Drag PDF to desktop cat
        |
        v
ingest/ queue
        |
        v
MinerU parsing
        |
        +--> raw/parsed/<paper>.md
        +--> wiki/assets/<paper>/*
        |
        v
LLM source-note generation
        |
        +--> wiki/sources/<paper title>.md
        +--> wiki/concepts/
        +--> wiki/methods/
        +--> wiki/materials/
        +--> wiki/questions/
        +--> wiki/Literature Index.md
```

## Key Features

- Native Obsidian settings page.
- Chinese and English interface switching.
- Separate source-note body language setting.
- OpenAI-compatible model API configuration.
- MinerU token configuration through text fields.
- Bundled Windows desktop cat runtime.
- No separate installer required for the companion.
- No Python runtime required for core plugin features.
- Obsidian wiki links for source notes, concepts, methods, materials, and questions.
- Automatic `Literature Index` update after processing.

## Install

1. Install Obsidian from the official site: [obsidian.md/download](https://obsidian.md/download).
2. Download `obsidian-cat-plugin-0.1.0.zip` from this repository's Releases page.
3. Extract the `obsidian-cat` folder to:

```text
<your-vault>/.obsidian/plugins/obsidian-cat
```

4. Open Obsidian.
5. Enable `Obsidian Cat` in `Settings -> Community plugins`.
6. Open `Settings -> Obsidian Cat`.
7. Click `Initialize`, configure Model API and MinerU tokens, then click `Sync`.

## Basic Configuration

In `Settings -> Obsidian Cat`:

- `Interface language`: choose Chinese or English for the plugin UI.
- `Model API`: configure an OpenAI-compatible base URL, model name, API key, temperature, and max tokens.
- `MinerU API`: enable MinerU and add one or more tokens.
- `Wiki Architecture`: choose source-note language and vault folders.
- `Advanced`: runtime paths and companion settings.

The default vault layout is:

```text
raw/                  original and parsed materials
raw/parsed/           parsed Markdown from PDFs
raw/processed_pdfs/   processed PDFs
wiki/assets/          extracted figures and images
wiki/sources/         one structured note per source
wiki/concepts/        reusable concepts
wiki/methods/         methods and workflows
wiki/materials/       materials and systems
wiki/questions/       follow-up questions
wiki/syntheses/       higher-level summaries
templates/            note templates
```

## Source Note Format

Generated literature notes are designed for research workflows rather than generic summaries. A typical source note includes:

- citation fields
- research classification
- one-sentence takeaway
- structured abstract
- key contributions
- methods and experimental design
- evidence table
- figures and tables
- key figure gallery with image links
- important equations or variables
- limitations and caveats
- reusable concepts
- links to existing vault topics
- follow-up questions
- extraction notes

Markdown headings stay stable in English so graph-building and audit tools can rely on them. Body content can be generated in Chinese or English.

## Documentation

- 中文快速开始: [docs/QUICKSTART.zh-CN.md](docs/QUICKSTART.zh-CN.md)
- Full usage guide: [docs/USAGE.md](docs/USAGE.md)

## Development

```powershell
npm install
npm run plugin:check
npm run dist:win
npm run plugin:bundle-runtime
```

Create a release zip:

```powershell
Compress-Archive -Path obsidian-plugin/obsidian-cat/* -DestinationPath dist/obsidian-cat-plugin-0.1.0.zip -Force
```

## Notes For Contributors

- Do not commit `data.json`, `agent.config.json`, API keys, logs, runtime state, or generated release zips.
- The companion uses a local HTTP API at `http://127.0.0.1:4317` for plugin and desktop-cat communication.
- The bundled runtime is distributed through GitHub Releases, not committed to the source tree.
- Core plugin functionality is implemented in JavaScript/Node.js.

## License

See [LICENSE](LICENSE).
