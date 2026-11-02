---
name: sg-terminal
description: Reads and drives the terminal panes of this SplitGrid workspace through $SPLITGRID_TERMINAL_CLI - list them, read their recent output, see their process tree, type commands or keys (Ctrl-C included) into them, and open or close local or SSH terminals in the agent's own zone of the layout. Use it whenever work involves a pane other than this one - a dev server, build, test watcher or log running beside it, an error or prompt printed there, restarting or stopping a process, messaging a Claude Code CLI or other TUI agent in a sibling terminal - and to open a small tray pane for a long-running process the user wants to watch. Simple background jobs may stay background Bash jobs. Any work on a remote host goes through an SSH terminal pane opened here, never ssh from Bash. Subagents included. One-shot commands for this shell run directly. Requires a SplitGrid terminal ($SPLITGRID_TERMINAL_CLI set), and reaches only this workspace's terminals.
---

# SplitGrid terminal control

A SplitGrid workspace can hold several terminal panes side by side (a dev
server, a test watcher, this one). This CLI lists them, reads their output,
inspects their processes, sends them text or keys, and opens or closes panes
in this agent's zone.

```sh
"$SPLITGRID_TERMINAL_CLI" <command> [args...]
```

If `$SPLITGRID_TERMINAL_CLI` is empty, this is not a SplitGrid terminal, and
this skill does not apply. Each call prints one JSON line: `{"ok":true, ...}` or
`{"ok":false,"error":"...","message":"..."}`. Check `ok` after every call.

## Rules

- **SSH always gets its own pane.** To run anything on a remote host,
  `open ssh <connection>` and drive that terminal with `send` and `read`.
  Never run `ssh` (or `ssh host cmd`) from Bash or as a background job: it
  can't use SplitGrid's saved credentials, and the user can't see or take
  over the session.
- **Simple background jobs may stay in the background.** A dev server,
  watcher or `tail -f` that only has to keep running can be a background Bash
  job (`run_in_background`). Open a tray pane with `open <label> --background`
  instead when the user asks to see it, or it must outlive this session.
  Background panes sit in a thin strip along the zone's bottom.
