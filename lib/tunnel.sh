#!/usr/bin/env bash

# ── shared cloudflared tunnel helper (review --share, plan --share) ──
#
# start_share_tunnel <port> <logfile>
#   Starts a cloudflared tunnel for http://localhost:<port> in the background.
#   Sets: TUNNEL_PID   (empty if cloudflared is missing)
#         TUNNEL_KIND  ("quick" or "named")
#         SHARE_URL    (https URL when known; may be empty for named tunnels)
#   Returns 1 when cloudflared is not on PATH (callers print the guidance).
#
#   BOTFERENCE_TUNNEL (env): name of a cloudflared named tunnel the user
#   created once (cloudflared tunnel login/create/route dns) — gives a stable
#   URL across sessions instead of a random trycloudflare.com one.
#   BOTFERENCE_TUNNEL_URL (env, optional): the hostname routed to that tunnel,
#   printed as the share URL when set.
start_share_tunnel() {
  local port=$1 log=$2
  TUNNEL_PID=""
  SHARE_URL=""
  TUNNEL_KIND="quick"
  if ! command -v cloudflared >/dev/null 2>&1; then
    return 1
  fi
  if [ -n "${BOTFERENCE_TUNNEL:-}" ]; then
    TUNNEL_KIND="named"
    cloudflared tunnel run --url "http://localhost:${port}" "$BOTFERENCE_TUNNEL" >"$log" 2>&1 &
    TUNNEL_PID=$!
    SHARE_URL="${BOTFERENCE_TUNNEL_URL:-}"
    return 0
  fi
  cloudflared tunnel --url "http://localhost:${port}" >"$log" 2>&1 &
  TUNNEL_PID=$!
  local _i
  for _i in $(seq 1 60); do
    SHARE_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1) || true
    if [ -n "$SHARE_URL" ]; then break; fi
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 0.5
  done
  return 0
}

# print_share_line <password> <port> <logfile>
#   One canonical "share this:" block for both frontends. Empty password
#   means the server is ungated (--no-auth).
print_share_line() {
  local password=$1 port=$2 log=$3
  local pw_note=""
  if [ -n "$password" ]; then pw_note="   password: ${password}"; fi
  if [ "$TUNNEL_KIND" = "named" ]; then
    echo "  using named cloudflared tunnel '${BOTFERENCE_TUNNEL}'"
    if [ -n "$SHARE_URL" ]; then
      echo ""
      echo "  share this: ${SHARE_URL}${pw_note}"
      echo ""
    else
      echo "  your configured hostname for that tunnel applies (set BOTFERENCE_TUNNEL_URL"
      echo "  to print it here).${pw_note:+ ${pw_note# }}"
    fi
    return 0
  fi
  if [ -n "$SHARE_URL" ]; then
    echo ""
    echo "  share this: ${SHARE_URL}${pw_note}"
    echo "  (for a stable URL across sessions, set up a named cloudflared tunnel and"
    echo "   export BOTFERENCE_TUNNEL=<your-tunnel-name> — see the man page)"
    echo ""
  else
    echo "  cloudflared did not produce a trycloudflare URL — its log: $log" >&2
    echo "  Still serving locally at http://localhost:${port}/${pw_note}" >&2
  fi
}

# stop_share_tunnel — graceful kill, then -9 (cloudflared drains up to 30s)
stop_share_tunnel() {
  if [ -n "${TUNNEL_PID:-}" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$TUNNEL_PID" 2>/dev/null || true
    TUNNEL_PID=""
  fi
}
