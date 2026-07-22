#!/bin/sh
# splitgrid agent SFTP access (POSIX). Invoked by an agent as:
#   splitgrid-sftp.sh <cmd> [args...]
#   read:   targets | status | ls <remote> | stat <remote> | cat <remote> | get <remote> [local]
#   write:  send <local...> [remote-dir] | push <path...> | pull <path...> | sync |
#           mkdir <remote> | mv <old> <new> | rm <remote> --force
#   run `splitgrid-sftp.sh help` for the full list.
# Moves files between this machine and the remote hosts of the caller's workspace.
# Forwards the argv to splitgrid (tagged with $SPLITGRID_TERMINAL + $SPLITGRID_SFTP_TOKEN)
# and PRINTS the JSON reply so the agent can read the result. No-op outside splitgrid.
# Capability hint: $SPLITGRID_SFTP_WRITE=1 when uploads/changes are permitted.
[ -n "$SPLITGRID_TERMINAL" ] || { echo '{"ok":false,"error":"not_in_splitgrid"}'; exit 0; }
endpoint="${SPLITGRID_SFTP_ENDPOINT:-http://127.0.0.1:19558/sftp}"

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
    # /tmp: this value is the host we POST $SPLITGRID_SFTP_TOKEN to, so a planted
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
argv=""
for a in "$@"; do
  esc=$(printf '%s' "$a" | awk 'BEGIN{ORS=""} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); gsub(/\r/,"\\r"); if(NR>1) printf "\\n"; printf "%s",$0}')
  if [ -z "$argv" ]; then argv="\"$esc\""; else argv="$argv,\"$esc\""; fi
done

payload="{\"kind\":\"sftp\",\"terminal\":\"$SPLITGRID_TERMINAL\",\"token\":\"$SPLITGRID_SFTP_TOKEN\",\"argv\":[$argv]}"

if [ -n "$use_bridge" ]; then
  # Write the request atomically (.tmp → rename), then poll for the reply file.
  # Transfers get a 180s budget in the bridge; wait a touch longer (190s) so we
  # receive its timeout reply rather than emitting our own.
  id="$(date +%s%N 2>/dev/null)-$$"
  tmp="$SPLITGRID_BRIDGE_DIR/req/.$id.tmp"
  res="$SPLITGRID_BRIDGE_DIR/res/$id.json"
  if printf '%s' "$payload" > "$tmp" 2>/dev/null && mv "$tmp" "$SPLITGRID_BRIDGE_DIR/req/$id.json" 2>/dev/null; then
    i=0
    while [ ! -f "$res" ]; do
      i=$((i + 1)); [ "$i" -ge 3800 ] && break
      sleep 0.05
    done
    if [ -f "$res" ]; then cat "$res"; rm -f "$res" 2>/dev/null; else printf '{"ok":false,"error":"bridge_timeout"}'; fi
  else
    printf '{"ok":false,"error":"bridge_write_failed"}'
  fi
  echo
  exit 0
fi

curl -s -m 190 -X POST "$endpoint" \
  -H 'content-type: application/json' \
  -d "$payload"
echo
exit 0
