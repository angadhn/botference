#!/usr/bin/env bash

# ── botference discuss (a.k.a. plugin) ───────────────────────
# Serves the Discuss companion (frontends/plugin/server.mjs): the
# local backend for the browser extension — annotation storage, Obsidian
# export, and the agent bridge that answers @claude/@codex mentions made
# on web pages. The launcher stays thin: all behavior lives in the node
# server. Sessions created by mentions land in this workspace's council
# under the "Plugin pages" project, so run it from your main workspace.

plugin_usage() {
  cat <<'HELP'
Usage: botference discuss [--port N] [--service] [--no-agents] [--agents] [--here]
       botference discuss --share [--service]
       botference discuss --hosted [--service]
       botference discuss --install-autostart [--port N] [--no-agents]
       botference discuss --uninstall-autostart
       botference discuss --install-tunnel [--port N] [--no-agents]
       botference discuss --uninstall-tunnel

('botference plugin' is the same command, and always will be — the
product is called Discuss, the plumbing is still called plugin.)

Serve the Discuss companion server for the browser extension
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

One permanent address (macOS + a Cloudflare-hosted domain), so the
annotations have a URL you can bookmark on your phone instead of a fresh
random tunnel every session:
  --install-tunnel    Give the companion a permanent public address:
                      creates (or reuses) the named cloudflared tunnel
                      'botference-plugin', routes DNS for
                      discuss.botference.com to it, writes
                      ~/.cloudflared/botference-plugin.yml, installs a
                      second LaunchAgent (com.botference.plugin-tunnel)
                      that runs the tunnel at every login, and switches
                      the companion's own LaunchAgent to --hosted with a
                      password generated once and kept in
                      ~/.botference/plugin-password (0600, never in the
                      plist). Prints the URL and the password.
                      plugin.botference.com — the address before the
                      rename — is routed and served alongside it, so old
                      bookmarks and extensions keep working.
  --uninstall-tunnel  Stop and remove the tunnel LaunchAgent and put the
                      companion back to plain localhost mode. The
                      Cloudflare tunnel and its DNS records are left
                      alone, so re-installing is one command
Override the address with BOTFERENCE_PLUGIN_HOSTNAME (the legacy one with
BOTFERENCE_PLUGIN_LEGACY_HOSTNAME, empty to drop it) and the tunnel name
with BOTFERENCE_PLUGIN_TUNNEL, if the domain is not this one.
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
    echo "📦 workspace: ${PLUGIN_WS}  (run with --here to use the current directory instead)"
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
    echo "✗ login autostart uses launchd — macOS only." >&2
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
    echo "✗ could not write the LaunchAgent plist." >&2
    return 1
  }
  if command -v plutil >/dev/null 2>&1 && ! plutil -lint "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "✗ the generated plist failed plutil -lint — refusing to install." >&2
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
    echo "✗ launchctl could not load ${plist}." >&2
    echo "   try by hand: launchctl bootstrap ${domain} ${plist}" >&2
    return 1
  fi

  # --install-tunnel installs this same agent as one step of a longer story
  # and prints its own ending, so it asks for the work without the speech.
  if [ "${PLUGIN_AUTOSTART_QUIET:-false}" = true ]; then return 0; fi

  echo ""
  echo "✅ Login autostart installed — the web annotator companion now starts at every login, and restarts if it dies."
  echo ""
  if $takeover; then
    echo "🟢 A companion is already running in a terminal — the autostart copy takes"
    echo "   over within ~10s after you Ctrl-C it (or at the next login)."
  else
    echo "🟢 It is starting now, and again at every login."
  fi
  echo ""
  echo "▶  Next steps"
  echo "   1. load the browser extension (once): brave://extensions → Developer mode →"
  echo "      Load unpacked → ${BOTFERENCE_HOME}/frontends/plugin/extension"
  echo "   2. want bot replies? log into the agent CLIs — 'claude' and/or 'codex' —"
  echo "      so @claude/@codex in a comment is answered"
  echo "   3. highlight text on any article page to leave your first annotation"
  echo ""
  echo "🧩 For reference"
  echo "   workspace: ${workspace}"
  echo "   port:      ${url_port}$([ "$#" -gt 0 ] && printf '   args: %s' "$*")"
  echo "   plist:     ${plist}"
  echo "   logs:      ${log}"
  echo "   check it:  launchctl list | grep ${PLUGIN_AUTOSTART_LABEL}"
  echo "   remove it: botference plugin --uninstall-autostart"
  echo "   label:     ${PLUGIN_AUTOSTART_LABEL}"
  echo ""
}

# ── permanent public address (named cloudflared tunnel) ──────────
# --share is a conversation: a random trycloudflare URL that dies with the
# terminal. This is the other proposition — ONE address, forever, so the
# annotations can be a bookmark on a phone. A named Cloudflare tunnel owns
# plugin.botference.com and dials out from this machine (no ports opened, no
# inbound anything), a second LaunchAgent keeps it up, and the companion's own
# LaunchAgent moves to --hosted so the password gate is what strangers meet.
#
# The password is generated once and lives in a 0600 file, never in the plist:
# launchd starts the LAUNCHER, and the launcher reads the file. A plist is
# world-readable and gets backed up; a secret does not belong in one.

