---
name: sg-terminal
description: Inspect and drive the OTHER terminals open in your SplitGrid workspace via $SPLITGRID_TERMINAL_CLI — list the workspace's terminals, read their recent output, see their running process tree, type commands or keystrokes into them (including Ctrl-C and other control keys), and open new terminals (local or SSH from a saved connection) or close existing ones. Use this to coordinate work across panes: open a dedicated terminal for a task, start or restart a dev server / build / test watcher running in a sibling terminal, read what another terminal printed (errors, logs, prompts), answer an interactive prompt in another pane, stop a runaway process, or close a pane when done. You can also message and drive another agent (e.g. a Claude Code running in a sibling pane) — but submit its prompt with ctrl-m, not Enter (see the skill body). Scope is your own workspace only — you cannot see or touch terminals in other workspaces. Triggers on ANY of: "run X in the other terminal", "check what the server/build/test pane printed", "read the logs from the other terminal", "restart the dev server", "stop / Ctrl-C the process in pane N", "answer the prompt in the other terminal", "what's running in the other terminal", "send a message to / control the embedded Claude (Code) in the other pane", "open a new terminal / SSH terminal", "close that terminal / pane".
---

# SplitGrid terminal control

> **MANDATORY inside SplitGrid.** If `$SPLITGRID_TERMINAL_CLI` is set, you are in a
> SplitGrid terminal and this skill is the **required, first-choice** tool for
> seeing or driving sibling terminal panes. Use it before anything else — it is
> the only way to reach the other panes in this workspace.

You are running inside a **SplitGrid** terminal. A workspace can hold several
terminal panes side by side (e.g. one running a dev server, one a test watcher,
one for you). This skill lets you **see and drive the other terminals in your
workspace** from the shell — list them, read their output, inspect their
processes, and send them text or keystrokes.

The CLI is on your environment as **`$SPLITGRID_TERMINAL_CLI`**. Always invoke it
through that variable:

```sh
"$SPLITGRID_TERMINAL_CLI" <command> [args...]
```

If `$SPLITGRID_TERMINAL_CLI` is empty, you are not inside a SplitGrid terminal and this
skill does not apply.

Every call prints a single line of **JSON** to stdout: `{"ok":true, ...}` on
success, or `{"ok":false,"error":"...","message":"..."}` on failure. Parse it;
don't assume success.

**Scope:** you can only see and act on terminals in **your own workspace**. A
target id from another workspace (or a closed terminal) is rejected with
`out_of_scope`. Run `list` to discover the ids you may use.

## Discover the terminals

```sh
"$SPLITGRID_TERMINAL_CLI" list
# -> {"ok":true,"workspace":"api","terminals":[
#      {"id":"a1b2…","label":"server","type":"local","status":"connected","cwd":"/srv","mine":false},
#      {"id":"c3d4…","label":"you","type":"local","status":"connected","cwd":"/srv","mine":true}]}
```

`mine:true` marks the terminal you are running in. Use the `id` of another
terminal as the target for every command below.

## Read what a terminal printed

```sh
"$SPLITGRID_TERMINAL_CLI" read <id>                # last 200 lines (ANSI stripped)
"$SPLITGRID_TERMINAL_CLI" read <id> --tail 40      # last 40 lines
"$SPLITGRID_TERMINAL_CLI" info <id>                # label, status, cwd, shell, type
"$SPLITGRID_TERMINAL_CLI" tree <id>                # live process tree (local terminals)
```

`read` returns the recent scrollback with the noisiest ANSI removed so it's easy
to scan for errors, build results, or an interactive prompt waiting for input.

## Drive a terminal

```sh
# Run a command in another pane (types the text and presses Enter):
"$SPLITGRID_TERMINAL_CLI" send <id> "npm run dev"

# Type text WITHOUT Enter (e.g. to fill an interactive prompt before confirming):
"$SPLITGRID_TERMINAL_CLI" type <id> "y"

# Send a key or control combo:
"$SPLITGRID_TERMINAL_CLI" key <id> enter
"$SPLITGRID_TERMINAL_CLI" key <id> ctrl-c          # stop the running process
"$SPLITGRID_TERMINAL_CLI" key <id> up              # recall the previous command
```

Supported key names: `enter`, `tab`, `esc`, `space`, `backspace`, `delete`,
`up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, and any
control combo as `ctrl-<letter>` (e.g. `ctrl-c`, `ctrl-d`, `ctrl-z`, `ctrl-l`).

## Open and close terminals

You can add and remove terminal panes in your workspace.

```sh
# Open a new LOCAL terminal (optionally give it a label). Returns its id:
"$SPLITGRID_TERMINAL_CLI" open                       # -> {"ok":true,"id":"…","type":"local","opened":true}
"$SPLITGRID_TERMINAL_CLI" open build                 # labelled "build"

