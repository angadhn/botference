#!/usr/bin/env bash

# ── botference plugin ────────────────────────────────────────
# Serves the web-annotator companion (frontends/plugin/server.mjs): the
# local backend for the browser extension — annotation storage, Obsidian
# export, and the agent bridge that answers @claude/@codex mentions made
# on web pages. The launcher stays thin: all behavior lives in the node
# server. Sessions created by mentions land in this workspace's council
# under the "Plugin pages" project, so run it from your main workspace.

plugin_usage() {
  cat <<'HELP'
Usage: botference plugin [--port N] [--service] [--no-agents] [--agents] [--here]
       botference plugin --share [--service]
       botference plugin --hosted [--service]
       botference plugin --install-autostart [--port N] [--no-agents]
       botference plugin --uninstall-autostart

Serve the web-annotator companion server for the browser extension
(frontends/plugin/extension — load it once via brave://extensions →
"Load unpacked"). Highlight text on any static article page, comment,
@-mention bots for inline replies, export pages to Obsidian.

Agents turn on automatically when the machine can run them: python3
plus at least one agent CLI (claude or codex) on PATH. Without them
highlights, comments, and Obsidian export still work.

The workspace is sticky. Annotations live in one workspace's
.botference/plugin, so after the first run 'botference plugin' from any
directory reuses that same workspace (remembered in
~/.botference/plugin-workspace) instead of starting an empty one in
whatever folder you happen to be in. A directory that already has
.botference/plugin state always wins; --here forces the current one.

Options:
  --port N     Serve on port N (default 4189 — the extension expects
               4189 unless you change it in its background.js)
  --here       Use the current directory as the workspace (and remember
               it) instead of the one last used
  --share      Share the annotations with other people: hosted mode plus
               a cloudflared quick tunnel. Respects PLUGIN_PASSWORD (or
               generates one and prints it) and prints a shareable https
               URL; Ctrl-C stops server and tunnel together
  --hosted     Hosted mode without the tunnel: PLUGIN_PASSWORD gates
               every remote visitor, localhost stays the owner.
               PLUGIN_OWNER_PASSWORD (optional) signs the owner in from
               another device
  --service    Run detached under the managed service lifecycle
               (name 'plugin-web', or 'plugin-share' with --share);
               stop with 'botference service stop <name>'
  --agents     Force the agent bridge on (errors if python3 or an
               agent CLI is missing)
  --no-agents  Serve without the agent bridge (annotations only)
  --help, -h   Show this help

Sharing, in short: collaborators open the URL and read/reply at /pages
without installing anything. Their @-mentions are refused until you
grant them agent access in .botference/plugin/grants.json, e.g.
{"ada": {"agents": true, "daily_cap": 5}} — re-read live, no restart.

Login autostart (macOS, set-and-forget — the companion is simply always
there, no terminal to remember):
  --install-autostart    Install a LaunchAgent that runs the companion
                         for THIS workspace (the directory you run it
                         from) at every login and restarts it if it
                         dies. Any --port/--no-agents given alongside is
                         baked into the agent. Logs are appended to
                         .botference/logs/plugin-autostart.log
  --uninstall-autostart  Stop and remove that LaunchAgent (safe to run
                         when nothing is installed)
Neither can be combined with --service — they are different lifecycles.
HELP
}

# ── sticky workspace ─────────────────────────────────────────
# The companion is a personal appliance, not a per-repo tool: every
# annotation you have ever made lives in ONE workspace's
# .botference/plugin. Starting it from a different directory would serve
# an empty one and quietly lose sight of the history, so the workspace is
# remembered and reused from anywhere. Precedence: a directory that
# already holds plugin state (or --here) wins; then the remembered one;
# then the current directory, on the very first run.
PLUGIN_WORKSPACE_FILE="${HOME}/.botference/plugin-workspace"

# sets PLUGIN_WS (absolute) and PLUGIN_WS_STICKY (true when it came from
# the memo rather than from where we are standing)
_plugin_pick_workspace() {
  local force_here=${1:-false} pwd_dir saved
  pwd_dir=$(pwd -P)
  PLUGIN_WS="$pwd_dir"
  PLUGIN_WS_STICKY=false
  if [ "$force_here" = true ] || [ -d "${pwd_dir}/.botference/plugin" ]; then
    return 0
  fi
  if [ -f "$PLUGIN_WORKSPACE_FILE" ]; then
    saved=$(head -1 "$PLUGIN_WORKSPACE_FILE" 2>/dev/null || true)
    if [ -n "$saved" ] && [ -d "$saved" ]; then
      PLUGIN_WS="$saved"
      PLUGIN_WS_STICKY=true
    fi
  fi
}