PLUGIN_TUNNEL_LABEL="com.botference.plugin-tunnel"
PLUGIN_TUNNEL_NAME="${BOTFERENCE_PLUGIN_TUNNEL:-botference-plugin}"
# The product is called Discuss and lives at discuss.botference.com. Only the
# NAME moved: the label, the tunnel, the data directories and the command are
# all still 'plugin', because renaming those would cost a migration and buy
# nothing. plugin.botference.com stays routed as a legacy door so a bookmark or
# a configured extension made before the rename keeps working.
PLUGIN_TUNNEL_HOSTNAME="${BOTFERENCE_PLUGIN_HOSTNAME:-discuss.botference.com}"
PLUGIN_TUNNEL_LEGACY_HOSTNAME="${BOTFERENCE_PLUGIN_LEGACY_HOSTNAME-plugin.botference.com}"
PLUGIN_TUNNEL_DIR="${HOME}/.cloudflared"
PLUGIN_TUNNEL_CONFIG="${PLUGIN_TUNNEL_DIR}/${PLUGIN_TUNNEL_NAME}.yml"
PLUGIN_PASSWORD_FILE="${HOME}/.botference/plugin-password"

# A password for a person holding a phone, not a hex blob: four random words
# and a number, crypto-random (never $RANDOM). The system dictionary gives
# tens of thousands of candidates when it is there; the built-in list is the
# fallback so this never fails on a machine without one.
_plugin_generate_password() {
  node - <<'JS'
const crypto = require('crypto'), fs = require('fs');
const FALLBACK = `amber anchor apple arbor arrow autumn basil beacon birch bloom
  bramble bridge bronze burrow canyon cedar cinder cirrus clever cobalt copper
  coral cotton crater crimson crocus dahlia damson dapple delta dune ember
  fable falcon fennel fern ferry flint forest fossil garnet gentle glacier
  granite gravel harbor hazel heather hollow indigo ivory jasper juniper kernel
  lantern laurel ledger lichen lilac linen lobster locket lumen lupin marble
  meadow medlar mercy minnow mirror morrow mosaic myrtle nectar nettle nimbus
  nutmeg olive onyx opal orchard osprey otter parcel pebble pewter pigment
  pilot pillar plover plumb pollen poplar prairie quarry quartz quiver ramble
  raven ribbon rivet rosewood rudder saffron sage sandal sapling scarlet
  sequoia shale sierra silver sorrel spruce stellar sumac summit sundial
  syrup tamarind teal tempo thicket thistle timber topaz trellis tundra umber
  valley velvet vessel violet walnut warbler weaver wicker willow window
  winter wisteria yarrow yonder zephyr zinnia`.split(/\s+/).filter(Boolean);
let words = [];
for (const f of ['/usr/share/dict/words', '/usr/dict/words']) {
  try {
    const w = fs.readFileSync(f, 'utf8').split('\n').filter(x => /^[a-z]{4,7}$/.test(x));
    if (w.length >= 2048) { words = w; break; }
  } catch { }
}
if (!words.length) words = FALLBACK;
const pick = () => words[crypto.randomInt(words.length)];
console.log([pick(), pick(), pick(), pick(), String(crypto.randomInt(10, 100))].join('-'));
JS
}

# The hosted password, on stdout. Read it if it is there, mint it if it is not
# — an existing one is never replaced, because it is written down elsewhere by
# now (a phone's password manager, a note) and rotating it silently would lock
# the owner out of their own bookmark.
_plugin_password_ensure() {
  local pw
  if [ -s "$PLUGIN_PASSWORD_FILE" ]; then
    head -1 "$PLUGIN_PASSWORD_FILE"
    return 0
  fi
  mkdir -p "$(dirname "$PLUGIN_PASSWORD_FILE")" || return 1
  pw=$(_plugin_generate_password) || return 1
  [ -n "$pw" ] || return 1
  (umask 077; printf '%s\n' "$pw" > "$PLUGIN_PASSWORD_FILE") || return 1
  chmod 600 "$PLUGIN_PASSWORD_FILE" 2>/dev/null || true
  printf '%s\n' "$pw"
}

_plugin_password_read() {
  [ -s "$PLUGIN_PASSWORD_FILE" ] || return 1
  head -1 "$PLUGIN_PASSWORD_FILE"
}

# The OWNER's credential, which is not this file at all: it is the one the
# review hub hands to every paper server (frontends/plugin/identity.mjs), so
# the same thing typed at a review doc signs you in here. Printed at install
# so the phone knows what to expect; generated on first use if the hub never
# got there first.
_plugin_owner_password() {
  node -e 'import(process.argv[1]).then(m => console.log(m.ownerPassword()))' \
    "${BOTFERENCE_HOME}/frontends/plugin/identity.mjs" 2>/dev/null
}

