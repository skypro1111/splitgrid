#!/bin/sh
# splitgrid agent lifecycle hook (POSIX). Invoked by an agent's hook config as:
#   splitgrid-hook.sh <event>          e.g. prompt-submit | stop | notification
# Reports the event to splitgrid, tagged with the terminal id injected at spawn
# ($SPLITGRID_TERMINAL). Designed to NEVER fail or stall the calling agent: short
# timeout, all output/errors swallowed, always exits 0. Reads nothing from stdin
# (the agent's hook payload is ignored — identity comes from the env var).
[ -n "$SPLITGRID_TERMINAL" ] || exit 0
event="$1"

# WSL: the localhost receiver is unreachable from inside the distro (default-NAT
# routes to the host only via the vEthernet gateway, which Windows Firewall drops;
# the IP also churns across WSL restarts). Deliver via the FILE bridge instead —
# drop a request file in $SPLITGRID_BRIDGE_DIR/req (splitgrid's userData, seen here as
# /mnt/<drive>/…). Written atomically (.tmp → rename) so the watcher never reads a
# partial. Fire-and-forget, like the HTTP path.
if [ -n "$WSL_DISTRO_NAME" ] && [ -n "$SPLITGRID_BRIDGE_DIR" ] && [ -d "$SPLITGRID_BRIDGE_DIR/req" ]; then
  id="$(date +%s%N 2>/dev/null)-$$"
  tmp="$SPLITGRID_BRIDGE_DIR/req/.$id.tmp"
  printf '{"kind":"hook","terminal":"%s","event":"%s"}' "$SPLITGRID_TERMINAL" "$event" > "$tmp" 2>/dev/null \
    && mv "$tmp" "$SPLITGRID_BRIDGE_DIR/req/$id.json" 2>/dev/null
  exit 0
fi

endpoint="${SPLITGRID_HOOK_ENDPOINT:-http://127.0.0.1:19558/hook}"

# Inside WSL, rewrite a loopback host to the Windows host (mirrored: 127.0.0.1;
# NAT: vEthernet gateway). Cached in $TMPDIR; see splitgrid-browser.sh for the why.
if [ -n "$WSL_DISTRO_NAME" ]; then
  proto="${endpoint%%://*}"; rest="${endpoint#*://}"
  hostport="${rest%%/*}"; reqpath="/${rest#*/}"
  host="${hostport%%:*}"; port="${hostport##*:}"
  [ "$port" = "$host" ] && port=80
  if [ "$host" = "127.0.0.1" ] || [ "$host" = "localhost" ]; then
    # Per-user 0700 cache, owner-checked, IPv4-validated — see splitgrid-browser.sh.
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
curl -s -m 2 -X POST "$endpoint" \
  -H 'content-type: application/json' \
  -d "{\"terminal\":\"$SPLITGRID_TERMINAL\",\"event\":\"$event\"}" >/dev/null 2>&1 || true
exit 0
