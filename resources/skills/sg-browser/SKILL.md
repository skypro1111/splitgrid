---
name: sg-browser
description: Control the embedded browser pane inside a SplitGrid terminal via $SPLITGRID_BROWSER_CLI — open a URL (localhost or remote), screenshot it, read console errors, inspect/extract the DOM, run JS, navigate, and click/fill/type/scroll through pages and forms. This is the ONLY way to drive a browser inside SplitGrid: ALWAYS use this skill for ANY browser or web-page work here, and never a generic browser-automation or Chrome MCP tool — those target a different browser, not the SplitGrid pane. Triggers on ANY of: build/change/debug a web UI and want to SEE the result instead of guessing; "open the browser", "check the page", "screenshot it", "verify in the browser", "test localhost", "click/fill/type on the page", "read the console", "extract/scrape the DOM", "automate the browser".
disallowed-tools: mcp__claude-in-chrome__*
---

# SplitGrid browser control

> **MANDATORY inside SplitGrid.** If `$SPLITGRID_BROWSER_CLI` is set, you are in a
> SplitGrid terminal and this skill is the **required, first-choice** tool for any
> browser/web-page work. Use it before anything else and do not fall back to
> generic browser-automation or Chrome MCP tools — they drive a different browser.

You are running inside a **SplitGrid** terminal, which has an embedded Chromium
browser pane you can drive from the shell to verify your work — open a page,
screenshot it, read the console, inspect the DOM, and interact with it.

**Use THIS skill — not any other browser tool — for every browser interaction in
this terminal.** Other browser-automation / Chrome MCP tools drive a *different*
browser, not the SplitGrid pane, so they won't affect what you're verifying here.
While this skill is active those tools are disabled; always reach for
`$SPLITGRID_BROWSER_CLI`.

The CLI is already on your environment as **`$SPLITGRID_BROWSER_CLI`**. Always invoke
it through that variable:

```sh
"$SPLITGRID_BROWSER_CLI" <command> [args...]
```

If `$SPLITGRID_BROWSER_CLI` is empty, you are not inside a SplitGrid terminal and this
skill does not apply.

Every call prints a single line of **JSON** to stdout:
`{"ok":true, ...}` on success, or `{"ok":false,"error":"...","message":"..."}` on
failure. Parse it; don't assume success.

## The verification loop (the common case)

After you change a web app, confirm it actually works:

```sh
# 1. Open the page (creates the browser pane if none exists, and you own it)
"$SPLITGRID_BROWSER_CLI" open http://localhost:3000

# 2. Wait for it to be ready, then look at it
"$SPLITGRID_BROWSER_CLI" wait load
"$SPLITGRID_BROWSER_CLI" screenshot          # -> {"ok":true,"screenshot":"/.../r12.png"}

# 3. Read the screenshot file with your normal file-reading tool to SEE the page.
# 4. Check for runtime errors and assert state:
"$SPLITGRID_BROWSER_CLI" get console         # -> recent console messages incl. errors
"$SPLITGRID_BROWSER_CLI" eval "document.querySelector('h1')?.textContent"
```

`screenshot` returns a PNG **path** — open that file to view it. `get console`
surfaces JS errors you'd otherwise miss. `eval` runs JS in the page and returns
the result, so you can assert exact DOM/state.

## Targets: ref OR CSS selector

Every action command takes a **target** that is either a snapshot **ref**
(`e1`, `e2`, … from `snapshot`) **or a raw CSS selector** (`#login`, `.btn`,
`input[name=email]`). So you can act without a snapshot when you already know the
selector, or use refs after a `snapshot` when you don't.

## Command reference

Navigate / inspect:
- `list` — browsers in this workspace and which one you own
- `open|navigate|goto <url>` — focus your browser (or create one) and load `<url>`
- `close [all]` — close your browser pane (or `close all` to close every one you own)
- `pushstate <url>` — SPA client-side navigation (`history.pushState`, no reload)
- `back` · `forward` · `reload`
- `get url` · `get title` · `get text` · `get html` · `get console`
- `get text|html|value|attr|count|box <selector> [attr]` — read a SPECIFIC element
  (`get value #email`, `get attr a.logo href`, `get count li.item`, `get box #app`)