# Emit the cloudflared config on stdout. Pure function of its arguments.
#   plugin_tunnel_config <tunnel-uuid> <credentials-file> <port> <hostname…>
# Every hostname gets its own ingress rule to the same local service, which is
# how the canonical address and the legacy one are the same companion rather
# than a redirect. The catch-all 404 is not decoration: without it cloudflared
# refuses to start, and with it a request for any other hostname routed at this
# tunnel is answered rather than handed to the companion.
plugin_tunnel_config() {
  local uuid=$1 creds=$2 port=$3
  shift 3
  printf '%s\n' '# botference Discuss — companion, permanent public address.'
  printf '%s\n' "# Written by 'botference discuss --install-tunnel'; edit at your own risk."
  printf 'tunnel: %s\n' "$uuid"
  printf 'credentials-file: %s\n' "$creds"
  printf '%s\n' 'no-autoupdate: true'
  printf '%s\n' 'ingress:'
  local h
  for h in "$@"; do
    [ -n "$h" ] || continue
    printf '  - hostname: %s\n' "$h"
    printf '    service: http://127.0.0.1:%s\n' "$port"
  done
  printf '%s\n' '  - service: http_status:404'
}

# Emit the tunnel LaunchAgent XML on stdout. Same shape as the companion's:
# pure, so it can be linted before it is installed.
#   plugin_tunnel_plist <label> <cloudflared-path> <config-file> <log>
plugin_tunnel_plist() {
  local label=$1 bin=$2 config=$3 log=$4
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0">'
  printf '%s\n' '<dict>'
  printf '  <key>Label</key>\n  <string>%s</string>\n' "$(_plugin_xml_escape "$label")"
  printf '%s\n' '  <key>ProgramArguments</key>'
  printf '%s\n' '  <array>'
  local a
  for a in "$bin" tunnel --no-autoupdate --config "$config" run; do
    printf '    <string>%s</string>\n' "$(_plugin_xml_escape "$a")"
  done
  printf '%s\n' '  </array>'
  printf '%s\n' '  <key>EnvironmentVariables</key>'
  printf '%s\n' '  <dict>'
  printf '    <key>HOME</key>\n    <string>%s</string>\n' "$(_plugin_xml_escape "$HOME")"
  printf '    <key>TUNNEL_ORIGIN_CERT</key>\n    <string>%s</string>\n' \
    "$(_plugin_xml_escape "${HOME}/.cloudflared/cert.pem")"
  printf '%s\n' '  </dict>'
  printf '%s\n' '  <key>RunAtLoad</key>'
  printf '%s\n' '  <true/>'
  # Unconditional KeepAlive, unlike the companion's: a tunnel that exits
  # cleanly (network gone, edge closed the connection) must still come back.
  printf '%s\n' '  <key>KeepAlive</key>'
  printf '%s\n' '  <true/>'
  printf '%s\n' '  <key>ThrottleInterval</key>'
  printf '%s\n' '  <integer>10</integer>'
  printf '  <key>StandardOutPath</key>\n  <string>%s</string>\n' "$(_plugin_xml_escape "$log")"
  printf '  <key>StandardErrorPath</key>\n  <string>%s</string>\n' "$(_plugin_xml_escape "$log")"
  printf '%s\n' '</dict>'
  printf '%s\n' '</plist>'
}

# The UUID of a named tunnel, or nothing at all. `cloudflared tunnel list`
# is the only reliable read — `create` on an existing name is an error, so
# looking first is what makes the install idempotent.
_plugin_tunnel_id() {
  local name=$1 json
  json=$(cloudflared tunnel list --output json 2>/dev/null) || return 1
  printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", d => { s += d; }).on("end", () => {
  let list = [];
  try { list = JSON.parse(s); } catch { }
  if (!Array.isArray(list)) list = [];
  // live tunnels carry deleted_at "0001-01-01T00:00:00Z" (Go zero time), not null
  const gone = d => d && !String(d).startsWith("0001-");
  const t = list.find(x => x && x.name === process.argv[1] && !gone(x.deleted_at));
  if (t && t.id) console.log(t.id);
});' "$name"
}

# launchctl bootout + rm, for either of our labels. Prints nothing.
_plugin_launchagent_remove() {
  local label=$1 plist="${PLUGIN_AUTOSTART_DIR}/${1}.plist"
  local domain="gui/$(id -u)"
  launchctl bootout "${domain}/${label}" >/dev/null 2>&1 || true
  [ -f "$plist" ] && launchctl unload -w "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
}

# Write, lint and load a LaunchAgent whose XML is already on disk at $2.
_plugin_launchagent_load() {
  local plist=$1 tmp=$2
  if command -v plutil >/dev/null 2>&1 && ! plutil -lint "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "✗ the generated plist failed plutil -lint — refusing to install." >&2
    return 1
  fi
  mv "$tmp" "$plist"
  local domain="gui/$(id -u)"
  launchctl bootout "${domain}/$(basename "${plist%.plist}")" >/dev/null 2>&1 || true
  launchctl unload "$plist" >/dev/null 2>&1 || true
  if launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then return 0; fi
  if launchctl load -w "$plist" >/dev/null 2>&1; then return 0; fi
  echo "✗ launchctl could not load ${plist}." >&2
  echo "   try by hand: launchctl bootstrap ${domain} ${plist}" >&2
  return 1
}

