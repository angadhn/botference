#!/usr/bin/env bash

# ── botference see ───────────────────────────────────────────
# Eyes for agents (and humans): render a page headless and write PNGs a
# vision-capable model can read back. No Playwright, no new dependency —
# the system Chrome does the work. Layout and design failures produce no
# errors or warnings, so an agent that only reads code and logs will
# ship a page that "works" but looks broken; this closes that loop.
#
# Sandboxed agents cannot launch Chrome (macOS seatbelt kills it —
# "Abort trap 6"). The SAME command still works for them: when the local
# render fails wholesale, `see` hands the job to the see-broker — a
# ledgered service running OUTSIDE any sandbox (`botference see
# --serve`) — via request files in the workspace's .botference/see/
# spool, and prints the broker's identical "wrote: <png>" output.
#
# The target can be a URL, a bare port, or the NAME of a running
# `botference service` (resolved from the ledgers; the listening port is
# read from the live process, so agents never need to know ports).

see_usage() {
  cat <<'HELP'
Usage: botference see <url | :port | service-name> [label] [options]
       botference see --serve

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
  --serve            Run the see-broker: watch every registered
                     workspace's .botference/see/ spool and render
                     requests from sandboxed agents (start it as
                     `botference service start see-broker -- botference see --serve`).
  --help, -h         This help.

Each written file is printed as:  wrote: <path>
Exit is nonzero if any screenshot failed to render.

If Chrome cannot launch here (agent sandboxes), the request is handed
to the running see-broker automatically — same command, same output.
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
    port=$(lsof -aPi -sTCP:LISTEN -p "$pid" 2>/dev/null | awk 'NR>1 {sub(".*:", "", $9); print $9; exit}' || true)
    if [ -z "$port" ]; then
      local kids
      kids=$(pgrep -P "$pid" 2>/dev/null | tr '\n' ',' | sed 's/,$//' || true)
      [ -n "$kids" ] && port=$(lsof -aPi -sTCP:LISTEN -p "$kids" 2>/dev/null | awk 'NR>1 {sub(".*:", "", $9); print $9; exit}' || true)
    fi
    if [ -n "$port" ]; then
      echo "http://localhost:${port}"
      return 0
    fi
  done
  return 1
}