- `is visible|enabled|checked <selector>` — boolean state check
- `screenshot [--full]` — capture; returns `{"screenshot":"<png path>"}` (`--full` = whole page)
- `pdf` — export the page to PDF; returns `{"pdf":"<path>"}`
- `eval <js>` — run JS in the page; returns `{"result": ...}`

Interact (drive a form / flow):
- `snapshot [--viewport]` — tag interactive elements and return refs (`e1`, `e2`, …)
- `click <target>` · `dblclick <target>` · `hover <target>` · `focus <target>`
- `fill <target> <text>` — set an input/textarea value
- `type <text>` — type into the currently focused field
- `press <key> [target]` — a REAL keypress: `press Enter`, `press Tab`, `press Escape`,
  `press Control+a`, `press ArrowDown` (focuses `target` first if given)
- `select <target> <value>` — choose a `<select>` option
- `check <target>` · `uncheck <target>` — toggle a checkbox/radio
- `scroll up|down|left|right [px]` · `scrollintoview <target>`
- `find <text|role|label|placeholder|testid|selector> <query> <action> [value]` —
  locate ONE element semantically and act in one shot (action: click/fill/check/
  uncheck/hover/focus/text), e.g. `find text "Sign in" click`, `find label Email fill me@x.com`

Synchronize (always wait before asserting after a navigation/action):
- `wait load` — wait for the page to finish loading
- `wait selector <css>` — wait until an element appears
- `wait text <substring>` — wait until text appears on the page
- `wait url <substring|regex>` — wait until the URL matches (e.g. after a redirect)
- `wait fn <js>` — wait until a JS expression is truthy (`wait fn "window.__ready===true"`)
- `wait <ms>` — fixed pause
- add `--timeout <ms>` to the polling waits (default 10s, max 30s)

State / storage:
- `storage local|session [get [key] | set <k> <v> | clear]` — web storage
- `cookies [list|clear]` — cookies in this browser's session
- `clipboard read|write [text]` — system clipboard
- `set viewport <w> <h>` · `set viewport reset` — device-size emulation

Network (capture requests while reproducing a bug):
- `network start` → reproduce → `network list` (statuses, types, failures) → `network stop` → `network clear`

Flags:
- `--target <surface>` — pick a specific browser when you own more than one
  (`surface` is the id returned by `open`/`list`)
- `--full` (screenshot) — capture the entire page, not just the viewport
- `--timeout <ms>` — cap for the polling `wait` commands (default 10s, max 30s)

## Interacting with a form — example

```sh
"$SPLITGRID_BROWSER_CLI" open http://localhost:5173/login
"$SPLITGRID_BROWSER_CLI" wait selector "form"
"$SPLITGRID_BROWSER_CLI" snapshot              # -> refs for the inputs/buttons
"$SPLITGRID_BROWSER_CLI" fill e3 "user@example.com"
"$SPLITGRID_BROWSER_CLI" fill e4 "hunter2"
"$SPLITGRID_BROWSER_CLI" click e5              # submit
"$SPLITGRID_BROWSER_CLI" wait text "Welcome"
"$SPLITGRID_BROWSER_CLI" screenshot
```

`snapshot` first — refs (`e1`, `e2`, …) come from it and are what `click`/`fill`/
`select` resolve. If the page changed, take a fresh `snapshot`.

## Ownership (when there are several browsers)

The browser you `open` becomes **yours** (bound to this terminal). Commands with
no `--target` act on your browser. If you own more than one, the CLI returns
`ambiguous_target` with the list — re-run with `--target <surface>`. It never
silently picks the wrong one.

## Tips

- One command per call; chain them in sequence, checking `ok` each time.
- Always `wait load` (or `wait selector`/`wait text`) after `open`/`click` before
  you `screenshot`, `get`, or `eval` — otherwise you read a half-rendered page.
- Prefer `eval`/`get console` for precise assertions; use `screenshot` to actually
  look when layout or visual state matters.
- Run `"$SPLITGRID_BROWSER_CLI" help` for the authoritative command list.