# The companion LaunchAgent's own record of how it was installed, so
# --install-tunnel can add --hosted to it (and --uninstall-tunnel take it
# away) without asking the user to repeat --port/--no-agents, and without
# caring which directory either command is run from. Arguments are flags to
# DROP from what it finds (so adding --hosted can never add it twice).
#   sets PLUGIN_INSTALLED_WS, PLUGIN_INSTALLED_ARGS (array),
#        PLUGIN_INSTALLED_PORT ("" when the agent takes the default);
#        returns 1 when no companion agent is installed
_plugin_read_installed_agent() {
  local plist="${PLUGIN_AUTOSTART_DIR}/${PLUGIN_AUTOSTART_LABEL}.plist"
  PLUGIN_INSTALLED_WS=""
  PLUGIN_INSTALLED_ARGS=()
  PLUGIN_INSTALLED_PORT=""
  [ -f "$plist" ] || return 1
  command -v plutil >/dev/null 2>&1 || return 1
  PLUGIN_INSTALLED_WS=$(plutil -extract WorkingDirectory raw -o - "$plist" 2>/dev/null) || return 1
  local args_json line
  args_json=$(plutil -extract ProgramArguments json -o - "$plist" 2>/dev/null) || return 1
  # everything after the 'plugin' mode word is the flag set we must preserve
  while IFS= read -r line; do
    [ -n "$line" ] && PLUGIN_INSTALLED_ARGS+=("$line")
  # the drop list travels in the environment, not argv: node would read a bare
  # '--hosted' on its own command line as one of ITS options
  done < <(printf '%s' "$args_json" | PLUGIN_DROP="$*" node -e '
let s = "";
process.stdin.on("data", d => { s += d; }).on("end", () => {
  let a = [];
  try { a = JSON.parse(s); } catch { }
  if (!Array.isArray(a)) a = [];
  const i = a.indexOf("plugin");
  const drop = new Set((process.env.PLUGIN_DROP || "").split(/\s+/).filter(Boolean));
  for (const x of (i < 0 ? [] : a.slice(i + 1))) if (!drop.has(String(x))) console.log(x);
});')
  # --port comes in either spelling; the launcher writes the two-word one
  local n=${#PLUGIN_INSTALLED_ARGS[@]} i=0
  while [ "$i" -lt "$n" ]; do
    case "${PLUGIN_INSTALLED_ARGS[$i]}" in
      --port=*) PLUGIN_INSTALLED_PORT="${PLUGIN_INSTALLED_ARGS[$i]#--port=}" ;;
      --port) [ $((i + 1)) -lt "$n" ] && PLUGIN_INSTALLED_PORT="${PLUGIN_INSTALLED_ARGS[$((i + 1))]}" ;;
    esac
    i=$((i + 1))
  done
  return 0
}