_plugin_remember_workspace() {
  local ws=$1
  mkdir -p "$(dirname "$PLUGIN_WORKSPACE_FILE")" 2>/dev/null || return 0
  printf '%s\n' "$ws" > "$PLUGIN_WORKSPACE_FILE" 2>/dev/null || true
}

# Resolve, announce and enter the workspace. One line of output, and only
# when the answer is not simply "here" — nobody should have to guess where
# their annotations are being read from.
_plugin_enter_workspace() {
  local force_here=${1:-false}
  _plugin_pick_workspace "$force_here"
  if [ "$PLUGIN_WS" != "$(pwd -P)" ]; then
    echo "  workspace: ${PLUGIN_WS}  (run with --here to use the current directory instead)"
    cd "$PLUGIN_WS" || return 1
  fi
  _plugin_remember_workspace "$PLUGIN_WS"
  export BOTFERENCE_PROJECT_ROOT="$PLUGIN_WS"
}

# ── login autostart (macOS LaunchAgent) ──────────────────────
# Set-and-forget companion: a user LaunchAgent runs `botference plugin`
# in one workspace at login and keeps it alive. Foreground runs still
# win — the server takes a pid lock and exits 1 when another instance
# holds it, so the launchd copy just retries (launchd throttles respawns
# to ~10s), which doubles as the takeover mechanism when you Ctrl-C the
# terminal copy. KeepAlive is SuccessfulExit=false: crashes and
# lock-conflict exits respawn, a clean exit (bootout/SIGTERM) does not.

PLUGIN_AUTOSTART_LABEL="com.botference.plugin-web"
PLUGIN_AUTOSTART_DIR="${HOME}/Library/LaunchAgents"

_plugin_xml_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  printf '%s' "$s"
}

# launchd agents inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
# which loses homebrew node and every agent CLI. Bake in the dirs the
# tools actually resolve from today, then the usual suspects, deduped.
_plugin_autostart_path() {
  local dirs=() out="" tool p d
  for tool in node python3 claude codex; do
    p=$(command -v "$tool" 2>/dev/null) || continue
    [ -n "$p" ] || continue
    d=$(dirname "$p")
    dirs+=("$d")
  done
  dirs+=(/opt/homebrew/bin /usr/local/bin /usr/bin /bin)
  for d in "${dirs[@]}"; do
    case ":${out}:" in *":${d}:"*) continue ;; esac
    out="${out:+$out:}${d}"
  done
  printf '%s' "$out"
}

# Emit the LaunchAgent XML on stdout. Pure function of its arguments so
# it can be linted (plutil) without touching ~/Library/LaunchAgents.
#   plugin_autostart_plist <label> <workspace> <port|""> [extra plugin args…]
plugin_autostart_plist() {
  local label=$1 workspace=$2 port=$3
  shift 3
  local log="${workspace}/.botference/logs/plugin-autostart.log"
  local pathval
  pathval=$(_plugin_autostart_path)

  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0">'
  printf '%s\n' '<dict>'
  printf '  <key>Label</key>\n  <string>%s</string>\n' "$(_plugin_xml_escape "$label")"
  printf '%s\n' '  <key>ProgramArguments</key>'
  printf '%s\n' '  <array>'
  local a
  for a in "${BOTFERENCE_HOME}/botference" plugin ${@+"$@"}; do
    printf '    <string>%s</string>\n' "$(_plugin_xml_escape "$a")"
  done
  printf '%s\n' '  </array>'
  printf '  <key>WorkingDirectory</key>\n  <string>%s</string>\n' "$(_plugin_xml_escape "$workspace")"
  printf '%s\n' '  <key>EnvironmentVariables</key>'
  printf '%s\n' '  <dict>'
  printf '    <key>PATH</key>\n    <string>%s</string>\n' "$(_plugin_xml_escape "$pathval")"
  printf '    <key>HOME</key>\n    <string>%s</string>\n' "$(_plugin_xml_escape "$HOME")"
  if [ -n "$port" ]; then
    printf '    <key>PORT</key>\n    <string>%s</string>\n' "$(_plugin_xml_escape "$port")"
  fi
  printf '%s\n' '  </dict>'
  printf '%s\n' '  <key>RunAtLoad</key>'
  printf '%s\n' '  <true/>'
  printf '%s\n' '  <key>KeepAlive</key>'
  printf '%s\n' '  <dict>'
  printf '%s\n' '    <key>SuccessfulExit</key>'
  printf '%s\n' '    <false/>'
  printf '%s\n' '  </dict>'
  printf '  <key>StandardOutPath</key>\n  <string>%s</string>\n' "$(_plugin_xml_escape "$log")"
  printf '  <key>StandardErrorPath</key>\n  <string>%s</string>\n' "$(_plugin_xml_escape "$log")"
  printf '%s\n' '</dict>'
  printf '%s\n' '</plist>'
}

