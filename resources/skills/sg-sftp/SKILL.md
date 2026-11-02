---
name: sg-sftp
description: Transfers files between this machine and the remote hosts of this SplitGrid workspace through $SPLITGRID_SFTP_CLI, using SplitGrid's saved SSH credentials - list reachable hosts, browse, stat and read remote files, download, upload, run the workspace SFTP sync (push, pull, sync now), and create, rename or delete remote paths. Use it whenever a file has to move to or from a server - deploying a build, fetching a remote log or config, syncing the workspace, checking what is in a remote directory - instead of scp, rsync, sftp, base64 through an SSH pane, a heredoc into the remote shell, or a temporary HTTP server, none of which can use the saved credentials. Read-only by default; uploads and remote changes need the user's permission in Settings. Requires a SplitGrid terminal ($SPLITGRID_SFTP_CLI set).
---

# SplitGrid SFTP transfers

This CLI moves files to and from the workspace's remote hosts with SplitGrid's
own saved credentials, which never enter the shell. It is the transfer path:
don't base64 a file through an SSH pane, heredoc it into a remote shell, or
start an HTTP server to shuttle it.

```sh
"$SPLITGRID_SFTP_CLI" <command> [args...]
```

If `$SPLITGRID_SFTP_CLI` is empty, this is not a SplitGrid terminal (or SFTP
access is off), and this skill does not apply. Each call prints one JSON line:
`{"ok":true, ...}` or `{"ok":false,"error":"...","message":"..."}`. Check `ok`
after every call.

## Rules

- **Read-only by default.** Listing, reading and downloading work once SFTP
  access is on. `send`, `push`, `sync`, `mkdir`, `mv` and `rm` change a remote
  host and are refused with `write_not_allowed` until the user enables "Allow
  agents to upload / change remote files" in Settings → Agent integrations.
  `$SPLITGRID_SFTP_WRITE=1` means writes are allowed.
- **On `write_not_allowed`, stop and ask** the user to enable it. Don't retry
  or work around it.
- **Local paths stay inside the workspace directory.** Relative paths resolve
  against it; anything that escapes (`../..`, `~/.ssh/id_rsa`, `/etc/...`) is
  refused with `path_out_of_scope`. Don't try to route around it.
- **Remote paths depend on the target.** On a **sync target** they are relative
  to its remote root and confined to it. On an **SSH-pane host** there is no
  root, so give an absolute path (`/srv/app/x`); relative ones are refused.
- **`rm` needs `--force`.** Add it only when the user actually asked for the
  deletion.

## Targets

The reachable hosts are the workspace's sync targets (each with a remote root)
and the hosts of its open SSH terminal panes. Start with `targets` when unsure:

```sh
"$SPLITGRID_SFTP_CLI" targets                     # hosts you can reach + the default
"$SPLITGRID_SFTP_CLI" status                      # sync config, per-target last sync + errors
```

With exactly one target it is used automatically. Otherwise add
`--target <name|number>` (from `targets`) to any host command: `ls`, `stat`,
`cat`, `get`, `send`, `mkdir`, `mv`, `rm`. `push`, `pull` and `sync` never take
one; they act on every enabled sync target, like the workspace's own sync.

## Commands

```sh
"$SPLITGRID_SFTP_CLI" help                        # the authoritative command list

"$SPLITGRID_SFTP_CLI" ls /srv/app                 # list a remote directory
"$SPLITGRID_SFTP_CLI" stat /srv/app/app.js        # size / mtime / directory or not
"$SPLITGRID_SFTP_CLI" cat /srv/app/config.yml     # read a remote text file

"$SPLITGRID_SFTP_CLI" get /var/log/app.log        # download into the workspace directory
"$SPLITGRID_SFTP_CLI" get /srv/app/dist logs/     # a directory, into a subdirectory

"$SPLITGRID_SFTP_CLI" send dist/app.js /srv/app          # upload one file into a remote dir (write)
"$SPLITGRID_SFTP_CLI" send a.js b.js dist/ /srv/app      # several paths; the last argument is the remote dir

"$SPLITGRID_SFTP_CLI" push src/ package.json      # push workspace paths via sync (write)
"$SPLITGRID_SFTP_CLI" pull src/                   # pull them back (read)
"$SPLITGRID_SFTP_CLI" sync                        # run the full workspace sync now (write)

"$SPLITGRID_SFTP_CLI" mkdir /srv/app/releases                  # (write)
"$SPLITGRID_SFTP_CLI" mv /srv/app/x.js /srv/app/x.js.bak       # (write)
"$SPLITGRID_SFTP_CLI" rm /srv/app/x.js.bak --force             # (write)
```

## `send`/`get` or `push`/`pull`

- **`send` / `get`** are one-shot transfers to an explicit remote directory.
  They work on any target, including an SSH-pane host with no sync configured.
  Use them for "put this build on the server" or "grab that log".
- **`push` / `pull` / `sync`** drive the workspace's configured sync: paths are
  relative to the workspace root, `.gitignore` is honoured, and each target's
  remote root decides where files go. Use them for "sync my changes". Expect
  `sync_not_configured` when the workspace has no enabled sync target.

## Notes

- **Transfers report per-file errors in the reply.** For example
  `{"ok":true,"transferred":3,"total":4,"errors":["…: Permission denied"]}`
  means one file failed. Tell the user rather than silently retrying.
- **`cat` is for text.** The reply carries `isBinary` and `truncated`; a large
  or binary file is not returned in full, so `get` it instead.
- **A command may run for up to about 3 minutes.** For a large tree, prefer
  `sync`/`push` (concurrent, resumable per file) over one huge `send`.
- **No SFTP pane is needed.** Transfers reuse the workspace's connection to
  the host.