plugin_tunnel_install() {
  local port=$1
  shift
  _plugin_require_macos || return 1
  local url_port=${port:-4189}
  local workspace="${BOTFERENCE_PROJECT_ROOT:-$(pwd -P)}"

  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "✗ 'cloudflared' not found on PATH — the permanent address is a Cloudflare tunnel." >&2
    echo "   install it first:  brew install cloudflared" >&2
    return 1
  fi
  local cfd
  cfd=$(command -v cloudflared)
  if [ ! -f "${PLUGIN_TUNNEL_DIR}/cert.pem" ]; then
    echo "✗ cloudflared is not logged in to your Cloudflare account." >&2
    echo "   run this once (it opens a browser; pick the zone for ${PLUGIN_TUNNEL_HOSTNAME#*.}):" >&2
    echo "     cloudflared tunnel login" >&2
    return 1
  fi

  # A companion LaunchAgent that is already installed decides the workspace and
  # the port — this command adds an address to the companion the user has, it
  # does not re-answer questions they already answered. Its flags come back
  # with --hosted stripped so we can add exactly one.
  local boot_args=(--hosted)
  if _plugin_read_installed_agent --hosted; then
    workspace="${PLUGIN_INSTALLED_WS:-$workspace}"
    # what it already had, then anything given here — the launcher's own
    # parser is last-wins, so an explicit --port/--no-agents still overrides
    boot_args=(--hosted ${PLUGIN_INSTALLED_ARGS[@]+"${PLUGIN_INSTALLED_ARGS[@]}"} ${@+"$@"})
    if [ -z "$port" ] && [ -n "$PLUGIN_INSTALLED_PORT" ]; then
      port="$PLUGIN_INSTALLED_PORT"
      url_port="$port"
    fi
  else
    boot_args+=(${@+"$@"})
  fi

  local logdir="${workspace}/.botference/logs"
  local tunnel_log="${logdir}/plugin-tunnel.log"
  mkdir -p "$logdir" "$PLUGIN_TUNNEL_DIR" "$PLUGIN_AUTOSTART_DIR" || return 1

  echo ""
  echo "🌐 Giving Discuss a permanent address: https://${PLUGIN_TUNNEL_HOSTNAME}"
  echo ""

  # 1. the tunnel itself — reuse before create, so this is safe to re-run
  local uuid created=false
  uuid=$(_plugin_tunnel_id "$PLUGIN_TUNNEL_NAME" 2>/dev/null || true)
  if [ -n "$uuid" ]; then
    echo "   1/6 tunnel '${PLUGIN_TUNNEL_NAME}' already exists — reusing it (${uuid})"
  else
    if ! cloudflared tunnel create "$PLUGIN_TUNNEL_NAME" >/dev/null 2>&1; then
      echo "✗ 'cloudflared tunnel create ${PLUGIN_TUNNEL_NAME}' failed." >&2
      echo "   run it by hand to see why." >&2
      return 1
    fi
    uuid=$(_plugin_tunnel_id "$PLUGIN_TUNNEL_NAME" 2>/dev/null || true)
    if [ -z "$uuid" ]; then
      echo "✗ created the tunnel but cannot find its id in 'cloudflared tunnel list'." >&2
      return 1
    fi
    created=true
    echo "   1/6 created tunnel '${PLUGIN_TUNNEL_NAME}' (${uuid})"
  fi

  local creds="${PLUGIN_TUNNEL_DIR}/${uuid}.json"
  if [ ! -f "$creds" ]; then
    echo "✗ no credentials file for that tunnel at ${creds}." >&2
    echo "   the tunnel exists in your Cloudflare account but this machine holds no key" >&2
    echo "   for it. Either copy the credentials here, or delete and recreate it:" >&2
    echo "     cloudflared tunnel delete ${PLUGIN_TUNNEL_NAME} && botference plugin --install-tunnel" >&2
    return 1
  fi

  # 2. DNS — a CNAME for the hostname at <uuid>.cfargotunnel.com. Already
  # pointing at this tunnel is success, not failure.
  #   _plugin_route_dns <hostname> ; 0 = routed (or already was)
  _plugin_route_dns() {
    local host=$1 out rc=0
    out=$(cloudflared tunnel route dns "$PLUGIN_TUNNEL_NAME" "$host" 2>&1) || rc=$?
    if [ "$rc" -eq 0 ]; then
      PLUGIN_DNS_NOTE="${host} → this tunnel"
      return 0
    fi
    if printf '%s' "$out" | grep -qiE 'already (exists|configured)|record with that host'; then
      PLUGIN_DNS_NOTE="${host} was already routed here"
      return 0
    fi
    PLUGIN_DNS_NOTE="$out"
    return 1
  }
  if ! _plugin_route_dns "$PLUGIN_TUNNEL_HOSTNAME"; then
    echo "✗ could not route ${PLUGIN_TUNNEL_HOSTNAME} to the tunnel:" >&2
    printf '   %s\n' "$PLUGIN_DNS_NOTE" >&2
    echo "   (is ${PLUGIN_TUNNEL_HOSTNAME#*.} a zone on this Cloudflare account?)" >&2
    return 1
  fi
  echo "   2/6 DNS: ${PLUGIN_DNS_NOTE}"
  # The legacy door is a courtesy, not a requirement: if it cannot be routed
  # (a fresh account, a zone that is not yours) say so and carry on.
  local legacy_ok=false
  if [ -n "$PLUGIN_TUNNEL_LEGACY_HOSTNAME" ] \
    && [ "$PLUGIN_TUNNEL_LEGACY_HOSTNAME" != "$PLUGIN_TUNNEL_HOSTNAME" ]; then
    if _plugin_route_dns "$PLUGIN_TUNNEL_LEGACY_HOSTNAME"; then
      legacy_ok=true
      echo "       also: ${PLUGIN_DNS_NOTE}  (the old address, still answered)"
    else
      echo "       note: ${PLUGIN_TUNNEL_LEGACY_HOSTNAME} could not be routed — skipping it."
      echo "             the new address is unaffected."
    fi
  fi

  # 3. the ingress config — one rule per hostname, all to the same companion
  local hosts=("$PLUGIN_TUNNEL_HOSTNAME")
  $legacy_ok && hosts+=("$PLUGIN_TUNNEL_LEGACY_HOSTNAME")
  local cfg_tmp="${PLUGIN_TUNNEL_CONFIG}.tmp.$$"
  plugin_tunnel_config "$uuid" "$creds" "$url_port" "${hosts[@]}" > "$cfg_tmp" || {
    rm -f "$cfg_tmp"
    echo "✗ could not write ${PLUGIN_TUNNEL_CONFIG}." >&2
    return 1
  }
  mv "$cfg_tmp" "$PLUGIN_TUNNEL_CONFIG"
  echo "   3/6 config: ${PLUGIN_TUNNEL_CONFIG} → http://127.0.0.1:${url_port}"
  [ "${#hosts[@]}" -gt 1 ] && echo "       serving ${#hosts[@]} hostnames: ${hosts[*]}"

  # 4. the password — once, ever
  local pw fresh=false
  [ -s "$PLUGIN_PASSWORD_FILE" ] || fresh=true
  pw=$(_plugin_password_ensure) || {
    echo "✗ could not create ${PLUGIN_PASSWORD_FILE}." >&2
    return 1
  }
  if $fresh; then
    echo "   4/6 password: generated one and saved it to ${PLUGIN_PASSWORD_FILE}"
  else
    echo "   4/6 password: keeping the one already in ${PLUGIN_PASSWORD_FILE}"
  fi

  # 5. the companion, in hosted mode. Rebuilt from the installed agent when
  # there is one (so --port/--no-agents survive), otherwise from this call.
  BOTFERENCE_PROJECT_ROOT="$workspace" PLUGIN_AUTOSTART_QUIET=true \
    plugin_autostart_install "$port" ${boot_args[@]+"${boot_args[@]}"} || return 1
  echo "   5/6 companion: ${PLUGIN_AUTOSTART_LABEL} now runs --hosted (workspace ${workspace})"

  # 6. the tunnel LaunchAgent
  local tplist="${PLUGIN_AUTOSTART_DIR}/${PLUGIN_TUNNEL_LABEL}.plist"
  local tmp="${tplist}.tmp.$$"
  plugin_tunnel_plist "$PLUGIN_TUNNEL_LABEL" "$cfd" "$PLUGIN_TUNNEL_CONFIG" "$tunnel_log" > "$tmp" || {
    rm -f "$tmp"
    echo "✗ could not write the tunnel LaunchAgent plist." >&2
    return 1
  }
  _plugin_launchagent_load "$tplist" "$tmp" || return 1
  echo "   6/6 tunnel agent: ${PLUGIN_TUNNEL_LABEL} runs it at every login"

  local owner_pw
  owner_pw=$(_plugin_owner_password || true)

  echo ""
  echo "✅ Done — Discuss now lives at one address that does not change."
  echo ""
  echo "🔗 https://${PLUGIN_TUNNEL_HOSTNAME}/pages   ← the canonical address"
  if $legacy_ok; then
    echo "   https://${PLUGIN_TUNNEL_LEGACY_HOSTNAME}/pages   (the old one, still answered —"
    echo "   same companion, same annotations; bookmark the one above)"
  fi
  if [ -n "$owner_pw" ]; then
    echo "🔑 you (owner):   ${owner_pw}"
    echo "   ↑ the SAME password your review docs use — sign in with it and you have"
    echo "     every owner right here too (export, delete, agent controls, bots)."
    echo "     A browser you already approved for the review hub needs no password at all."
    echo "🔑 collaborators: ${pw}   (guests: read, comment, bots only where granted)"
  else
    echo "🔑 password: ${pw}"
  fi
  echo ""
  echo "▶  Next steps"
  echo "   1. bookmark that URL on your phone; sign in with any name + the password"
  echo "   2. DNS and the tunnel can take a minute to meet — if it 502s, wait and retry"
  echo "   3. give a collaborator bot access by naming them in"
  echo "      ${workspace}/.botference/plugin/grants.json (read live, no restart):"
  echo '      {"ada": {"agents": true, "daily_cap": 5}}'
  echo ""
  echo "🧩 For reference"
  echo "   this machine is still the owner on http://127.0.0.1:${url_port}/ — no password there"
  echo "   guest password: ${PLUGIN_PASSWORD_FILE}  (0600; never written into a plist)"
  echo "   owner password: ~/.botference/review-paper-secrets.json  (shared with the review hub)"
  echo "   tunnel config: ${PLUGIN_TUNNEL_CONFIG}"
  echo "   tunnel logs:   ${tunnel_log}"
  echo "   companion:     ${workspace}/.botference/logs/plugin-autostart.log"
  echo "   check both:    launchctl list | grep com.botference"
  echo "   remove it:     botference plugin --uninstall-tunnel"
  $created && echo "   tunnel '${PLUGIN_TUNNEL_NAME}' (${uuid}) is new in your Cloudflare account"
  echo ""
}