_plugin_require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "Error: login autostart uses launchd — macOS only." >&2
    return 1
  fi
}

# Is a companion answering on this port right now?
_plugin_companion_live() {
  local port=$1
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS -m 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1
}

plugin_autostart_install() {
  local port=$1
  shift
  _plugin_require_macos || return 1
  local workspace="${BOTFERENCE_PROJECT_ROOT:-$(pwd -P)}"
  local plist="${PLUGIN_AUTOSTART_DIR}/${PLUGIN_AUTOSTART_LABEL}.plist"
  local logdir="${workspace}/.botference/logs"
  local log="${logdir}/plugin-autostart.log"
  local url_port=${port:-4189}

  mkdir -p "$logdir" "$PLUGIN_AUTOSTART_DIR" || return 1

  local tmp="${plist}.tmp.$$"
  plugin_autostart_plist "$PLUGIN_AUTOSTART_LABEL" "$workspace" "$port" ${@+"$@"} > "$tmp" || {
    rm -f "$tmp"
    echo "Error: could not write the LaunchAgent plist." >&2
    return 1
  }
  if command -v plutil >/dev/null 2>&1 && ! plutil -lint "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "Error: generated plist failed plutil -lint — refusing to install." >&2
    return 1
  fi
  mv "$tmp" "$plist"

  # Replace any previous copy of this agent before loading the new one.
  local domain="gui/$(id -u)"
  launchctl bootout "${domain}/${PLUGIN_AUTOSTART_LABEL}" >/dev/null 2>&1 || true
  launchctl unload "$plist" >/dev/null 2>&1 || true

  # A companion answering now is a hand-run one: say plainly what happens.
  local takeover=false
  if _plugin_companion_live "$url_port"; then takeover=true; fi

  if launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then
    :
  elif launchctl load -w "$plist" >/dev/null 2>&1; then
    :
  else
    echo "Error: launchctl could not load ${plist}." >&2
    echo "  Try by hand: launchctl bootstrap ${domain} ${plist}" >&2
    return 1
  fi

  echo "  login autostart installed: ${PLUGIN_AUTOSTART_LABEL}"
  echo "  workspace:  ${workspace}   port: ${url_port}$([ "$#" -gt 0 ] && printf '   args: %s' "$*")"
  echo "  plist:      ${plist}"
  echo "  logs:       ${log}"
  echo "  check it:   launchctl list | grep ${PLUGIN_AUTOSTART_LABEL}"
  echo "  remove it:  botference plugin --uninstall-autostart"
  if $takeover; then
    echo "  a companion is already running in a terminal — the autostart copy will take over within ~10s after you Ctrl-C it (or at next login)"
  else
    echo "  the companion is starting now, and again at every login."
  fi
}

plugin_autostart_uninstall() {
  _plugin_require_macos || return 1
  local plist="${PLUGIN_AUTOSTART_DIR}/${PLUGIN_AUTOSTART_LABEL}.plist"
  local domain="gui/$(id -u)"
  local unloaded=false
  if launchctl bootout "${domain}/${PLUGIN_AUTOSTART_LABEL}" >/dev/null 2>&1; then
    unloaded=true
  elif [ -f "$plist" ] && launchctl unload -w "$plist" >/dev/null 2>&1; then
    unloaded=true
  fi
  if [ -f "$plist" ]; then
    rm -f "$plist"
    echo "  login autostart removed: ${PLUGIN_AUTOSTART_LABEL}"
    echo "  deleted:    ${plist}"
    $unloaded && echo "  the autostart companion (if it was running) has been stopped."
    echo "  a companion you run by hand ('botference plugin') is unaffected."
  else
    $unloaded && echo "  unloaded a stray ${PLUGIN_AUTOSTART_LABEL} job (no plist on disk)."
    echo "  nothing to remove — no login autostart was installed (${plist})."
  fi
}

