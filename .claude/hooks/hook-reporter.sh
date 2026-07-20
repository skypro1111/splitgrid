#!/bin/bash
# Claude Code hook reporter
# Reads JSON from stdin and POSTs to claude-hooks-daemon.
# Falls back to a log file when the daemon is unreachable.
# MUST always exit 0 — non-zero exits block Claude Code tool calls.

DAEMON_PORT="${CLAUDE_HOOKS_PORT:-19557}"
DAEMON_URL="http://127.0.0.1:${DAEMON_PORT}/event"
LOG_DIR="${HOME}/.claude/hooks-log"
LOG_FILE="${LOG_DIR}/hook-reporter.log"
MAX_LOG_BYTES=1048576  # 1 MB

# Read full stdin (Claude Code pipes JSON here)
INPUT="$(cat)"

# Bail out if empty
if [ -z "$INPUT" ]; then
  exit 0
fi

# Try sending to the daemon (1s connect timeout, 2s total)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --connect-timeout 1 --max-time 2 \
  -X POST "$DAEMON_URL" \
  -H "Content-Type: application/json" \
  -d "$INPUT" 2>/dev/null || echo "000")

# If daemon is down or returned an error, log locally
if [ "$HTTP_CODE" != "200" ]; then
  mkdir -p "$LOG_DIR" 2>/dev/null

  # Rotate if log is too large
  if [ -f "$LOG_FILE" ]; then
    LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$LOG_SIZE" -gt "$MAX_LOG_BYTES" ] 2>/dev/null; then
      mv "$LOG_FILE" "${LOG_FILE}.old"
    fi
  fi

  # Extract key fields for the log line (no jq dependency — pure grep)
  EVENT_NAME=$(echo "$INPUT" | grep -o '"hook_event_name":"[^"]*"' 2>/dev/null | head -1 | cut -d'"' -f4 || true)
  SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' 2>/dev/null | head -1 | cut -d'"' -f4 || true)
  TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' 2>/dev/null | head -1 | cut -d'"' -f4 || true)

  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  echo "${TIMESTAMP} [${HTTP_CODE}] session=${SESSION_ID:-?} event=${EVENT_NAME:-?} tool=${TOOL_NAME:-}" >> "$LOG_FILE" 2>/dev/null
fi

exit 0