plugin_tunnel_uninstall() {
  _plugin_require_macos || return 1
  local tplist="${PLUGIN_AUTOSTART_DIR}/${PLUGIN_TUNNEL_LABEL}.plist"
  local had_tunnel=false
  [ -f "$tplist" ] && had_tunnel=true
  _plugin_launchagent_remove "$PLUGIN_TUNNEL_LABEL"

  echo ""
  if $had_tunnel; then
    echo "🗑  Public address off: ${PLUGIN_TUNNEL_LABEL} stopped and removed."
    echo "   deleted: ${tplist}"
  else
    echo "✅ No tunnel LaunchAgent was installed — nothing to stop."
    echo "   looked for: ${tplist}"
  fi

  # Put the companion back to plain localhost mode, keeping everything else
  # about how it was installed. No companion agent installed = nothing to do;
  # this command never installs one.
  local restored=false
  if _plugin_read_installed_agent --hosted; then
    if BOTFERENCE_PROJECT_ROOT="${PLUGIN_INSTALLED_WS}" PLUGIN_AUTOSTART_QUIET=true \
      plugin_autostart_install "$PLUGIN_INSTALLED_PORT" \
      ${PLUGIN_INSTALLED_ARGS[@]+"${PLUGIN_INSTALLED_ARGS[@]}"}; then
      restored=true
    fi
  fi
  if $restored; then
    echo "   ${PLUGIN_AUTOSTART_LABEL} is back to plain localhost mode (no password gate)"
  fi
  echo ""
  echo "💡 The Cloudflare tunnel and the DNS records for ${PLUGIN_TUNNEL_HOSTNAME} are"
  echo "   deliberately left in place, so 'botference plugin --install-tunnel' brings"
  echo "   the address straight back. To remove them from your account as well:"
  echo "     cloudflared tunnel delete ${PLUGIN_TUNNEL_NAME}"
  echo "     # then delete the ${PLUGIN_TUNNEL_HOSTNAME} CNAME in the Cloudflare dashboard"
  echo "     #      (and ${PLUGIN_TUNNEL_LEGACY_HOSTNAME}, if you routed the old address too)"
  echo "   Your password stays in ${PLUGIN_PASSWORD_FILE} (delete it to mint a new one)."
  echo ""
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
    echo ""
    echo "🗑  Login autostart removed: ${PLUGIN_AUTOSTART_LABEL}"
    echo "   deleted: ${plist}"
    $unloaded && echo "   the autostart companion (if it was running) has been stopped."
    echo ""
    echo "💡 A companion you run by hand ('botference plugin') is unaffected."
    echo ""
  else
    echo ""
    $unloaded && echo "🗑  Unloaded a stray ${PLUGIN_AUTOSTART_LABEL} job (no plist on disk)."
    echo "✅ Nothing to remove — no login autostart was installed."
    echo "   looked for: ${plist}"
    echo ""
  fi
}

