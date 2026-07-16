#!/usr/bin/env bash

# ── botference review ────────────────────────────────────────
# Sets up and serves the document-review interface (frontends/review/)
# in a document repo. The launcher stays thin: detection, building, and
# serving all live in the node scripts.

# Engine files owned by $BOTFERENCE_HOME/frontends/review/. --upgrade
# refreshes exactly these (plus assets/*) and never touches the
# per-project files: review.config.json, state/, suggestions.json, site/.
REVIEW_ENGINE_FILES="build.mjs server.mjs chat.mjs apply.mjs submit.mjs init-config.mjs bridge-system-prompt.md SCHEMA.md"

review_usage() {
  cat <<'HELP'
Usage: botference review [dir] [--hosted] [--port N] [--no-chat] [--upgrade]

Set up (first run) and serve the document-review interface in a document
repo. dir defaults to the current directory. First run copies the engine
into <dir>/review/, detects the document configuration, and builds the
site; every run serves it (Ctrl-C stops the server).

Options:
  --port N     Serve on port N (overrides the port in review.config.json)
  --hosted     Shared-URL mode: REVIEW_PASSWORD basic auth, per-browser
               handle picker, owner-gated bots/apply
  --no-chat    Serve without the bot bridge (comments only)
  --upgrade    Refresh engine files (build/server/chat/apply/submit/
               init-config .mjs, bridge-system-prompt.md, SCHEMA.md,
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
  for line in 'review/site/' 'review/state/*' '!review/state/users' '!review/state/threads.json'; do
    if [ ! -f "$gi" ] || ! grep -qxF "$line" "$gi"; then
      if [ -s "$gi" ] && [ -n "$(tail -c 1 "$gi")" ]; then
        echo >> "$gi"  # file lacks a trailing newline
      fi
      printf '%s\n' "$line" >> "$gi"
      added=true
    fi
  done
  if $added; then
    echo "  Updated .gitignore (review/site/ and review/state/* ignored, except users/ and threads.json)"
  fi
}

run_review_mode() {
  local dir="" hosted=false chat=true upgrade=false port="" arg
  while [ "$#" -gt 0 ]; do
    arg=$1
    shift
    case "$arg" in
      --hosted) hosted=true ;;
      --no-chat) chat=false ;;
      --chat) chat=true ;;
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
  if $hosted && [ -z "${REVIEW_PASSWORD:-}" ]; then
    echo "Error: --hosted requires REVIEW_PASSWORD to be set, e.g." >&2
    echo "  REVIEW_PASSWORD=… botference review --hosted" >&2
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
    echo "    - collaborators run: node review/server.mjs, then node review/submit.mjs --push"
    echo ""
  fi

  local url_port
  if [ -n "$port" ]; then
    url_port=$port
    export PORT="$port"
  else
    url_port=$(node -p "try{JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port||4177}catch(e){4177}" \
      "$review_dir/review.config.json")
  fi

  local server_args=()
  if $chat; then server_args+=(--chat); fi
  if $hosted; then server_args+=(--hosted); fi

  echo "  Review interface: http://localhost:${url_port}/  (Ctrl-C stops the server)"
  cd "$dir" || return 1
  exec node review/server.mjs ${server_args[@]+"${server_args[@]}"}
}
