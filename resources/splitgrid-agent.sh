#!/bin/sh
# splitgrid Claude Code pane control (POSIX). Invoked by an agent as:
#   splitgrid-agent.sh <cmd> [args...]
#   read:  list | state <s> | events <s> [--tail N] | diag [<s>] [--tail N]
#   drive: send <s> <text> | interrupt <s> | approve <s> <req> <decision>
#          answer <s> <req> <label> | mode <s> <mode> | stop <s>
#   run `splitgrid-agent.sh help` for the full list.
# Lets an agent inspect and drive the app's Claude Code PANES. Answered by
# splitgrid's main process (not the pane's UI), so it still works when a pane is
# stuck. Forwards the argv tagged with $SPLITGRID_AGENT_TOKEN and PRINTS the JSON
# reply. No-op outside splitgrid.
[ -n "$SPLITGRID_TERMINAL" ] || { echo '{"ok":false,"error":"not_in_splitgrid"}'; exit 0; }
endpoint="${SPLITGRID_AGENT_ENDPOINT:-http://127.0.0.1:19558/agent}"

# WSL transport: the localhost receiver is unreachable from inside the distro
# (NAT + Windows Firewall block the vEthernet gateway), so use the FILE bridge —
# drop a request file in $SPLITGRID_BRIDGE_DIR/req and poll $SPLITGRID_BRIDGE_DIR/res for
# the reply. `use_bridge=1` also skips the (now-pointless) endpoint host rewrite.
use_bridge=""
if [ -n "$WSL_DISTRO_NAME" ] && [ -n "$SPLITGRID_BRIDGE_DIR" ] && [ -d "$SPLITGRID_BRIDGE_DIR/req" ]; then
  use_bridge=1
fi

# Inside WSL the host's 127.0.0.1 is the distro's own loopback, not Windows. In
# mirrored networking 127.0.0.1 still reaches the host; in the default NAT mode
# it doesn't, so fall back to the vEthernet gateway. Resolve once and cache
# (refused probes return instantly, so this stays fast). Shared with splitgrid-browser.sh.
if [ -z "$use_bridge" ] && [ -n "$WSL_DISTRO_NAME" ]; then
  proto="${endpoint%%://*}"; rest="${endpoint#*://}"
  hostport="${rest%%/*}"; reqpath="/${rest#*/}"
  host="${hostport%%:*}"; port="${hostport##*:}"
  [ "$port" = "$host" ] && port=80
  if [ "$host" = "127.0.0.1" ] || [ "$host" = "localhost" ]; then
    # Cache the resolved host under a per-user 0700 dir, never world-writable
    # /tmp: this value is the host we POST $SPLITGRID_AGENT_TOKEN to, so a planted
    # file could exfiltrate the token. Trust the cache only if we own it and it
    # holds a bare IPv4; validate the freshly-resolved value the same way.
    cdir="${XDG_RUNTIME_DIR:-$HOME/.cache}/splitgrid"
    cache="$cdir/wslhost"
    winhost=""
    if [ -O "$cache" ]; then
      v=$(cat "$cache" 2>/dev/null)
      case "$v" in ''|*[!0-9.]*) ;; *) winhost="$v" ;; esac
    fi
    if [ -z "$winhost" ]; then
      if curl -s -o /dev/null -m 1 "http://127.0.0.1:$port/" 2>/dev/null; then
        winhost="127.0.0.1"
      else
        winhost=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
        [ -n "$winhost" ] || winhost=$(awk '/nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null)
      fi
      case "$winhost" in ''|*[!0-9.]*) winhost="127.0.0.1" ;; esac
      (umask 077; mkdir -p "$cdir" 2>/dev/null && chmod 700 "$cdir" 2>/dev/null && printf '%s' "$winhost" > "$cache" 2>/dev/null)
    fi
    endpoint="$proto://$winhost:$port$reqpath"
  fi
fi

# Build a JSON array from "$@": escape each arg into a valid JSON string. awk is
# used (not sed) because BSD/GNU sed differ on multi-line handling at EOF.
# Other control chars (ESC, BEL, …) become \u00XX so the JSON stays valid;
# `&&` doubles a backslash portably (busybox reads "\\\\" as one).
argv=""
for a in "$@"; do
  esc=$(printf '%s' "$a" | awk 'BEGIN{ORS=""; for(i=1;i<32;i++) if(i!=9 && i!=10 && i!=13) c[sprintf("%c",i)]=sprintf("\\u%04x",i)} {gsub(/\\/,"&&"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); gsub(/\r/,"\\r"); for(k in c) if(index($0,k)) gsub(k,c[k]); if(NR>1) printf "\\n"; printf "%s",$0}')
  if [ -z "$argv" ]; then argv="\"$esc\""; else argv="$argv,\"$esc\""; fi
done

payload="{\"kind\":\"agent\",\"terminal\":\"$SPLITGRID_TERMINAL\",\"token\":\"$SPLITGRID_AGENT_TOKEN\",\"argv\":[$argv]}"

if [ -n "$use_bridge" ]; then
  # Write the request atomically (.tmp → rename), then poll for the reply file.
  # Bridge processes within its own 35s budget; queries can be slow, so wait a
  # touch longer (40s) so we receive its timeout reply rather than emitting ours.
  id="$(date +%s%N 2>/dev/null)-$$"
  tmp="$SPLITGRID_BRIDGE_DIR/req/.$id.tmp"
  res="$SPLITGRID_BRIDGE_DIR/res/$id.json"
  if printf '%s' "$payload" > "$tmp" 2>/dev/null && mv "$tmp" "$SPLITGRID_BRIDGE_DIR/req/$id.json" 2>/dev/null; then
    i=0
    while [ ! -f "$res" ]; do
      i=$((i + 1)); [ "$i" -ge 800 ] && break
      sleep 0.05
    done
    if [ -f "$res" ]; then cat "$res"; rm -f "$res" 2>/dev/null; else printf '{"ok":false,"error":"bridge_timeout"}'; fi
  else
    printf '{"ok":false,"error":"bridge_write_failed"}'
  fi
  echo
  exit 0
fi

# Payload on stdin, never argv: argv is world-readable (ps, /proc/<pid>/cmdline)
# and this one carries the agent token plus whatever is being typed or run.
printf '%s' "$payload" | curl -s -m 40 -X POST "$endpoint" \
  -H 'content-type: application/json' \
  --data-binary @-
echo
exit 0
