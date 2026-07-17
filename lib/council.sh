#!/usr/bin/env bash

# ── botference plan --web / --share ─────────────────────────
# Serves the council web frontend (frontends/council/) instead of the Ink
# TUI. The node server spawns its own bridge; the same session must not be
# open in the TUI and the browser at once (the server refuses a second web
# frontend per workspace via .botference/council-web.lock).
#
# Expects the caller (the plan branch of the launcher) to have prepared:
#   PROMPT, PLAN_SYSTEM, CLI_MODEL, OPENAI_MODEL, OPENAI_REASONING_EFFORT,
#   EFFORT_FLAG, WEB_PORT, SHARE_MODE, NO_AUTH_MODE, BOTFERENCE_PYTHON_BIN

run_council_web() {
  local engine="${BOTFERENCE_HOME}/frontends/council"
  if [ ! -f "$engine/server.mjs" ]; then
    echo "Error: council web engine not found at $engine." >&2
    return 1
  fi
  ensure_ink_node   # the council server needs the same Node >= 20

  local port="${WEB_PORT:-4187}"
  export PORT="$port"

  # system prompt / task via files (arg-length and escaping safety)
  local sys_file task_file
  sys_file=$(mktemp "${TMPDIR:-/tmp}/council-sys.XXXXXX")
  task_file=$(mktemp "${TMPDIR:-/tmp}/council-task.XXXXXX")
  printf '%s' "${PLAN_SYSTEM:-}" > "$sys_file"
  printf '%s' "${PROMPT:-}" > "$task_file"
  export BOTFERENCE_COUNCIL_SYSTEM_FILE="$sys_file"
  export BOTFERENCE_COUNCIL_TASK_FILE="$task_file"

  # participant models/effort, resolved by the launcher exactly as for the TUI
  export COUNCIL_CLAUDE_MODEL="${CLI_MODEL:-}"
  export COUNCIL_CLAUDE_EFFORT="${EFFORT_FLAG:+${EFFORT_FLAG#--effort }}"
  export COUNCIL_OPENAI_MODEL="${OPENAI_MODEL:-}"
  export COUNCIL_OPENAI_EFFORT="${OPENAI_REASONING_EFFORT:-}"

  local server_args=() rc=0
  if ${SHARE_MODE:-false}; then
    server_args+=(--hosted)
    if ${NO_AUTH_MODE:-false}; then
      server_args+=(--no-auth)
      echo ""
      echo "  ⚠ no password: anyone with this URL can drive your agents, which can"
      echo "    read and write files on this machine. URLs leak (link previews,"
      echo "    chat logs). Prefer the default password."
      echo ""
    else
      if [ -z "${COUNCIL_PASSWORD:-}" ]; then
        COUNCIL_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))') || return 1
        echo "  COUNCIL_PASSWORD not set — generated one for this session: ${COUNCIL_PASSWORD}"
      fi
      export COUNCIL_PASSWORD
    fi
  fi

  echo "  Council web: http://localhost:${port}/  (Ctrl-C stops the server)"
  echo "  note: do not open this session in the TUI and the browser at once"

  if ! ${SHARE_MODE:-false}; then
    "$INK_NODE_BIN" "$engine/server.mjs" ${server_args[@]+"${server_args[@]}"} || rc=$?
    rm -f "$sys_file" "$task_file"
    [ "$rc" -eq 130 ] && rc=0   # Ctrl-C is the normal way to stop the server
    return "$rc"
  fi

  # --- --share: managed server + cloudflared tunnel, torn down together ---
  source "${BOTFERENCE_HOME}/lib/tunnel.sh"
  "$INK_NODE_BIN" "$engine/server.mjs" ${server_args[@]+"${server_args[@]}"} &
  local server_pid=$!
  trap 'stop_share_tunnel; kill "$server_pid" 2>/dev/null; exit 130' INT TERM

  local tunnel_log
  tunnel_log=$(mktemp "${TMPDIR:-/tmp}/council-tunnel.XXXXXX")
  if start_share_tunnel "$port" "$tunnel_log"; then
    if ${NO_AUTH_MODE:-false}; then
      print_share_line "" "$port" "$tunnel_log"
    else
      print_share_line "${COUNCIL_PASSWORD}" "$port" "$tunnel_log"
    fi
  else
    if [ -n "${BOTFERENCE_TUNNEL:-}" ]; then
      echo "  BOTFERENCE_TUNNEL is set ('${BOTFERENCE_TUNNEL}') but 'cloudflared' is not installed —" >&2
      echo "  install it (e.g. 'brew install cloudflared') to use your named tunnel." >&2
    else
      echo "  cloudflared not found — no public URL. Install it (e.g. 'brew install cloudflared')" >&2
      echo "  or tunnel by hand:  cloudflared tunnel --url http://localhost:${port}" >&2
    fi
    echo "  Serving locally in the meantime: http://localhost:${port}/${COUNCIL_PASSWORD:+  password: ${COUNCIL_PASSWORD}}" >&2
  fi

  rc=0
  wait "$server_pid" || rc=$?
  stop_share_tunnel
  trap - INT TERM
  rm -f "$sys_file" "$task_file"
  [ "$rc" -eq 130 ] && rc=0
  return "$rc"
}
