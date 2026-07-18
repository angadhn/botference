#!/usr/bin/env bash

# ── botference review ────────────────────────────────────────
# Sets up and serves the document-review interface (frontends/review/)
# in a document repo. The launcher stays thin: detection, building, and
# serving all live in the node scripts.

# Engine files owned by $BOTFERENCE_HOME/frontends/review/. --upgrade
# refreshes exactly these (plus assets/*) and never touches the
# per-project files: review.config.json, state/, suggestions.json, site/.
REVIEW_ENGINE_FILES="build.mjs server.mjs chat.mjs apply.mjs submit.mjs init-config.mjs ws.mjs bridge-system-prompt.md SCHEMA.md"

review_usage() {
  cat <<'HELP'
Usage: botference review [dir] [--share [--service]] [--hosted] [--port N] [--no-agents] [--upgrade]

Set up (first run) and serve the document-review interface in a document
repo. dir defaults to the current directory. First run copies the engine
into <dir>/review/, detects the document configuration, and builds the
site; every run serves it (Ctrl-C stops the server).

Agents (the bot bridge) turn on automatically when the machine can run
them: python3 plus at least one agent CLI (claude or codex) on PATH.
Without them the site still serves for reading and commenting.

Options:
  --port N     Serve on port N (overrides the port in review.config.json)
  --share      Hosted mode + a cloudflared quick tunnel: respects
               REVIEW_PASSWORD (or generates one and prints it), prints a
               shareable https URL; Ctrl-C stops server and tunnel together
  --hosted     Shared-URL mode without the tunnel: REVIEW_PASSWORD basic
               auth, per-browser handle picker, owner-gated bots/apply
  --service    With --share: run the whole share (server + tunnel) as a
               managed service ('review-share') instead of in the
               foreground — prints the "share this: URL password" line,
               then returns control. Stop with
               'botference service stop review-share'.
  --agents     Force the agent bridge on (errors if python3 or an agent
               CLI is missing)
  --no-agents  Serve without the agent bridge (comments only)
  --upgrade    Refresh engine files (build/server/chat/apply/submit/
               init-config/ws .mjs, bridge-system-prompt.md, SCHEMA.md,
               assets/*) from the framework copy — never touches
               review.config.json, state/, suggestions.json, or site/
  --help, -h   Show this help
HELP
}

review_copy_engine() {
  local engine=$1 dest=$2 f
  mkdir -p "$dest/assets"
  for f in $REVIEW_ENGINE_FILES; do
    cp "$engine/$f" "$dest/$f"
  done
  cp "$engine"/assets/* "$dest/assets/"
}

# Idempotently appends only the missing lines of the review gitignore block.
review_ensure_gitignore() {
  local gi=$1 line added=false
  # .botference/: per-workspace service ledger + logs (botference service,
  # review --share --service) — never committed
  for line in 'review/site/' 'review/state/*' '!review/state/users' '!review/state/threads.json' '.botference/'; do
    if [ ! -f "$gi" ] || ! grep -qxF "$line" "$gi"; then
      if [ -s "$gi" ] && [ -n "$(tail -c 1 "$gi")" ]; then
        echo >> "$gi"  # file lacks a trailing newline
      fi
      printf '%s\n' "$line" >> "$gi"
      added=true
    fi
  done
  if $added; then
    echo "  Updated .gitignore (review/site/, review/state/* except users/ and threads.json, and .botference/ ignored)"
  fi
}

run_review_mode() {
  local dir="" hosted=false share=false service=false agents="auto" upgrade=false port="" arg
  # args minus --service, for the service re-exec below
  local passthrough=() _pt
  for _pt in "$@"; do
    [ "$_pt" = "--service" ] || passthrough+=("$_pt")
  done
  while [ "$#" -gt 0 ]; do
    arg=$1
    shift
    case "$arg" in
      --hosted) hosted=true ;;
      --share) share=true; hosted=true ;;
      --service) service=true ;;
      # --chat/--no-chat are silent deprecated aliases of --agents/--no-agents
      --no-agents|--no-chat) agents="off" ;;
      --agents|--chat) agents="on" ;;
      --upgrade) upgrade=true ;;
      --port=*) port="${arg#--port=}" ;;
      --port)
        if [ "$#" -eq 0 ]; then
          echo "Error: --port requires a number." >&2
          return 2
        fi
        port=$1
        shift
        ;;
      --help|-h) review_usage; return 0 ;;
      -*)
        echo "Error: unknown review option '$arg' (see 'botference review --help')." >&2
        return 2
        ;;
      *)
        if [ -n "$dir" ]; then
          echo "Error: multiple directories given ('$dir', '$arg')." >&2
          return 2
        fi
        dir=$arg
        ;;
    esac
  done

  if [ -n "$port" ] && ! [[ "$port" =~ ^[0-9]+$ ]]; then
    echo "Error: --port expects a number, got '$port'." >&2
    return 2
  fi
  if $service && ! $share; then
    echo "Error: --service requires --share (botference review --share --service)." >&2
    return 2
  fi
  if $hosted && ! $share && [ -z "${REVIEW_PASSWORD:-}" ]; then
    echo "Error: --hosted requires REVIEW_PASSWORD to be set, e.g." >&2
    echo "  REVIEW_PASSWORD=… botference review --hosted" >&2
    echo "(or use --share, which generates one and opens a tunnel for you)" >&2
    return 1
  fi

  dir=${dir:-.}
  if [ ! -d "$dir" ]; then
    echo "Error: directory '$dir' not found." >&2
    return 1
  fi
  dir=$(cd "$dir" && pwd -P)

  local engine="${BOTFERENCE_HOME}/frontends/review"
  if [ ! -f "$engine/server.mjs" ]; then
    echo "Error: review engine not found at $engine." >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: 'node' not found on PATH — the review interface runs on Node.js." >&2
    return 1
  fi
  if ! command -v pandoc >/dev/null 2>&1; then
    echo "Error: 'pandoc' not found on PATH — the review site builder renders with it." >&2
    echo "  Install it (e.g. 'brew install pandoc') and rerun." >&2
    return 1
  fi

  # --- --share --service: re-run this exact share detached, under the
  # managed service lifecycle; print the "share this:" line, then return ---
  if $service; then
    source "${BOTFERENCE_HOME}/lib/service.sh"
    run_share_as_service "review-share" "${BOTFERENCE_HOME}/botference" review \
      ${passthrough[@]+"${passthrough[@]}"}
    return $?
  fi

  local review_dir="$dir/review"
  local first_time=false
  if [ ! -d "$review_dir" ]; then
    first_time=true
    echo "  Installing review engine → $review_dir"
    review_copy_engine "$engine" "$review_dir"
  elif $upgrade; then
    echo "  Refreshing engine files in $review_dir (config, state/, suggestions.json, site/ untouched)"
    review_copy_engine "$engine" "$review_dir"
  fi

  if [ ! -f "$review_dir/review.config.json" ]; then
    node "${BOTFERENCE_HOME}/scripts/review-detect.mjs" "$dir" || return 1
    (cd "$dir" && node review/init-config.mjs "$BOTFERENCE_HOME") || return 1
  fi

  review_ensure_gitignore "$dir/.gitignore"

  # Build if site/ is missing or older than config, engine, or document sources.
  local stamp="$review_dir/site/index.html"
  local need_build=false
  if [ ! -f "$stamp" ]; then
    need_build=true
  elif [ "$review_dir/review.config.json" -nt "$stamp" ] || [ "$review_dir/build.mjs" -nt "$stamp" ]; then
    need_build=true
  elif [ -n "$(find "$dir" \( -name .git -o -path "$review_dir" \) -prune -o -type f \
      \( -name '*.tex' -o -name '*.md' -o -name '*.bib' \) -newer "$stamp" -print 2>/dev/null | head -1)" ]; then
    need_build=true
  fi
  if $need_build; then
    (cd "$dir" && node review/build.mjs) || return 1
  fi

  if $first_time; then
    echo ""
    echo "  First-time setup complete. Next steps:"
    echo "    - commit review/ and .gitignore to share the interface with collaborators"
    echo "    - collaborators run 'botference review' (agents auto-detected) or plain"
    echo "      'node review/server.mjs', then 'node review/submit.mjs --push'"
    echo "    - or share one live URL instead: botference review --share"
    echo ""
  fi

  # --- agent capability: the bridge needs python3 + at least one agent CLI.
  # PATH presence is the proxy (auth validity is not cheaply checkable); if a
  # CLI exists but auth fails later, the in-page bridge-exit error surfaces it.
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

  local url_port
  if [ -n "$port" ]; then
    url_port=$port
    export PORT="$port"
  else
    url_port=$(node -p "try{JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port||4177}catch(e){4177}" \
      "$review_dir/review.config.json")
  fi

  local server_args=()
  if $agents_on; then server_args+=(--chat); fi
  if $hosted; then server_args+=(--hosted); fi

  if $share && [ -z "${REVIEW_PASSWORD:-}" ]; then
    REVIEW_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))') || return 1
    echo "  REVIEW_PASSWORD not set — generated one for this session: ${REVIEW_PASSWORD}"
  fi
  if $hosted; then export REVIEW_PASSWORD; fi

  echo "  Review interface: http://localhost:${url_port}/  (Ctrl-C stops the server)"
  if $agents_on; then
    echo "  agents: on (${clis} detected)"
  elif [ "$agents" = "off" ]; then
    echo "  agents: off (--no-agents)"
  elif [ -z "$clis" ]; then
    echo "  agents: off — no claude/codex CLI on this machine. You can read and comment;"
    echo "  comments sync via git (commit with: node review/submit.mjs --push). Agents"
    echo "  reply on a machine that has them, or live if the owner shares a hosted"
    echo "  review URL. To enable agents here, install the Claude or Codex CLI and log in."
  else
    echo "  agents: off — 'python3' not found on PATH (the agent bridge runs on it)."
    echo "  You can read and comment; comments sync via git (node review/submit.mjs --push)."
  fi
  cd "$dir" || return 1

  if ! $share; then
    exec node review/server.mjs ${server_args[@]+"${server_args[@]}"}
  fi

  # --- --share: managed server + cloudflared tunnel, torn down together ---
  # (tunnel mechanics shared with plan --share: lib/tunnel.sh; a named tunnel
  # via BOTFERENCE_TUNNEL gives a stable URL instead of a random quick one)
  source "${BOTFERENCE_HOME}/lib/tunnel.sh"
  node review/server.mjs ${server_args[@]+"${server_args[@]}"} &
  local server_pid=$!
  # Ctrl-C (or TERM) takes the server and the tunnel down as one unit;
  # cloudflared's graceful shutdown drains for up to 30s (stop_share_tunnel
  # follows with -9)
  trap 'stop_share_tunnel; kill "$server_pid" 2>/dev/null; exit 130' INT TERM

  local tunnel_log
  tunnel_log=$(mktemp "${TMPDIR:-/tmp}/review-tunnel.XXXXXX")
  if start_share_tunnel "$url_port" "$tunnel_log"; then
    print_share_line "${REVIEW_PASSWORD}" "$url_port" "$tunnel_log"
  else
    if [ -n "${BOTFERENCE_TUNNEL:-}" ]; then
      echo "  BOTFERENCE_TUNNEL is set ('${BOTFERENCE_TUNNEL}') but 'cloudflared' is not installed —" >&2
      echo "  install it (e.g. 'brew install cloudflared') to use your named tunnel." >&2
    else
      echo "  cloudflared not found — no public URL. Install it (e.g. 'brew install cloudflared')" >&2
      echo "  or tunnel by hand:  cloudflared tunnel --url http://localhost:${url_port}" >&2
    fi
    echo "  Serving locally in the meantime: http://localhost:${url_port}/  password: ${REVIEW_PASSWORD}" >&2
  fi
  local rc=0
  wait "$server_pid" || rc=$?
  stop_share_tunnel
  trap - INT TERM
  return "$rc"
}
