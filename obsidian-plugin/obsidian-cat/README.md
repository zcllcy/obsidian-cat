# Obsidian Cat

Obsidian Cat is an Obsidian plugin for LLM-assisted research-vault maintenance with a bundled desktop cat companion.

The desktop cat experience is preserved: when Obsidian starts, the plugin can launch the packaged `Obsidian Cat.exe`, and the cat appears on the desktop for drag-and-drop feeding. Configuration now lives in the native Obsidian plugin settings page instead of a web console/onboarding page.

## Current Features

- Auto-start the bundled desktop cat runtime on Obsidian launch.
- Reuse an existing desktop cat when Obsidian reopens.
- Switch the native settings page between Chinese and English.
- Switch source-note body language between Chinese and English.
- Check the cat backend at `http://127.0.0.1:4317/api/status`.
- Open an Obsidian Cat task center from the ribbon.
- Configure Model API, MinerU API tokens, wiki architecture, and paths from Obsidian settings.
- Initialize or repair the vault structure without overwriting existing raw/wiki content.
- Draft a source note from the current parsed Markdown file.
- Audit source notes, topic titles, duplicate topics, and broken wiki links.
- Write audit reports to `wiki/syntheses/Vault Pipeline Audit.md`.
- Run without Python or a separate installer.
- Preserve paper-title source note filenames and the existing research-vault source-note schema with Key Figure Gallery support.

## Settings Page

The settings page is organized into five sections:

- Quick Start
- Model API
- MinerU API
- Wiki Architecture
- Advanced

Daily settings are visible directly. Advanced only keeps runtime path details.

`Interface language` changes the plugin settings UI. `Source-note body language` changes LLM-generated source note body text while keeping template headings in English.

## Full Tutorial

See:

```text
docs/中文快速开始.md
docs/USAGE.md
```

## Bundled Runtime

The plugin includes a portable companion runtime:

```text
companion/cat-vault-agent/Obsidian Cat.exe
```

This means users do not need to run the old standalone installer. Installing the plugin folder also installs the desktop cat runtime.

## Commands

- `Obsidian Cat: Open Obsidian Cat Center`
- `Obsidian Cat: Start Desktop Cat`
- `Obsidian Cat: Check Desktop Cat Status`
- `Obsidian Cat: Draft Source Note From Current Parsed Markdown`
- `Obsidian Cat: Audit Vault`

## Notes

- The local HTTP API is retained for the desktop cat and plugin internals, but the web console is not exposed as the primary UI.
- The plugin is desktop-only because it launches local processes and bundled executables.
- Core runtime features do not require Python.
