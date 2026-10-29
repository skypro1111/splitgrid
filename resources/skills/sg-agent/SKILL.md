---
name: sg-agent
description: Inspect and drive the Claude Code PANES of this SplitGrid workspace via $SPLITGRID_AGENT_CLI — list the live pane sessions, read a pane's state and transcript, tail its startup/lifecycle diagnostics, send it a prompt, interrupt it, answer its permission prompt or clarifying question, change its permission mode, or stop it. This is the ONLY way to reach a Claude Code pane here, and the only way to debug one that is stuck (it is answered by SplitGrid's main process, not by the pane's UI). Triggers on ANY of - "what is the Claude Code pane doing", "the agent pane is stuck / hangs on starting", "read the pane's transcript", "why did the pane fail to start", "send this to the Claude Code pane", "approve / deny what the pane is asking", "stop the agent pane", "debug the agent panel".
---

# SplitGrid Claude Code panes

A Claude Code pane is a container type in SplitGrid (alongside terminal, SSH,
SFTP, SQL, browser). It runs the user's own `claude` binary through the Claude
Agent SDK in SplitGrid's main process — not in a PTY — so its turns, tool calls
and permission prompts are structured data rather than terminal output.

`$SPLITGRID_AGENT_CLI` is answered by that main process directly. That matters:
**a pane whose UI is frozen still answers here**, which is what makes this the
debugging tool of choice.

If `$SPLITGRID_AGENT_CLI` is empty you are not in a SplitGrid terminal, or the
user has not enabled Settings → Agent integrations → Terminal control.

## Reading

```sh
"$SPLITGRID_AGENT_CLI" list
```

Every live pane session: `sessionId`, `claudeSessionId` (the resumable Claude
thread), `cwd`, `model`, `permissionMode`, `status` flags (`hasQuery`,
`publishedInit`, `turnActive`, `stopped`), `attached` (is a pane listening?),
`generation` (how many times the CLI was relaunched) and `ageMs`.

Anywhere a session is expected you may pass the full id, a unique id prefix, or
`#1` / `#2` — the position in `list`.

```sh
"$SPLITGRID_AGENT_CLI" state '#1'                 # one session, full snapshot
"$SPLITGRID_AGENT_CLI" events '#1' --tail 40      # its transcript events
"$SPLITGRID_AGENT_CLI" diag '#1' --tail 100       # its lifecycle steps
"$SPLITGRID_AGENT_CLI" diag                       # every session's steps
```

`diag` is the one to reach for on a hang. The steps are ordered and named after
what they do, so the last one tells you where it stopped:

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
| `manager:dispatch-no-window` | events had nowhere to go — the window is gone |

A run that stops at `query-created` means the CLI never answered; one that
reaches `emit:session.init` but never `manager:attach` means the pane never
subscribed. The same lines are appended to the NDJSON file named by `logPath`,
so they survive a crash.

## Driving

```sh
"$SPLITGRID_AGENT_CLI" send '#1' 'run the tests and fix what fails'
"$SPLITGRID_AGENT_CLI" interrupt '#1'
"$SPLITGRID_AGENT_CLI" mode '#1' acceptEdits      # default|auto|acceptEdits|plan|bypassPermissions
"$SPLITGRID_AGENT_CLI" stop '#1'
```

When a pane is blocked on a permission prompt, `events` shows an
`approval.request` with its `requestId`:

```sh
"$SPLITGRID_AGENT_CLI" approve '#1' <requestId> allow            # or allowForSession | deny | cancel
"$SPLITGRID_AGENT_CLI" answer  '#1' <requestId> 'the option label'
```

## Rules

- **Ask before driving.** Reading (`list`, `state`, `events`, `diag`) is yours to
  do freely. `send`, `approve`, `answer`, `mode` and `stop` act on a session the
  user is working in — approving a tool call on their behalf runs it. Confirm
  first unless the user asked for exactly that.
- Scope is this app's panes; you cannot reach another machine's.
- `send` queues a prompt on the pane's existing thread. It does not wait for the
  answer — poll `events` if you need the result.