# Is a live see-broker registered in any ledger? (Reads are fine from a
# sandbox; only Chrome itself is not.)
see_broker_alive() {
  local ledger pid
  local ledgers=(".botference/services.json")
  local index="${BOTFERENCE_SERVICE_INDEX:-$HOME/.botference/ledgers}"
  if [ -f "$index" ]; then
    while IFS= read -r ledger; do
      [ -f "$ledger" ] && ledgers+=("$ledger")
    done < "$index"
  fi
  for ledger in "${ledgers[@]}"; do
    [ -f "$ledger" ] || continue
    pid=$(python3 - "$ledger" "see-broker" <<'PY' 2>/dev/null
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
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

# Hand the exact argv to the broker via the workspace spool and relay
# its output verbatim — the caller sees the same "wrote:" lines a local
# render would print. Deterministic: one request file, one result file.
see_via_broker() {
  local req_dir=".botference/see"
  mkdir -p "$req_dir" 2>/dev/null || {
    echo "Error: cannot write ${req_dir}/ here — run see from the workspace root." >&2
    return 1
  }
  local id="$(date +%s)-$$-${RANDOM}"
  local req="${req_dir}/${id}.request" res="${req_dir}/${id}.result"
  python3 - "$req" "$@" <<'PY' || return 1
import json, sys
path = sys.argv[1]
with open(path + ".tmp", "w") as f:
    json.dump({"args": sys.argv[2:]}, f)
import os
os.rename(path + ".tmp", path)
PY
  local waited=0
  while [ ! -f "$res" ]; do
    if [ "$waited" -ge 90 ]; then
      rm -f "$req"
      echo "Error: see-broker did not answer within 90s (service 'see-broker' — is it running?)." >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  local rc=0
  python3 - "$res" <<'PY' || rc=$?
import json, sys
r = json.load(open(sys.argv[1]))
out = r.get("output", "")
if out:
    print(out, end="" if out.endswith("\n") else "\n")
sys.exit(0 if r.get("ok") else 1)
PY
  rm -f "$res"
  return "$rc"
}

# ── the broker: watch every registered workspace's spool ────────────
see_serve() {
  if ! see_find_chrome >/dev/null; then
    echo "Error: see-broker needs Chrome/Chromium on this machine." >&2
    return 1
  fi
  echo "see-broker up — watching .botference/see/ spools of every registered workspace"
  local index="${BOTFERENCE_SERVICE_INDEX:-$HOME/.botference/ledgers}"
  while true; do
    # workspace set: our own cwd plus everything in the ledger index
    local dirs=("$PWD") ledger ws req
    if [ -f "$index" ]; then
      while IFS= read -r ledger; do
        ws=$(dirname "$(dirname "$ledger")")
        [ -d "$ws" ] && dirs+=("$ws")
      done < "$index"
    fi
    local seen="" d
    for d in "${dirs[@]}"; do
      case "$seen" in *"|$d|"*) continue ;; esac
      seen="${seen}|$d|"
      for req in "$d"/.botference/see/*.request; do
        [ -f "$req" ] || continue
        see_serve_one "$d" "$req"
      done
    done
    sleep 1
  done
}

see_serve_one() {
  local ws=$1 req=$2
  local res="${req%.request}.result"
  local args=()
  while IFS= read -r -d '' a; do args+=("$a"); done < <(python3 - "$req" <<'PY' 2>/dev/null
import json, sys
try:
    for a in json.load(open(sys.argv[1])).get("args", []):
        sys.stdout.write(str(a) + "\0")
except Exception:
    pass
PY
)
  rm -f "$req"
  echo "request: ${ws} :: ${args[*]:-<unparseable>}"
  local outfile rc=0
  outfile=$(mktemp "${TMPDIR:-/tmp}/see-out.XXXXXX")
  if [ "${#args[@]}" -eq 0 ]; then
    printf 'Error: unparseable request.\n' > "$outfile"
    rc=1
  else
    # render in the requesting workspace so relative --out paths land
    # where the agent will look; recursion guard keeps this local-only.
    # `|| rc=$?`: one bad request must not kill the broker (set -e)
    (cd "$ws" && BOTFERENCE_SEE_NO_BROKER=1 run_see_mode "${args[@]}") > "$outfile" 2>&1 || rc=$?
  fi
  python3 - "$res" "$rc" "$outfile" <<'PY'
import json, os, sys
with open(sys.argv[3], encoding="utf-8", errors="replace") as f:
    output = f.read()
with open(sys.argv[1] + ".tmp", "w") as f:
    json.dump({"ok": int(sys.argv[2]) == 0, "output": output}, f)
os.rename(sys.argv[1] + ".tmp", sys.argv[1])
PY
  rm -f "$outfile"
}

run_see_mode() {
  local target="" label="" out="" auth="" serve=false
  local viewports=()
  local argv=("$@")
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h) see_usage; return 0 ;;
      --serve) serve=true ;;
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

  if $serve; then
    see_serve
    return $?
  fi

  if [ -z "$target" ]; then
    see_usage >&2
    return 2
  fi

  # Sandboxed callers (or tests) can skip the doomed local Chrome attempt
  if [ -z "${BOTFERENCE_SEE_NO_BROKER:-}" ] && [ -n "${BOTFERENCE_SEE_FORCE_BROKER:-}" ]; then
    if see_broker_alive; then
      see_via_broker "${argv[@]}"
      return $?
    fi
    echo "Error: BOTFERENCE_SEE_FORCE_BROKER is set but no see-broker service is alive." >&2
    echo "  Ask the machine owner to run:  botference service start see-broker -- botference see --serve" >&2
    return 1
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

  local chrome=""
  chrome=$(see_find_chrome) || chrome=""

  if [ -n "$auth" ]; then
    url=$(echo "$url" | sed -E "s#^(https?://)#\1${auth}@#")
  fi

  [ "${#viewports[@]}" -gt 0 ] || viewports=("390x844" "1440x900")
  out="${out:-.botference/shots}"
  mkdir -p "$out" || return 1

  local ts vp size file rc=0 wrote=0 attempted=0
  ts=$(date +%Y%m%dT%H%M%S)
  for vp in "${viewports[@]}"; do
    if ! [[ "$vp" =~ ^[0-9]+x[0-9]+$ ]]; then
      echo "Error: bad viewport '$vp' (expected WxH, e.g. 390x844)." >&2
      rc=1
      continue
    fi
    attempted=$((attempted + 1))
    [ -n "$chrome" ] || continue
    size="${vp/x/,}"
    file="${out}/${ts}-${label}-${vp}.png"
    # virtual-time budget fast-forwards timers/network so client-drawn
    # UIs (charts!) finish rendering before the shot is taken
    # `|| true`: the launcher runs `set -e`, and a sandbox-killed Chrome
    # must fall through to the broker lane, not abort the script
    "$chrome" --headless --disable-gpu --hide-scrollbars \
      --run-all-compositor-stages-before-draw --virtual-time-budget=8000 \
      --window-size="$size" --screenshot="$file" "$url" >/dev/null 2>&1 || true
    if [ -s "$file" ]; then
      echo "wrote: $file"
      wrote=$((wrote + 1))
    else
      rc=1
    fi
  done

  # Local Chrome produced nothing at all (sandbox kills it, or no Chrome
  # here): same command, second lane — hand the argv to the see-broker.
  if [ "$wrote" -eq 0 ] && [ "$attempted" -gt 0 ] && [ -z "${BOTFERENCE_SEE_NO_BROKER:-}" ]; then
    if see_broker_alive; then
      echo "  (local Chrome unavailable here — handing to the see-broker)" >&2
      see_via_broker "${argv[@]}"
      return $?
    fi
    if [ -z "$chrome" ]; then
      echo "Error: no Chrome/Chromium found and no see-broker service is running." >&2
    else
      echo "Error: Chrome could not render here (sandbox?) and no see-broker service is running." >&2
    fi
    echo "  Ask the machine owner to run:  botference service start see-broker -- botference see --serve" >&2
    return 1
  fi
  if [ "$wrote" -lt "$attempted" ] && [ "$wrote" -gt 0 ]; then
    echo "Error: some viewports failed to render (is the server up?)." >&2
  fi
  return "$rc"
}
