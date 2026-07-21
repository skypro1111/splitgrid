<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/logos/readme/logo-dark.png">
    <img src="public/logos/readme/logo-light.png" alt="SplitGrid" width="96" height="96">
  </picture>
</p>

<h1 align="center">SplitGrid</h1>

<p align="center">
  A workspace terminal manager for the age of coding agents.<br>
  <a href="https://splitgrid.dev">splitgrid.dev</a>
</p>

---

A workspace-oriented terminal manager built with Electron + React. SplitGrid packs
SSH and local terminals, a Postgres SQL client, a Monaco-based code editor,
embedded browser panes, and an AI quick-chat into a single tiling, drag-and-drop
workspace — designed around running and supervising coding agents (Claude, Codex,
Cursor) across many sessions at once.

---

## Highlights

- **Tiling grid workspaces** — split panes horizontally/vertically, drag to
  rearrange and swap, zoom a single pane, and keep multiple independent
  workspaces in a sidebar. Layout, panes and zoom levels are persisted.
- **Terminals** — SSH and local shells, each in its own pane.
  - Two renderers: **xterm** and **ghostty** (switchable per terminal).
  - Live **process tree** and resource metrics (CPU/RSS) per session.
  - **Listening-port** detection with one-click open / kill of the holding
    process — cross-platform (host PIDs, `taskkill` on Windows, in-distro PIDs
    for WSL).
  - **WSL** support on Windows (metrics, path/encoding handling).
- **SSH** — saved connections (encrypted credentials), connection testing, and
  an opt-in **saved-password hint**: when a `sudo`/login password prompt is
  detected, SplitGrid offers to inject the saved password (confirm-to-send; the
  password never leaves the main process).
- **SQL client** (PostgreSQL) — connect to saved databases, browse the schema
  tree, run queries in tabbed editors, view results in a data grid, and keep
  per-connection query history.
- **Code editor** — a Monaco-based IDE pane with a file tree, tabs, and live
  file watching.
- **Browser panes** — embedded web views inside the grid, including an
  automation bridge so an agent running in a terminal can open/navigate/
  screenshot/inspect its own browser pane.
- **Fast chat** — a command-palette AI assistant (see below).
- **Agent awareness** — detects agent activity (Working / Waiting / Done) via
  lifecycle hooks and terminal output, with completion notifications.
- **Per-workspace notes & to-do list** — quick scratch notes and a lightweight
  task list attached to each workspace, edited from the sidebar.
- **Workspace sync** — push files to remote targets over SFTP (with
  `.gitignore` awareness and an auto-sync watcher).
- **Freeze / unfreeze** — suspend a background workspace's local process trees
  (`SIGSTOP`) to stop them burning CPU; resume on demand (macOS/Linux).
- **Notifications** — play a sound when a terminal finishes in the background or
  while the window is unfocused, with global defaults and per-workspace
  overrides.
- **Multi-window workspace sets** — open additional windows, each driving its
  own set of workspaces.

---

## Fast chat

A quick-question AI palette for things like *“how do I unpack a tar.gz on
Linux”* — minimal friction, answer right where you are.

- **Open from anywhere** with a hotkey (default **⌘K / Ctrl+K**). The keystroke
  is intercepted in the main process, so it works no matter which inner surface
  has focus — a terminal, the editor, or a browser pane. The hotkey is
  **configurable and recordable** in Settings.
- **Any OpenAI-compatible endpoint** — OpenAI, OpenRouter, Groq, a local Ollama
  (`/v1`), LM Studio, or **Google Gemini** (`…/v1beta/openai/`, pre-filled by
  default). Configure base URL, API key, model, temperature, reasoning effort
  and an optional system prompt. **The API key stays in the main process.**
- **Streaming markdown answers** in a chat layout (your message right, the
  assistant left), with **copy buttons** on code blocks.
- **History** — the last *N* conversations (configurable) are persisted and
  browsable from the palette; reopen and continue any of them.
- **Resume window** — after closing, a chat stays resumable for a configurable
  grace period so you can pop back in and continue.
- A single **Save** button in Settings commits all changes (structural
  dirty-detection — Save only lights up on a real change).

---

## Tech stack

- **Electron 41**, **React 19**, **TypeScript**, **Vite** (via Electron Forge).
- Terminals: `@xterm/xterm` + addons, `ghostty-web`, `node-pty`, `ssh2`.
- SQL: `pg`. Editor: `monaco-editor`. Layout: `react-grid-layout`,
  `react-complex-tree`. Markdown: `react-markdown` + `remark-gfm`.

---

## Getting started

Requirements: Node.js 20+ and npm. Native modules (`node-pty`, `ssh2`) are built
on install.

```bash
npm install
npm start          # launch the app in development (Electron Forge + Vite)
```