- **Panes open in this agent's zone.** The first `open` splits this terminal
  and starts the zone. Every later pane, including browser and SQL panes from
  the sibling CLIs, goes inside it. See [Zones](#zones).
- **A subagent passes `--zone <name>`** on `open`, `close`, `list` and `zone`,
  using the same short name on every call (the task, like `review` or
  `e2e-login`). Subagents share the parent's terminal, so without it they all
  land in the parent's zone. When delegating, tell the subagent its zone name.
- **Submit to Claude Code (or another TUI agent) with `ctrl-m`, never Enter.**
  Its input box treats Enter as a newline, so `send` and `key enter` leave the
  message unsent. Use `type`, then `key <id> ctrl-m`.
- **`send`, `type` and `key` write into a real shell** with the same power as
  the person at that terminal. Read the pane first when unsure, and don't send
  destructive commands to another terminal without good reason.
- **`close` works only on panes in this agent's zone.** It kills the session
  and removes the pane. Anything else (the user's panes, this terminal) is
  refused with `not_in_zone`; ask the user to close it.
- **Scope is this workspace.** An id from another workspace, or a closed
  terminal, is rejected with `out_of_scope`. Get ids from `list`.

## Discover

```sh
"$SPLITGRID_TERMINAL_CLI" list
# -> {"ok":true,"workspace":"api","terminals":[
#      {"id":"a1b2…","label":"server","type":"local","status":"connected","cwd":"/srv","mine":false,"inZone":true},
#      {"id":"c3d4…","label":"you","type":"local","status":"connected","cwd":"/srv","mine":true,"inZone":false}]}
```

`mine:true` marks this terminal and `inZone:true` the panes this agent opened.
Use another terminal's `id` as the target of every command below.

## Read

```sh
"$SPLITGRID_TERMINAL_CLI" read <id>                # last 200 lines, noisy ANSI stripped
"$SPLITGRID_TERMINAL_CLI" read <id> --tail 40      # last 40 lines
"$SPLITGRID_TERMINAL_CLI" info <id>                # label, status, cwd, shell, type
"$SPLITGRID_TERMINAL_CLI" tree <id>                # live process tree (local terminals only)
```

`read` is a best-effort text view of the scrollback. Full-screen TUIs that
redraw the cursor may read messily. `tree` is empty for SSH terminals, whose
processes run on the remote host.

## Drive

```sh
"$SPLITGRID_TERMINAL_CLI" send <id> "npm run dev"  # type the text and press Enter
"$SPLITGRID_TERMINAL_CLI" type <id> "y"            # type without Enter
"$SPLITGRID_TERMINAL_CLI" key <id> enter
"$SPLITGRID_TERMINAL_CLI" key <id> ctrl-c          # stop the running process
"$SPLITGRID_TERMINAL_CLI" key <id> up              # recall the previous command
```

Key names: `enter`, `tab`, `esc`, `space`, `backspace`, `delete`, `up`, `down`,
`left`, `right`, `home`, `end`, `pageup`, `pagedown`, and `ctrl-<letter>`
(`ctrl-c`, `ctrl-d`, `ctrl-z`, `ctrl-l`, `ctrl-m`).

## Message a Claude Code (or other TUI agent) pane

```sh
"$SPLITGRID_TERMINAL_CLI" type <id> "run the tests and summarize failures"
"$SPLITGRID_TERMINAL_CLI" key  <id> ctrl-m         # submits the prompt
"$SPLITGRID_TERMINAL_CLI" read <id> --tail 40      # after a moment, see what it's doing
```

Answer that pane's prompts (a permission question, say) the same way: `type`,
then `ctrl-m`. Plain shells accept either, so `send` is fine there.

## Open and close

```sh
"$SPLITGRID_TERMINAL_CLI" open                     # new local terminal -> {"ok":true,"id":"…","type":"local","opened":true,"zone":"main"}
"$SPLITGRID_TERMINAL_CLI" open build               # labelled "build"
"$SPLITGRID_TERMINAL_CLI" connections              # saved SSH connections
# -> {"ok":true,"connections":[{"id":"…","label":"prod","host":"1.2.3.4","username":"deploy"}]}
"$SPLITGRID_TERMINAL_CLI" open ssh prod            # SSH terminal from a saved connection (name or id)
"$SPLITGRID_TERMINAL_CLI" close <id>               # a pane in this agent's zone
```

A new terminal starts in the workspace's working directory and is drivable at
once with the returned `id`. SSH needs a connection already saved in
SplitGrid; a host or password can't be passed here. If `connections` is empty,
ask the user to add one.

## Zones

Each agent gets one framed region of the layout for the panes it opens. The
first pane splits this terminal and starts the zone. Each later pane splits
the zone's last pane, so the zone reads in the order panes were opened,
alternating right and down unless told otherwise:

```sh
"$SPLITGRID_TERMINAL_CLI" open server                        # starts the zone beside this terminal
"$SPLITGRID_TERMINAL_CLI" open tests --split down            # below the last pane
"$SPLITGRID_TERMINAL_CLI" open ssh prod --at <id> --split right   # beside a chosen zone pane
"$SPLITGRID_TERMINAL_CLI" zone                               # the zone's panes, in order
# -> {"ok":true,"zone":"main","panes":[{"id":"…","type":"terminal"},{"id":"…","type":"terminal","background":true}]}
"$SPLITGRID_TERMINAL_CLI" open dev --background               # in the zone's tray strip
"$SPLITGRID_TERMINAL_CLI" open --zone review                 # a subagent's own zone
```

- `--split right|down` places the new pane beside or below its target.
- `--at <id>` picks which zone pane to split; ids outside the zone are refused
  with `not_in_zone`.
- `--background` (`--bg`) puts the pane in the zone's tray, a thin strip
  along its bottom where background processes line up left to right. Use it
  for anything that just has to keep running; regular panes are for work the
  user will read or interact with.
- `--zone <name>` selects a zone other than the default `main`. Use the same
  name with `$SPLITGRID_BROWSER_CLI` and `$SPLITGRID_SQL_CLI` so their panes join it.
- Close panes that are no longer needed. Leave the ones whose output the user
  may want, such as a running dev server.

## Patterns

Restart a dev server in another pane:
```sh
"$SPLITGRID_TERMINAL_CLI" list                     # find the server terminal's id
"$SPLITGRID_TERMINAL_CLI" key  <id> ctrl-c
"$SPLITGRID_TERMINAL_CLI" send <id> "npm run dev"
"$SPLITGRID_TERMINAL_CLI" read <id> --tail 30      # confirm it came back up
```

Answer an interactive prompt in another shell:
```sh
"$SPLITGRID_TERMINAL_CLI" read <id> --tail 10      # see the question
"$SPLITGRID_TERMINAL_CLI" send <id> "yes"
```

Start a dev server and check the page:
```sh
id=$("$SPLITGRID_TERMINAL_CLI" open dev --background | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
"$SPLITGRID_TERMINAL_CLI" send "$id" "npm run dev"
"$SPLITGRID_TERMINAL_CLI" read "$id" --tail 20     # wait for the "ready" line and the port
"$SPLITGRID_BROWSER_CLI" open http://localhost:5173   # opens in the same zone
```

Give a long-running task its own pane, then clean up:
```sh
id=$("$SPLITGRID_TERMINAL_CLI" open logs --background | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
"$SPLITGRID_TERMINAL_CLI" send "$id" "tail -f var/log/app.log"
# … later …
"$SPLITGRID_TERMINAL_CLI" close "$id"
```
