---
name: sg-agent
description: Inspects and drives the Claude Code panes of this SplitGrid app (SDK-driven agent panes, not terminal panes) through $SPLITGRID_AGENT_CLI - list sessions, read a pane's state, transcript and startup/lifecycle diagnostics, send it a prompt, interrupt it, answer its permission prompt or question, change its permission mode, or stop it. Use it whenever a Claude Code pane is involved - it is stuck, hangs on starting or failed to start, the user asks what it is doing or what it said, or wants something sent to, approved in, or stopped in it. It answers from SplitGrid's main process, so it still works when the pane's UI is frozen, which makes it the tool for debugging the agent pane. A Claude Code CLI running inside a terminal pane is driven with sg-terminal instead. Requires a SplitGrid terminal ($SPLITGRID_AGENT_CLI set).
---

# SplitGrid Claude Code panes

A Claude Code pane runs the user's `claude` binary through the Claude Agent SDK
in SplitGrid's main process, not in a PTY, so its turns, tool calls and
permission prompts are structured data. `$SPLITGRID_AGENT_CLI` is answered by
that main process directly: **a pane whose UI is frozen still answers here.**

If `$SPLITGRID_AGENT_CLI` is empty, this is not a SplitGrid terminal, or the
user has not enabled Settings → Agent integrations → Terminal control.

## Rules

- **Ask before driving.** Reading (`list`, `state`, `events`, `diag`) is free.
  `send`, `approve`, `answer`, `mode` and `stop` act on a session the user is
  working in, and approving a tool call runs it on their behalf. Confirm first
  unless the user asked for exactly that.
- `send` queues a prompt on the pane's existing thread and returns at once.
  Poll `events` for the answer.
- Scope is this app's panes only.

## Reading

```sh
"$SPLITGRID_AGENT_CLI" list                       # every live pane session
"$SPLITGRID_AGENT_CLI" state '#1'                 # one session, full snapshot
"$SPLITGRID_AGENT_CLI" events '#1' --tail 40      # its transcript events
"$SPLITGRID_AGENT_CLI" diag '#1' --tail 100       # its lifecycle steps
"$SPLITGRID_AGENT_CLI" diag                       # every session's steps
```

`list` gives each session's `sessionId`, `claudeSessionId` (the resumable
Claude thread), `cwd`, `model`, `permissionMode`, `status` flags (`hasQuery`,
`publishedInit`, `turnActive`, `stopped`), `attached` (is a pane listening?),
`generation` (how many times the CLI was relaunched) and `ageMs`. Wherever a
session is expected, pass the full id, a unique id prefix, or `#1` / `#2` (the
position in `list`).

## Debugging a hang

Start with `diag`. Its steps are ordered and named after what they do, so the
last one shows where the session stopped:

| step | meaning |
| --- | --- |
| `start` | the session was asked to start (carries cwd/model/mode) |
| `resolve-executable` | which `claude` binary was found (`null` = not found) |
| `load-sdk:begin` / `:done` | the Agent SDK module import |
| `query-created` | the CLI process was spawned |
| `initialize:requested` / `:resolved` / `:failed` | the CLI handshake |
| `sdk-message` | a message came back from the CLI (type/subtype) |
| `emit:*` | an event was published to the pane |
| `manager:attach` / `:detach` | a pane started/stopped listening |
| `manager:dispatch-no-window` | events had nowhere to go: the window is gone |

Stopping at `query-created` means the CLI never answered. Reaching
`emit:session.init` without `manager:attach` means the pane never subscribed.
The same lines are appended to the NDJSON file named by `logPath`, so they
survive a crash.

## Driving

```sh
"$SPLITGRID_AGENT_CLI" send '#1' 'run the tests and fix what fails'
"$SPLITGRID_AGENT_CLI" interrupt '#1'
"$SPLITGRID_AGENT_CLI" mode '#1' acceptEdits      # default|auto|acceptEdits|plan|bypassPermissions
"$SPLITGRID_AGENT_CLI" stop '#1'
```

A pane blocked on a permission prompt or a question shows an `approval.request`
with its `requestId` in `events`:

```sh
"$SPLITGRID_AGENT_CLI" approve '#1' <requestId> allow            # or allowForSession | deny | cancel
"$SPLITGRID_AGENT_CLI" answer  '#1' <requestId> 'the option label'
```
