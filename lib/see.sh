#!/usr/bin/env bash

# ── botference see ───────────────────────────────────────────
# Eyes for agents (and humans): render a page headless and write PNGs a
# vision-capable model can read back. No Playwright, no new dependency —
# the system Chrome does the work. Layout and design failures produce no
# errors or warnings, so an agent that only reads code and logs will
# ship a page that "works" but looks broken; this closes that loop.
#
# The target can be a URL, a bare port, or the NAME of a running
# `botference service` (resolved from the ledgers; the listening port is
# read from the live process, so agents never need to know ports).

see_usage() {
  cat <<'HELP'
Usage: botference see <url | :port | service-name> [label] [options]

Render a page in headless Chrome and write screenshot PNGs, one per
viewport. Made for agents: after changing a UI, look at it — layout
mistakes produce no console errors, so logs alone will not catch them.
Read the printed PNG paths back with your image tooling.

Target forms:
  https://… or http://…   used as-is
  :4123 (or bare digits)  http://localhost:<port>
  <service-name>          a running `botference service` — its listening
                          port is discovered from the live process

Options:
  --viewport WxH     Add a viewport (repeatable). Default when none
                     given: 390x844 (phone) and 1440x900 (desktop).
  --basic-auth U:P   Send HTTP basic auth (embedded for the navigation).
  --out DIR          Output directory (default ./.botference/shots).
  --help, -h         This help.

Each written file is printed as:  wrote: <path>
Exit is nonzero if any screenshot failed to render.
HELP
}

# Chrome discovery: env override, the macOS app bundle, then PATH names.
see_find_chrome() {
  if [ -n "${BOTFERENCE_CHROME:-}" ] && [ -x "${BOTFERENCE_CHROME}" ]; then
    echo "$BOTFERENCE_CHROME"
    return 0
  fi
  local mac_chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [ -x "$mac_chrome" ]; then
    echo "$mac_chrome"
    return 0
  fi
  local c
  for c in google-chrome chromium chromium-browser chrome; do
    if command -v "$c" >/dev/null 2>&1; then
      command -v "$c"
      return 0
    fi
  done
  return 1
}

# Resolve a service name to http://localhost:<port> by asking the live
# process what it listens on. Searches the cwd ledger first, then every
# ledger in the global index (same set `service list` reads).
see_resolve_service() {
  local name=$1 ledger pid port
  local ledgers=(".botference/services.json")
  local index="${BOTFERENCE_SERVICE_INDEX:-$HOME/.botference/ledgers}"
  if [ -f "$index" ]; then
    while IFS= read -r ledger; do
      [ -f "$ledger" ] && ledgers+=("$ledger")
    done < "$index"
  fi
  for ledger in "${ledgers[@]}"; do
    [ -f "$ledger" ] || continue
    pid=$(python3 - "$ledger" "$name" <<'PY' 2>/dev/null
import json, sys
try:
    for s in json.load(open(sys.argv[1])).get("services", []):
        if s.get("name") == sys.argv[2]:
            print(s.get("pid", ""))
            break
except Exception:
    pass
PY
)
    [ -n "$pid" ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    # first listening TCP port of the process (or its children — a
    # launcher wrapper often owns the ledger pid while a child listens)
    port=$(lsof -aPi -sTCP:LISTEN -p "$pid" 2>/dev/null | awk 'NR>1 {sub(".*:", "", $9); print $9; exit}')
    if [ -z "$port" ]; then
      local kids
      kids=$(pgrep -P "$pid" 2>/dev/null | tr '\n' ',' | sed 's/,$//')
      [ -n "$kids" ] && port=$(lsof -aPi -sTCP:LISTEN -p "$kids" 2>/dev/null | awk 'NR>1 {sub(".*:", "", $9); print $9; exit}')
    fi
    if [ -n "$port" ]; then
      echo "http://localhost:${port}"
      return 0
    fi
  done
  return 1
}

run_see_mode() {
  local target="" label="" out="" auth=""
  local viewports=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h) see_usage; return 0 ;;
      --viewport)
        shift
        [ "$#" -gt 0 ] || { echo "Error: --viewport requires WxH." >&2; return 2; }
        viewports+=("$1") ;;
      --viewport=*) viewports+=("${1#--viewport=}") ;;
      --basic-auth)
        shift
        [ "$#" -gt 0 ] || { echo "Error: --basic-auth requires user:pass." >&2; return 2; }
        auth="$1" ;;
      --basic-auth=*) auth="${1#--basic-auth=}" ;;
      --out)
        shift
        [ "$#" -gt 0 ] || { echo "Error: --out requires a directory." >&2; return 2; }
        out="$1" ;;
      --out=*) out="${1#--out=}" ;;
      -*)
        echo "Error: unknown see option '$1' (see 'botference see --help')." >&2
        return 2 ;;
      *)
        if [ -z "$target" ]; then target="$1"
        elif [ -z "$label" ]; then label="$1"
        else echo "Error: unexpected argument '$1'." >&2; return 2
        fi ;;
    esac
    shift
  done

  if [ -z "$target" ]; then
    see_usage >&2
    return 2
  fi

  local url=""
  case "$target" in
    http://*|https://*) url="$target" ;;
    :[0-9]*) url="http://localhost:${target#:}" ;;
    [0-9]*)
      if [[ "$target" =~ ^[0-9]+$ ]]; then url="http://localhost:${target}"; fi ;;
  esac
  if [ -z "$url" ]; then
    if ! url=$(see_resolve_service "$target"); then
      echo "Error: '$target' is not a URL and no running service by that name was found." >&2
      echo "  (services: botference service list — or pass a URL / :port directly)" >&2
      return 1
    fi
    [ -n "$label" ] || label="$target"
  fi
  if [ -z "$label" ]; then
    label=$(echo "$url" | sed -E 's#^https?://##; s#[^A-Za-z0-9.-].*$##; s#[^A-Za-z0-9.-]#-#g')
    [ -n "$label" ] || label="page"
  fi

  local chrome
  if ! chrome=$(see_find_chrome); then
    echo "Error: no Chrome/Chromium found. Install Google Chrome, or point" >&2
    echo "  BOTFERENCE_CHROME at a chrome binary." >&2
    return 1
  fi

  if [ -n "$auth" ]; then
    url=$(echo "$url" | sed -E "s#^(https?://)#\1${auth}@#")
  fi

  [ "${#viewports[@]}" -gt 0 ] || viewports=("390x844" "1440x900")
  out="${out:-.botference/shots}"
  mkdir -p "$out" || return 1

  local ts vp size file rc=0
  ts=$(date +%Y%m%dT%H%M%S)
  for vp in "${viewports[@]}"; do
    if ! [[ "$vp" =~ ^[0-9]+x[0-9]+$ ]]; then
      echo "Error: bad viewport '$vp' (expected WxH, e.g. 390x844)." >&2
      rc=1
      continue
    fi
    size="${vp/x/,}"
    file="${out}/${ts}-${label}-${vp}.png"
    # virtual-time budget fast-forwards timers/network so client-drawn
    # UIs (charts!) finish rendering before the shot is taken
    "$chrome" --headless --disable-gpu --hide-scrollbars \
      --run-all-compositor-stages-before-draw --virtual-time-budget=8000 \
      --window-size="$size" --screenshot="$file" "$url" >/dev/null 2>&1
    if [ -s "$file" ]; then
      echo "wrote: $file"
    else
      echo "Error: no screenshot produced for ${vp} (is the server up? try the URL in a browser)." >&2
      rc=1
    fi
  done
  return "$rc"
}