# Open an SSH terminal from a SAVED connection (by name or id):
"$SPLITGRID_TERMINAL_CLI" connections                # list saved SSH connections first
# -> {"ok":true,"connections":[{"id":"…","label":"prod","host":"1.2.3.4","username":"deploy"}]}
"$SPLITGRID_TERMINAL_CLI" open ssh prod              # -> {"ok":true,"id":"…","type":"ssh","connection":"prod"}

# Close a terminal (kills the session AND removes its pane):
"$SPLITGRID_TERMINAL_CLI" close <id>
```

The new terminal opens in **your** workspace and is immediately drivable — use the
returned `id` with `read`/`send`/`key`. SSH terminals require a connection already
saved in SplitGrid (you can't pass a host/password here — run `connections` to see
what's available, and ask the user to add one if the list is empty). A fresh local
terminal starts in the workspace's working directory.

## Typical patterns

**Restart a dev server running in another pane:**
```sh
"$SPLITGRID_TERMINAL_CLI" list                     # find the server terminal's id
"$SPLITGRID_TERMINAL_CLI" key  <id> ctrl-c         # stop it
"$SPLITGRID_TERMINAL_CLI" send <id> "npm run dev"  # start it again
"$SPLITGRID_TERMINAL_CLI" read <id> --tail 30      # confirm it came back up
```

**Check why a sibling build/test pane failed:**
```sh
"$SPLITGRID_TERMINAL_CLI" read <id> --tail 60      # read the error output
```

**Answer an interactive prompt in another terminal:**
```sh
"$SPLITGRID_TERMINAL_CLI" read <id> --tail 10      # see the question
"$SPLITGRID_TERMINAL_CLI" send <id> "yes"          # respond + Enter
```

**Open a dedicated pane for a long-running task, then clean it up:**
```sh
id=$("$SPLITGRID_TERMINAL_CLI" open logs | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
"$SPLITGRID_TERMINAL_CLI" send "$id" "tail -f var/log/app.log"
# … later …
"$SPLITGRID_TERMINAL_CLI" close "$id"              # kills it + removes the pane
```

## Controlling an embedded Claude Code (or other TUI agent)

When the other pane runs **Claude Code** (or a similar full-screen TUI agent such
as Codex), its input box treats **Enter as a newline inside the prompt**, not as
"send". Submitting the message is bound to **`ctrl-m`** (a carriage return). So
`send` and `key enter` (which deliver a line feed) will only add a blank line —
the message just sits in the box, unsent.

**To send a message to an embedded Claude, `type` the text, then `key ... ctrl-m`
— never `enter`:**

```sh
# WRONG — `send`/`enter` insert a newline; the message is never submitted:
#   "$SPLITGRID_TERMINAL_CLI" send <id> "run the tests"

# RIGHT — type the message, then submit with ctrl-m:
"$SPLITGRID_TERMINAL_CLI" type <id> "run the tests and summarize failures"
"$SPLITGRID_TERMINAL_CLI" key  <id> ctrl-m            # submits the prompt

# Give it a moment, then read what it's doing:
"$SPLITGRID_TERMINAL_CLI" read <id> --tail 40
```

Use the same `type` → `key <id> ctrl-m` pattern for any prompt that pane shows
(e.g. answering a permission question): `ctrl-m` is the reliable "submit" for
these TUIs. Plain shells accept either, so `send`/`enter` remain fine for an
ordinary shell pane — `ctrl-m` only matters when driving a TUI agent like Claude.

## Notes

- To drive an embedded **Claude Code** (or other TUI agent), submit with
  **`ctrl-m`**, not `enter` — see the section above.
- `send`/`type`/`key` write into a **real shell** — they run with the same power
  as the person sitting at that terminal. Read the pane first when unsure, and
  don't fire destructive commands into another terminal without good reason.
- `close` **kills** the terminal and removes its pane — don't close a pane that's
  doing the user's work, and avoid closing your OWN terminal (the one you run in,
  marked `mine:true`), which would end your session.
- `open ssh` needs a connection saved in SplitGrid; you cannot supply a host or
  password through this skill. Run `connections` to see what's available.
- `read` is a best-effort text view of the scrollback, not a pixel-perfect
  render; cursor-redraw UIs (full-screen TUIs) may read messily.
- `tree` is empty for SSH terminals (their processes run on the remote host).
- This skill drives SplitGrid terminals only. It does not replace your normal
  ability to run commands in your own shell — use it for the *other* panes.