run_plugin_mode() {
  local port="" service=false agents="auto" autostart="" arg
  local hosted=false share=false here=false
  # args minus --service, for the --service re-exec below
  local passthrough=() _pt
  for _pt in "$@"; do
    case "$_pt" in
      --service) ;;
      *) passthrough+=("$_pt") ;;
    esac
  done
  while [ "$#" -gt 0 ]; do
    arg=$1
    shift
    case "$arg" in
      --service) service=true ;;
      --install-autostart) autostart="install" ;;
      --uninstall-autostart) autostart="uninstall" ;;
      --no-agents) agents="off" ;;
      --agents) agents="on" ;;
      --hosted) hosted=true ;;
      --share) share=true; hosted=true ;;
      --here) here=true ;;
      --port=*) port="${arg#--port=}" ;;
      --port)
        if [ "$#" -eq 0 ]; then
          echo "Error: --port requires a number." >&2
          return 2
        fi
        port=$1
        shift
        ;;
      --help|-h) plugin_usage; return 0 ;;
      *)
        echo "Error: unknown plugin option '$arg' (see 'botference plugin --help')." >&2
        return 2
        ;;
    esac
  done

  if [ -n "$port" ] && ! [[ "$port" =~ ^[0-9]+$ ]]; then
    echo "Error: --port expects a number, got '$port'." >&2
    return 2
  fi

  # --- sharing and login autostart are different propositions ---
  # A LaunchAgent would have to carry the shared password in a plist that
  # launchd reads at every login; sharing is a thing you start on purpose
  # and stop when the conversation is over.
  if [ -n "$autostart" ] && { $hosted || $share; }; then
    echo "Error: --install-autostart cannot be combined with --hosted/--share." >&2
    echo "  Autostart runs the private local companion at login; start a share by hand" >&2
    echo "  when you want one: botference plugin --share" >&2
    return 2
  fi
  if $hosted && ! $share && [ -z "${PLUGIN_PASSWORD:-}" ]; then
    echo "Error: --hosted requires PLUGIN_PASSWORD to be set, e.g." >&2
    echo "  PLUGIN_PASSWORD=… botference plugin --hosted" >&2
    echo "(or use --share, which generates one and opens a tunnel for you)" >&2
    return 2
  fi

  # --- login autostart: a different lifecycle from --service, never both ---
  if [ -n "$autostart" ]; then
    if $service; then
      echo "Error: --${autostart}-autostart cannot be combined with --service." >&2
      echo "  --service is a per-session managed process; autostart is a login LaunchAgent." >&2
      return 2
    fi
    if [ "$autostart" = "uninstall" ]; then
      plugin_autostart_uninstall
      return $?
    fi
  fi

  local engine="${BOTFERENCE_HOME}/frontends/plugin"
  if [ ! -f "$engine/server.mjs" ]; then
    echo "Error: plugin companion not found at $engine." >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: 'node' not found on PATH — the companion server runs on Node.js." >&2
    return 1
  fi

  # --- which workspace's annotations are we serving? (sticky) ---
  _plugin_enter_workspace "$here" || return 1

  # --- --install-autostart: hand this workspace's companion to launchd ---
  if [ "$autostart" = "install" ]; then
    local boot_args=()
    case "$agents" in
      off) boot_args+=(--no-agents) ;;
      on) boot_args+=(--agents) ;;
    esac
    [ -n "$port" ] && boot_args+=(--port "$port")
    plugin_autostart_install "$port" ${boot_args[@]+"${boot_args[@]}"}
    return $?
  fi

  # --- the shared password: generated once here so the tunnel, the printed
  # line and any detached copy all agree on it ---
  if $share && [ -z "${PLUGIN_PASSWORD:-}" ]; then
    PLUGIN_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))') || return 1
    echo "  PLUGIN_PASSWORD not set — generated one for this session: ${PLUGIN_PASSWORD}"
  fi
  if $hosted; then export PLUGIN_PASSWORD; fi

  # --- --share --service: re-run this exact share detached, under the managed
  # service lifecycle; print the "share this:" line, then return ---
  if $service && $share; then
    source "${BOTFERENCE_HOME}/lib/service.sh"
    run_share_as_service "plugin-share" "${BOTFERENCE_HOME}/botference" plugin \
      ${passthrough[@]+"${passthrough[@]}"}
    return $?
  fi

  # --- --service: same server (hosted or not), detached under the managed
  # lifecycle. No tunnel here — that is --share. ---
  if $service; then
    source "${BOTFERENCE_HOME}/lib/service.sh"
    service_cmd_start "plugin-web" -- "${BOTFERENCE_HOME}/botference" plugin \
      ${passthrough[@]+"${passthrough[@]}"}
    return $?
  fi

  # --- agent capability: same proxy as review — python3 + a CLI on PATH ---
  local clis="" have_python=false agents_on=false
  command -v claude >/dev/null 2>&1 && clis="claude"
  command -v codex >/dev/null 2>&1 && clis="${clis:+$clis, }codex"
  command -v python3 >/dev/null 2>&1 && have_python=true
  case "$agents" in
    on)
      if ! $have_python; then
        echo "Error: --agents: 'python3' not found on PATH — the agent bridge runs on it." >&2
        return 1
      fi
      if [ -z "$clis" ]; then
        echo "Error: --agents: no 'claude' or 'codex' CLI found on PATH." >&2
        echo "  Install one (and log in) to enable agents, or drop --agents." >&2
        return 1
      fi
      agents_on=true
      ;;
    off) agents_on=false ;;
    *) if $have_python && [ -n "$clis" ]; then agents_on=true; fi ;;
  esac

  local url_port=${port:-4189}
  [ -n "$port" ] && export PORT="$port"

  local server_args=()
  if ! $agents_on; then server_args+=(--no-agents); fi
  if $hosted; then server_args+=(--hosted); fi

  echo "  Web annotator companion: http://127.0.0.1:${url_port}/  (Ctrl-C stops it)"
  if $agents_on; then
    echo "  agents: on (${clis} detected) — @claude/@codex in comments summon them"
  elif [ "$agents" = "off" ]; then
    echo "  agents: off (--no-agents) — highlights, comments, and export only"
  else
    echo "  agents: off — python3 + a claude/codex CLI on PATH are needed for bot replies."
  fi
  if $hosted; then
    echo "  hosted: remote visitors need the password; this machine stays the owner"
    echo "  people without the extension read and reply at /pages"
    echo "  their @-mentions are refused until you grant them agents in"
    echo "  ${PLUGIN_WS}/.botference/plugin/grants.json"
  fi
  echo "  Extension not installed yet? brave://extensions → Developer mode →"
  echo "  Load unpacked → ${engine}/extension"

  if ! $share; then
    exec node "$engine/server.mjs" ${server_args[@]+"${server_args[@]}"}
  fi

  # --- --share: server + cloudflared tunnel, torn down together ---
  # (same mechanics as review --share: lib/tunnel.sh, and BOTFERENCE_TUNNEL
  # gives a stable URL instead of a random quick one)
  source "${BOTFERENCE_HOME}/lib/tunnel.sh"
  node "$engine/server.mjs" ${server_args[@]+"${server_args[@]}"} &
  local server_pid=$!
  trap 'stop_share_tunnel; kill "$server_pid" 2>/dev/null; exit 130' INT TERM

  local tunnel_log
  tunnel_log=$(mktemp "${TMPDIR:-/tmp}/plugin-tunnel.XXXXXX")
  if start_share_tunnel "$url_port" "$tunnel_log"; then
    print_share_line "${PLUGIN_PASSWORD}" "$url_port" "$tunnel_log"
  else
    if [ -n "${BOTFERENCE_TUNNEL:-}" ]; then
      echo "  BOTFERENCE_TUNNEL is set ('${BOTFERENCE_TUNNEL}') but 'cloudflared' is not installed —" >&2
      echo "  install it (e.g. 'brew install cloudflared') to use your named tunnel." >&2
    else
      echo "  cloudflared not found — no public URL. Install it (e.g. 'brew install cloudflared')" >&2
      echo "  or tunnel by hand:  cloudflared tunnel --url http://localhost:${url_port}" >&2
    fi
    echo "  Serving locally in the meantime: http://localhost:${url_port}/  password: ${PLUGIN_PASSWORD}" >&2
  fi
  local rc=0
  wait "$server_pid" || rc=$?
  stop_share_tunnel
  trap - INT TERM
  return "$rc"
}
