# Changelog

## Unreleased

### Added

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
