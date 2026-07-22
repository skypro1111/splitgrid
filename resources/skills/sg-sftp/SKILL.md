---
name: sg-sftp
description: Move files between this machine and the remote hosts of your SplitGrid workspace via $SPLITGRID_SFTP_CLI — list the reachable hosts, browse and read remote directories, download a file or directory, upload local files, run the workspace's SFTP sync (push/pull/sync now), and create/rename/delete remote paths. This is the ONLY correct way to transfer files here: ALWAYS use this skill instead of base64-ing a file through an SSH terminal, catting a heredoc into the remote shell, starting a web server / python -m http.server to fetch it, or reaching for scp/rsync/sftp binaries — those cannot use SplitGrid's saved (encrypted) SSH credentials. Read-only by default; uploads, sync and remote deletes need the user to enable "Allow agents to upload / change remote files". Triggers on ANY of: "upload / send / copy this file to the server", "deploy this build", "download / fetch / grab that file from the server", "get the remote log", "sync the workspace to the remote", "push / pull these files", "list what's in that remote directory", "read the remote config", "make / rename / delete a directory on the server".
---

# SplitGrid SFTP transfers

> **MANDATORY inside SplitGrid.** If `$SPLITGRID_SFTP_CLI` is set, you are in a
> SplitGrid terminal and this skill is the **required, first-choice** way to move
> a file to or from a remote host. Do **not** base64 a file through an SSH pane,
> heredoc it into the remote shell, or start an HTTP server to shuttle it — those
> workarounds exist only because agents had no transfer path. This is that path.

You are running inside a **SplitGrid** terminal. Its workspace knows about remote
hosts in two ways: **sync targets** (configured in the workspace's sync settings,
each with a remote root directory) and the hosts of **SSH terminal panes** open in
the workspace. This skill transfers files to and from those hosts using
SplitGrid's own saved credentials — which never enter your shell, and which
`scp`/`rsync` therefore cannot use.

The CLI is on your environment as **`$SPLITGRID_SFTP_CLI`**. Always invoke it
through that variable:

```sh
"$SPLITGRID_SFTP_CLI" <command> [args...]
```

If `$SPLITGRID_SFTP_CLI` is empty, you are not inside a SplitGrid terminal (or
SFTP access is off) and this skill does not apply.

Every call prints a single line of **JSON** to stdout: `{"ok":true, ...}` on
success, or `{"ok":false,"error":"...","message":"..."}` on failure. Parse it;
don't assume success.

## Scope and path rules — read this before your first call

- **Your workspace only.** You see the sync targets and SSH-pane hosts of the
  workspace holding your terminal. Nothing from another window or workspace.
- **Local paths are confined to the workspace directory.** They may be relative
  (resolved against it) or absolute inside it; anything that escapes — `../..`,
  `~/.ssh/id_rsa`, `/etc/...` — is refused with `path_out_of_scope`. This is not
  negotiable, so don't try to route around it.
- **Remote paths depend on the target kind.** On a **sync target** they are
  relative to its remote root and confined to it. On an **SSH-pane target**
  there is no configured root, so give an **absolute** path (`/srv/app/x`) —
  relative ones are refused as ambiguous.
- **Pick the host with `--target`** when `targets` lists more than one. With
  exactly one, it is used automatically.

Start with `targets` whenever you're unsure what you can reach:

```sh
"$SPLITGRID_SFTP_CLI" targets
```

## Read-only by default — uploads need the user's permission

Listing, reading and **downloading** work as soon as SFTP access is on. Anything
that **changes a remote host** — `send`, `push`, `sync`, `mkdir`, `mv`, `rm` — is
refused with `error:"write_not_allowed"` until the user enables **"Allow agents to
upload / change remote files"** in Settings → Agent integrations.

When you get `write_not_allowed`, **do not retry and do not work around it** (no
base64-through-the-shell, no web server) — STOP and **ASK the user** to enable it.
The capability is also advertised in your environment: **`$SPLITGRID_SFTP_WRITE=1`**
means writes are currently allowed (unset/empty means read-only).

## Command reference

```sh
"$SPLITGRID_SFTP_CLI" help                        # the authoritative command list

# Discover
"$SPLITGRID_SFTP_CLI" targets                     # hosts you can reach + which is the default
"$SPLITGRID_SFTP_CLI" status                      # sync config, per-target last sync + errors

# Look around (read)
"$SPLITGRID_SFTP_CLI" ls /srv/app                 # list a remote directory
"$SPLITGRID_SFTP_CLI" stat /srv/app/app.js        # size / mtime / is-it-a-directory
"$SPLITGRID_SFTP_CLI" cat /srv/app/config.yml     # read a remote TEXT file

# Bring files here (read)
"$SPLITGRID_SFTP_CLI" get /var/log/app.log        # into the workspace directory
"$SPLITGRID_SFTP_CLI" get /srv/app/dist logs/     # a directory, into a subdirectory

# Put files there (write)
"$SPLITGRID_SFTP_CLI" send dist/app.js /srv/app          # one file into a remote dir
"$SPLITGRID_SFTP_CLI" send a.js b.js dist/ /srv/app      # several paths; last arg is the remote dir

# Workspace sync (uses the configured targets, honours .gitignore)
"$SPLITGRID_SFTP_CLI" push src/ package.json      # push specific workspace paths (write)
"$SPLITGRID_SFTP_CLI" pull src/                   # pull them back down (read)
"$SPLITGRID_SFTP_CLI" sync                        # run the full workspace sync now (write)

# Remote housekeeping (write)
"$SPLITGRID_SFTP_CLI" mkdir /srv/app/releases
"$SPLITGRID_SFTP_CLI" mv /srv/app/x.js /srv/app/x.js.bak
"$SPLITGRID_SFTP_CLI" rm /srv/app/x.js.bak --force
```

Add `--target <name|number>` to any host command (`ls`, `stat`, `cat`, `get`,
`send`, `mkdir`, `mv`, `rm`) to choose the host — the name or the number from
`targets`. `push`/`pull`/`sync` never take one: they act on every enabled sync
target, exactly like the workspace's own sync.

## `send`/`get` vs `push`/`pull`

- **`send` / `get`** are one-shot transfers to an explicit remote directory. They
  work on any target, including an SSH-pane host with no sync configured. Use
  them for "put this build on the server", "grab that log".
- **`push` / `pull` / `sync`** drive the workspace's configured sync: paths are
  relative to the workspace root, `.gitignore` is honoured, and the remote
  location comes from each target's remote root. Use them for "sync my changes",
  and expect `sync_not_configured` when the workspace has no enabled sync target.

## Practical notes

- **Deleting is guarded.** `rm` without `--force` is refused; repeat with
  `--force` only when the user actually asked for a deletion.
- **Transfers report per-file errors, not exceptions.** Check `errors` in the
  reply: `{"ok":true,"transferred":3,"total":4,"errors":["…: Permission denied"]}`
  means one file failed. Tell the user rather than silently retrying.
- **`cat` is for text.** The reply carries `isBinary` and `truncated` — a large or
  binary file is not fully returned; `get` it instead.
- **Big transfers take time.** The bridge allows up to ~3 minutes per command; for
  a huge tree prefer `sync`/`push` (concurrent, resumable per file) over one giant
  `send`.
- **A pane is not required.** Transfers do not open or need an SFTP pane; they
  reuse the workspace's connection to that host.