run_plugin_mode() {
  local port="" service=false agents="auto" autostart="" tunnel="" arg
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
      --install-tunnel) tunnel="install" ;;
      --uninstall-tunnel) tunnel="uninstall" ;;
      --no-agents) agents="off" ;;
      --agents) agents="on" ;;
      --hosted) hosted=true ;;
      --share) share=true; hosted=true ;;
      --here) here=true ;;
      --port=*) port="${arg#--port=}" ;;
      --port)
        if [ "$#" -eq 0 ]; then
          echo "✗ --port requires a number." >&2
          return 2
        fi
        port=$1
        shift
        ;;
      --help|-h) plugin_usage; return 0 ;;
      *)
        echo "✗ unknown plugin option '$arg'" >&2
        echo "   see 'botference plugin --help' for the full list." >&2
        return 2
        ;;
    esac
  done

  if [ -n "$port" ] && ! [[ "$port" =~ ^[0-9]+$ ]]; then
    echo "✗ --port expects a number, got '$port'." >&2
    return 2
  fi

  # --- sharing and login autostart are different propositions ---
  # A LaunchAgent would have to carry the shared password in a plist that
  # launchd reads at every login; sharing is a thing you start on purpose
  # and stop when the conversation is over.
  if [ -n "$autostart" ] && { $hosted || $share; }; then
    echo "✗ --install-autostart cannot be combined with --hosted/--share." >&2
    echo "   Autostart runs the private local companion at login; start a share by hand" >&2
    echo "   when you want one: botference plugin --share" >&2
    return 2
  fi
  # --- the permanent address is its own lifecycle too ---
  if [ -n "$tunnel" ]; then
    if $service || [ -n "$autostart" ] || $hosted || $share; then
      echo "✗ --${tunnel}-tunnel is a one-off install, not a way to start a server." >&2
      echo "   Run it on its own: botference plugin --${tunnel}-tunnel" >&2
      echo "   (it installs the LaunchAgents itself, and puts the companion in hosted mode)" >&2
      return 2
    fi
  fi

  # --- hosted with no password in hand: the tunnel install left one on disk ---
  # launchd runs THIS launcher, not the node server, precisely so the secret can
  # be read from a 0600 file at start instead of sitting in a plist.
  if $hosted && ! $share && [ -z "${PLUGIN_PASSWORD:-}" ]; then
    PLUGIN_PASSWORD=$(_plugin_password_read || true)
  fi
  if $hosted && ! $share && [ -z "${PLUGIN_PASSWORD:-}" ]; then
    echo "✗ --hosted requires PLUGIN_PASSWORD to be set, e.g." >&2
    echo "   PLUGIN_PASSWORD=… botference plugin --hosted" >&2
    echo "   (or use --share, which generates one and opens a tunnel for you;" >&2
    echo "    or --install-tunnel, which saves one in ${PLUGIN_PASSWORD_FILE})" >&2
    return 2
  fi

  # --- login autostart: a different lifecycle from --service, never both ---
  if [ -n "$autostart" ]; then
    if $service; then
      echo "✗ --${autostart}-autostart cannot be combined with --service." >&2
      echo "   --service is a per-session managed process; autostart is a login LaunchAgent." >&2
      return 2
    fi
    if [ "$autostart" = "uninstall" ]; then
      plugin_autostart_uninstall
      return $?
    fi
  fi
  if [ "$tunnel" = "uninstall" ]; then
    plugin_tunnel_uninstall
    return $?
  fi

  local engine="${BOTFERENCE_HOME}/frontends/plugin"
  if [ ! -f "$engine/server.mjs" ]; then
    echo "✗ plugin companion not found at $engine." >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "✗ 'node' not found on PATH — the companion server runs on Node.js." >&2
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

  # --- --install-tunnel: one address, forever (companion + tunnel agents) ---
  if [ "$tunnel" = "install" ]; then
    local tun_args=()
    case "$agents" in
      off) tun_args+=(--no-agents) ;;
      on) tun_args+=(--agents) ;;
    esac
    [ -n "$port" ] && tun_args+=(--port "$port")
    plugin_tunnel_install "$port" ${tun_args[@]+"${tun_args[@]}"}
    return $?
  fi

  # --- the shared password: generated once here so the tunnel, the printed
  # line and any detached copy all agree on it ---
  if $share && [ -z "${PLUGIN_PASSWORD:-}" ]; then
    PLUGIN_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))') || return 1
    echo ""
    echo "🔑 PLUGIN_PASSWORD not set — generated one for this session: ${PLUGIN_PASSWORD}"
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
        echo "✗ --agents: 'python3' not found on PATH — the agent bridge runs on it." >&2
        return 1
      fi
      if [ -z "$clis" ]; then
        echo "✗ --agents: no 'claude' or 'codex' CLI found on PATH." >&2
        echo "   Install one (and log in) to enable agents, or drop --agents." >&2
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

  echo ""
  echo "🟢 Web annotator companion"
  echo "   ▶ http://127.0.0.1:${url_port}/   (Ctrl-C stops it)"
  if [ "${PLUGIN_WS_STICKY:-false}" != true ]; then
    echo "   📦 workspace: ${PLUGIN_WS}"
  fi
  if $agents_on; then
    echo "   🔌 agents: on (${clis} detected) — @claude/@codex in comments summon them"
  elif [ "$agents" = "off" ]; then
    echo "   🔌 agents: off (--no-agents) — highlights, comments, and export only"
  else
    echo "   🔌 agents: off — python3 + a claude/codex CLI on PATH are needed for bot replies"
  fi

  if $hosted; then
    echo ""
    echo "🌐 Hosted: remote visitors need the password; this machine stays the owner"
    echo "   • people without the extension read and reply at /pages"
    echo "   • their @-mentions are refused until you grant them agents in"
    echo "     ${PLUGIN_WS}/.botference/plugin/grants.json"
    if [ -f "${PLUGIN_AUTOSTART_DIR}/${PLUGIN_TUNNEL_LABEL}.plist" ]; then
      echo "   • public address: https://${PLUGIN_TUNNEL_HOSTNAME}/pages"
    fi
  fi

  # The extension is a one-time install, so the walkthrough only shows up
  # when it plausibly still has to happen: no annotations stored here yet.
  echo ""
  if [ -d "${PLUGIN_WS}/.botference/plugin" ]; then
    echo "🧩 Extension: ${engine}/extension"
    echo "   (load it once via brave://extensions → Developer mode → Load unpacked)"
  else
    echo "🧩 Get the extension (one time, ~30 seconds):"
    echo "   1. open brave://extensions"
    echo "   2. turn on Developer mode"
    echo "   3. Load unpacked → ${engine}/extension"
    echo ""
    echo "💡 Then highlight text on any article page to annotate it."
  fi

  if ! $share; then
    echo ""
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
    echo "" >&2
    if [ -n "${BOTFERENCE_TUNNEL:-}" ]; then
      echo "✗ BOTFERENCE_TUNNEL is set ('${BOTFERENCE_TUNNEL}') but 'cloudflared' is not installed." >&2
      echo "   install it (e.g. 'brew install cloudflared') to use your named tunnel." >&2
    else
      echo "✗ cloudflared not found — no public URL." >&2
      echo "   install it (e.g. 'brew install cloudflared')," >&2
      echo "   or tunnel by hand: cloudflared tunnel --url http://localhost:${url_port}" >&2
    fi
    echo "" >&2
    echo "🟢 Serving locally in the meantime: http://localhost:${url_port}/   password: ${PLUGIN_PASSWORD}" >&2
    echo "" >&2
  fi
  local rc=0
  wait "$server_pid" || rc=$?
  stop_share_tunnel
  trap - INT TERM
  return "$rc"
}