### Quality gates

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest unit suite
npm run test:e2e   # Playwright end-to-end (launches the real app)
```

---

## Building

Package the app (no installer) or build distributables for a platform:

```bash
npm run package -- --platform=darwin            # .app bundle
npm run make    -- --platform=darwin            # zip / installers
```

Makers configured (`forge.config.ts`): **Squirrel** (Windows `.exe` installer),
**ZIP** (macOS / Windows / Linux portable), **deb** and **rpm**.

### Portable Windows build from macOS/Linux

The Squirrel installer needs Wine + Mono (or a Windows runner). For a portable
Windows app without an installer, build only the ZIP maker — no Wine required:

```bash
npm run make -- --platform=win32 --arch=x64 --targets=@electron-forge/maker-zip
# → out/make/zip/win32/x64/SplitGrid-win32-x64-<version>.zip   (unzip, run SplitGrid.exe)
```

> Native modules are cross-platform: `node-pty` bundles per-platform prebuilds
> and resolves the correct one at runtime. For a fully verified release, build on
> the target OS (or CI) so the native binaries are compiled there.

### Regenerate the macOS icon (`build/icon.icns`) from `public/logo.svg`

```bash
python3 -c "from pathlib import Path; s=Path('public/logo.svg').read_text(); ins='<rect width=\"512\" height=\"512\" fill=\"black\"/>\n  '; s=s if ins.strip() in s else s.replace('xmlns=\"http://www.w3.org/2000/svg\">\n', 'xmlns=\"http://www.w3.org/2000/svg\">\n  '+ins, 1); Path('build/icon.svg').write_text(s)" && \
mkdir -p "build/icon.iconset" && \
qlmanage -t -s 1024 -o "build" "build/icon.svg" >/dev/null && \
cp "build/icon.svg.png" "build/icon-1024.png" && \
sips -z 16 16 "build/icon-1024.png" --out "build/icon.iconset/icon_16x16.png" >/dev/null && \
sips -z 32 32 "build/icon-1024.png" --out "build/icon.iconset/icon_16x16@2x.png" >/dev/null && \
sips -z 32 32 "build/icon-1024.png" --out "build/icon.iconset/icon_32x32.png" >/dev/null && \
sips -z 64 64 "build/icon-1024.png" --out "build/icon.iconset/icon_32x32@2x.png" >/dev/null && \
sips -z 128 128 "build/icon-1024.png" --out "build/icon.iconset/icon_128x128.png" >/dev/null && \
sips -z 256 256 "build/icon-1024.png" --out "build/icon.iconset/icon_128x128@2x.png" >/dev/null && \
sips -z 256 256 "build/icon-1024.png" --out "build/icon.iconset/icon_256x256.png" >/dev/null && \
sips -z 512 512 "build/icon-1024.png" --out "build/icon.iconset/icon_256x256@2x.png" >/dev/null && \
sips -z 512 512 "build/icon-1024.png" --out "build/icon.iconset/icon_512x512.png" >/dev/null && \
cp "build/icon-1024.png" "build/icon.iconset/icon_512x512@2x.png" && \
iconutil -c icns "build/icon.iconset" -o "build/icon.icns"
```

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **⌘K / Ctrl+K** | Toggle Fast chat (configurable) |
| **⌘⇧N / Ctrl+Shift+N** | Open a new workspace window |
| **Esc** | Close the open modal / Fast chat |
| In a terminal: **Ctrl+L** | Clear the screen |
| In a terminal: **⌘←/→**, **⌘↑/↓**, **⌘A**, **⌘C** | Line nav, history, select-all, copy |

---

## Where data lives

App settings, saved connections and Fast chat history are stored in the
Electron `userData` directory (e.g. `~/Library/Application Support/SplitGrid/` on
macOS): `app-settings.json`, `quick-chat-history.json`, and the connection
stores. Secrets (SSH passwords, the Fast chat API key) are kept in the main
process and are not exposed to the renderer beyond the settings form.

---

## Project layout

```
src/
  main.ts                 # Electron main: windows, menu, global shortcuts
  main/                   # terminal/SSH/SQL managers, stores, agent bridges, fast chat
  preload.ts              # contextBridge API surface
  renderer/               # React app
    components/            # grid, terminals, SQL, IDE, browser, settings, Fast chat
    hooks/                 # workspace, terminals, settings, fast chat, …
  shared/types.ts         # shared types between main and renderer
e2e/                      # Playwright smoke + feature tests
```

---

## License

[GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).

SplitGrid is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for the full text.

The application bundles third-party open-source components (Monaco Editor, xterm,
React, node-pty, ssh2, and others). Their copyright notices and licenses — all
permissive and AGPLv3-compatible — are reproduced in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
