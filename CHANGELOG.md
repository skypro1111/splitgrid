# Changelog

## 1.2.0 — 2026-10-29

### Added

- **Git pane.** A native repository panel next to terminals, SFTP and SQL:
  commit graph with lanes, branches/tags/remotes, worktrees, and the working
  copy (stage, unstage, discard, commit) with a Monaco diff. It drives the real
  `git` binary, so your config, hooks and credential helpers behave exactly as
  in the terminal.
- **Agents can drive a tab in your real browser** via the companion Chrome
  extension (`extension/`, build with `npm run build:ext`, load unpacked). Pair
  it from **Settings → Agent integrations**, then activate a tab; the agent sees
  it as one more `sg-browser` target. Read-only by default — eval, navigation and
  interaction need the separate write opt-in. Off unless enabled.
- **Focus mode.** Expand one pane over the whole grid from its header (or the
  hotkey) without touching the layout; everything else keeps running.
- **Saved prompts.** A Prompts popover in the sidebar keeps reusable multi-line
  prompts per environment: click to paste into the focused terminal, ▶ to run.
- **SSH connection groups**, shared by Settings, the SSH connect pane and the
  SFTP chooser, and kept in sync across environment windows.
- **Window background colour** in Settings, clamped to a readable dark range.
- **SQL pane keeps sessions warm.** Switching database or connection hands back
  the open session instead of dropping it, so temp tables, `SET`s and open
  transactions survive; the connection ▸ database ▸ schema picker always
  targets the connection you chose.
- **Screenshots in todos.** A task can now carry images: paste one into the add
  input (or into a task while editing its text) and it is kept as a thumbnail on
  the item — click to view it full size, hover for the × to drop just that image.
  Text is optional, so a bare screenshot is a valid task.
  - The bitmap is stored by the main process under `userData/todo-images`, not
    the temp dir, so it survives a restart and lives exactly as long as the item:
    deleting the task (or clearing completed) deletes its files, and images
    pasted into a task that is never added are discarded with the draft.
  - Works the same on macOS, Windows and Linux. A screenshot normally arrives in
    the paste event, but where the platform hides the bitmap from it (some Linux
    desktops, TIFF-only macOS pasteboards) the panel falls back to reading the OS
    clipboard in the main process. PNG/JPEG are normalized to PNG; a WebP, GIF or
    BMP — what copying an image out of a browser or file manager often yields on
    Windows and Linux — is kept verbatim instead of being dropped.
  - **Run** hands the agent the image paths along with the text, the same
    shell-quoted-path convention as dragging an image onto the terminal. A WSL
    pane gets the `/mnt/<drive>/…` form; an SSH pane gets the text alone, since a
    local path means nothing to a remote shell.

### Fixed

- **Data loss.** Settings, workspaces, connections and known hosts are written
  atomically, so a crash mid-write can no longer leave a truncated file that
  loads as empty. Saved prompts and the Claude Code binary path are now actually
  persisted. A keychain that is unavailable for one session no longer replaces
  the key that encrypts saved passwords.
- **SSH.** A dropped connection (Wi-Fi, sleep) now reconnects instead of closing
  the pane; `exit` closes the connection instead of leaving it open on
  keepalive; a server that hangs up during login no longer leaves the pane
  stuck on "connecting". A terminal that fails to restore shows **Retry**
  instead of retrying in a loop.
- **Ghostty renderer.** `Ctrl+Shift+C` no longer also sends `^C` to the shell,
  and accepting the saved-password offer no longer sends a stray Enter.
  Terminals refit after a divider drag ends.
- **IDE.** A failed save keeps the tab open (and says so) instead of discarding
  the edits; text typed while a save is in flight stays unsaved; a reopened file
  is read fresh from disk instead of a stale cached copy.
- **SQL.** Dates and timestamps are shown as stored, not shifted by your time
  zone; an edit that matches no row fails instead of reporting success; "truncate
  then import" on MySQL can be rolled back; export file errors and server-side
  disconnects no longer crash the app; wide-table imports respect the driver's
  parameter limit.
- **Git.** Stage/unstage/discard treat paths literally — discarding
  `app/[id]/page.tsx` no longer touches `app/i/page.tsx`.
- **SFTP.** Large transfers no longer time out after 60 s while progressing.
- Closing a workspace stops its terminals; closing one window no longer stops
  file watching and auto-sync in the others.

### Security

- Links in model output can no longer open `file://` URLs (which could launch a
  local app).
- The CLI helpers pass their token and payload to `curl` on stdin rather than on
  the command line, where other local users could read them.

### Performance

- Dragging a divider no longer re-renders the whole window on every mouse move.
- Process metrics are scanned once for all windows instead of once per window.
- The WSL file bridge only runs on Windows, and `.splitgrid/workspace.json` is
  rewritten only when that workspace changed (and is no longer SFTP-synced).

## 1.1.0 — 2026-07-22

### Added

- **Agents can transfer files over SFTP** (`sg-sftp`). An agent running in a
  SplitGrid terminal previously had no way to move a file to or from a remote
  host — the SSH credentials live encrypted in the main process and never reach
  the shell, so `scp`/`rsync` cannot authenticate — and worked around it by
  base64-ing files through an SSH pane or standing up a web server. There is now
  a bridge with the same shape as the terminal and SQL ones: `targets`, `status`,
  `ls`, `stat`, `cat`, `get`, `send`, `push`, `pull`, `sync`, `mkdir`, `mv`, `rm`.
  Transfers run through the same IPC the UI uses, so nothing re-implements SFTP.
  - A target is either a configured **sync target** of the workspace (it has a
    remote root, so remote paths are confined to it) or the host of an **SSH
    pane** in that workspace (no invented root — the agent already has a shell
    there).
  - Two new opt-ins in **Settings → Agent integrations**, both off by default and
    both enforced in the main process: SFTP access at all, and permission to
    write to a remote. Reading and downloading work without the second.
  - Local paths are confined to the workspace directory, so `send ~/.ssh/id_rsa`
    is refused rather than uploaded; `rm` additionally requires `--force`.
  - Works from WSL terminals through the existing file bridge.

### Fixed

- **Keyboard shortcuts under non-latin layouts.** Chords were matched on the
  character the layout produces, so under a Ukrainian or Russian layout
  `Ctrl+Shift+C` arrived as `С` (U+0421) and copy, paste, ⌘K, Ctrl+W/R/N and the
  IDE chords silently did nothing at all — no error, no beep. They are now
  matched on the physical key position, while a latin character still wins where
  there is one (so Dvorak/Colemak keep matching the keycap).
- **Pasting a file copied in Explorer/Finder.** Copied files sit on the clipboard
  as file references and carry no text, so the paste did nothing. Their paths are
  now typed in, the same convention as dropping a file onto the terminal.
- **Pasting an image copied from a browser.** The clipboard then holds both the
  bitmap and the image's URL, and text won unconditionally — so the paste
  inserted a link instead of the picture. The image now wins when the text is
  nothing but a bare URL.
- **Pasting over SSH** prefers whatever text is on the clipboard to a `Ctrl-V`
  the remote CLI cannot act on.

### Docs

- The app logo now heads the README, in light and dark variants.

## 1.0.3 and earlier

See the git history — this changelog starts at 1.1.0.
