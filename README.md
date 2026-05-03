# Wiki Cat

![Wiki Cat logo](assets/wiki-cat.png)

Wiki Cat is a pixel cat desktop pet that helps maintain an Obsidian-style Markdown wiki with an LLM.

Feed it a PDF, Markdown file, copied text, a web link, or an exported conversation. Wiki Cat queues the source, parses it, asks your model to curate it, and writes durable notes into a local wiki.

The project is intentionally small: an Electron desktop pet, a Python local agent, a browser-based workbench, and plain Markdown files.

## Why It Exists

Most personal knowledge bases fail in two places:

- getting raw sources into a usable structure
- retrieving the right notes later without losing citations

Wiki Cat tries to make the first step delightful. The desktop pet is the ingest surface. The web workbench is where you configure the vault, ask questions, and inspect queue state. Obsidian remains the long-term editing and graph interface.

## Core Ideas

- **Desktop pet as ingest UI**: drag files, text, and links onto the cat.
- **Obsidian-compatible wiki**: all curated knowledge is Markdown under `wiki/`.
- **Source-first workflow**: raw inputs stay separate from curated notes.
- **LLM-maintained structure**: source notes, concepts, methods, entities, syntheses, and open questions.
- **Grounded answers**: the Ask view retrieves local notes and cites paths.
- **No hosted backend**: the agent runs locally at `http://127.0.0.1:4317`.

## Architecture

```text
desktop pet
  -> feed files / text / links
  -> local Python agent queue
  -> optional PDF parser
  -> OpenAI-compatible chat model
  -> Markdown wiki notes
  -> browser workbench + Obsidian graph
```

Default vault layout:

```text
wiki/
  sources/
  concepts/
  materials/
  methods/
  entities/
  syntheses/
  questions/
raw/
  parsed/
wiki/assets/
ingest/
inbox/
templates/
```

## Features

- Pixel desktop pet with drag-and-drop feeding.
- Queue-based source processing.
- PDF, Markdown, text, URL, and copied-text ingest paths.
- First-run setup guide that asks for a vault folder and a short description of your knowledge needs.
- Optional LLM-generated vault architecture before creation.
- English by default, with language settings for output and parsing.
- Bilingual lexical retrieval for Ask mode, including CJK n-grams and scientific synonym aliases.
- Windows tray menu with show/hide, open workbench, run queue, feed files, and start-on-login.
- NSIS Windows installer.

## Quick Start

Install dependencies:

```powershell
npm install
```

Create a local config:

```powershell
Copy-Item .\config\agent.config.example.json .\config\agent.config.json
```

Set an API key through your environment or edit the config:

```powershell
$env:OPENAI_API_KEY = "your-key"
```

Run the desktop app:

```powershell
npm run desktop
```

Open the local workbench:

```text
http://127.0.0.1:4317
```

Build the Windows installer:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run dist:win
```

## Model Configuration

The model API is OpenAI-compatible by default:

```json
{
  "baseUrl": "https://api.openai.com/v1/chat/completions",
  "apiKeyEnv": "OPENAI_API_KEY",
  "model": "gpt-4.1-mini"
}
```

You can point it at DeepSeek, Qwen-compatible gateways, local OpenAI-compatible servers, or your own proxy.

Wiki Cat can also merge a separate JSON model config through `model.externalConfig`. Do not commit files containing API keys.

## PDF Parsing

PDF parsing is optional. The open-source default disables MinerU:

```json
{
  "parser": {
    "mineru": {
      "enabled": false
    }
  }
}
```

If you have a MinerU-compatible API file, set `parser.mineru.enabled` to `true` and configure `apiFile`.

## Safety Notes

- `config/agent.config.json`, `logs/`, `state/`, `dist/`, and `node_modules/` are ignored.
- Raw files are not deleted by default.
- The agent refuses to write outside the configured vault root.
- Generated notes cite source paths when possible.

## Project Status

Wiki Cat is early-stage software. It is useful as a local prototype for playful knowledge-base automation, but the retrieval layer is still lightweight. A future version should add a proper hybrid index, review inbox, and richer source-grounded reading workspace.

## License

MIT
