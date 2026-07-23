#!/usr/bin/env bash

# ── botference service ───────────────────────────────────────
# Managed long-lived processes (dev servers, share tunnels) that survive
# the shell — and the whole process group — that started them. This is
# the sanctioned, auditable way for agents inside botference sessions to
# leave something running after their turn ends: anything they start
# with a bare `&`/nohup dies with the turn's process-group teardown.
#
# Mechanism: `start` forks the command into its OWN SESSION (setsid) with
# stdin from /dev/null and stdout+stderr appended to a per-service log,
# so no parent death, SIGHUP, or process-group kill reaches it. Every
# service is recorded in a per-workspace ledger (atomic writes); stale
# entries with dead pids are reaped on every invocation.
#
# Files (per project workspace, conventionally gitignored):
#   $BOTFERENCE_PROJECT_ROOT/.botference/services.json          ledger
#   $BOTFERENCE_PROJECT_ROOT/.botference/logs/service-<n>.log   output
#     (rotated to .log.1 once it exceeds ~5MB, at service start)

SERVICE_DIR="${BOTFERENCE_PROJECT_ROOT:-$(pwd -P)}/.botference"
SERVICE_LEDGER="${SERVICE_DIR}/services.json"
SERVICE_LOG_DIR="${SERVICE_DIR}/logs"

service_usage() {
  cat <<'HELP'
Usage: botference service <start|stop|list|logs> …

Managed long-lived processes (dev servers, share tunnels) that survive
the shell — and the whole process group — that started them. This is
how agents leave a server or tunnel running after their turn ends.

Commands:
  start <name> -- <command…>  Start <command> fully detached (own
                              session and process group, stdin from
                              /dev/null, stdout+stderr appended to the
                              service log). <name>: [a-z0-9-], max 32
                              chars; duplicate running names refused.
  stop <name> | stop --all    TERM the service's process group,
                              escalate to KILL after 5s, remove the
                              ledger entry.
  list                        Table of EVERY service in every registered
                              ledger (name, pid, uptime, alive/dead, dir,
                              command, log) — global view, run it from
                              anywhere. Dead entries are shown once, then
                              reaped. stop/logs stay scoped to the current
                              directory's ledger: run them from the DIR
                              shown.
  logs <name> [-n N]          Tail the service log (default 50 lines).

Files (per workspace, gitignored by convention):
  .botference/services.json             the ledger (atomic writes)
  .botference/logs/service-<name>.log   stdout+stderr (~5MB rotation)
  ~/.botference/ledgers                 global index of ledger paths
                                        (feeds `list`; self-maintained)

Convenience — run a whole share (server + tunnel) under this lifecycle,
print the usual "share this: <url>   password: <pw>" line, then return
control (what agents should use to stand up a share):
  botference review --share --service     (service name: review-share)
  botference plan --share --service       (service name: council-share)
HELP
}

# All ledger operations and the daemonizer live in one python3 helper so
# reap + duplicate-check + fork happen in a single process (no TOCTOU
# between shell calls) and JSON writes are atomic (tmp + os.replace).
_service_py() {
  python3 - "$SERVICE_LEDGER" "$@" <<'PY'
import json, os, shlex, signal, sys, time

LEDGER = sys.argv[1]
OP = sys.argv[2]
ARGS = sys.argv[3:]
LOG_MAX = int(os.environ.get("BOTFERENCE_SERVICE_LOG_MAX", str(5 * 1024 * 1024)))
GRACE = float(os.environ.get("BOTFERENCE_SERVICE_STOP_GRACE", "5"))
# Global ledger index: one absolute services.json path per line. Ledgers are
# per-directory (stop stays scoped to the cwd's ledger — you can't fat-finger
# a kill across projects), but `list` reads every ledger registered here so
# everything running is visible no matter where it's run from.
INDEX = os.environ.get("BOTFERENCE_SERVICE_INDEX") \
    or os.path.join(os.path.expanduser("~"), ".botference", "ledgers")


def load(path=None):
    try:
        with open(path or LEDGER, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    entries = data.get("services") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        return []
    return [e for e in entries if isinstance(e, dict)]


def save(entries, path=None):
    path = path or LEDGER
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"services": entries}, fh, indent=2)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def index_paths():
    try:
        with open(INDEX, "r", encoding="utf-8") as fh:
            return {l.strip() for l in fh if l.strip()}
    except OSError:
        return set()


def register(path):
    # best-effort: the index is a convenience view, never load-bearing
    try:
        ap = os.path.abspath(path)
        paths = index_paths()
        if ap in paths or not os.path.exists(ap):
            return
        paths.add(ap)
        os.makedirs(os.path.dirname(INDEX), exist_ok=True)
        tmp = INDEX + ".tmp.%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write("\n".join(sorted(paths)) + "\n")
        os.replace(tmp, INDEX)
    except OSError:
        pass


def alive(entry):
    pid = entry.get("pid")
    pgid = entry.get("pgid")
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    # pid-reuse guard: the recorded pgid must still match.
    try:
        if isinstance(pgid, int) and pgid > 1 and os.getpgid(pid) != pgid:
            return False
    except ProcessLookupError:
        return False
    except OSError:
        pass
    return True


def reap(entries):
    kept, reaped = [], []
    for e in entries:
        (kept if alive(e) else reaped).append(e)
    return kept, reaped


def find(entries, name):
    for e in entries:
        if e.get("name") == name:
            return e
    return None


if OP == "start":
    name, log, cwd = ARGS[0], ARGS[1], ARGS[2]
    cmd = ARGS[3:]
    entries, reaped = reap(load())
    for e in reaped:
        sys.stderr.write("  reaped stale service '%s' (pid %s no longer running)\n"
                         % (e.get("name"), e.get("pid")))
    if find(entries, name) is not None:
        e = find(entries, name)
        sys.stderr.write(
            "Error: service '%s' is already running (pid %s, started %s).\n"
            "  Stop it first: botference service stop %s\n"
            % (name, e.get("pid"), e.get("started", "?"), name))
        save(entries)
        sys.exit(2)
    # simple size rotation, done while nothing holds the log open
    try:
        if os.path.getsize(log) > LOG_MAX:
            os.replace(log, log + ".1")
    except OSError:
        pass
    try:
        with open(log, "a", encoding="utf-8") as fh:
            fh.write("=== botference service '%s' starting %s: %s ===\n"
                     % (name, time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                        " ".join(shlex.quote(c) for c in cmd)))
    except OSError:
        pass
    import fcntl
    r, w = os.pipe()
    fcntl.fcntl(w, fcntl.F_SETFD, fcntl.FD_CLOEXEC)
    pid = os.fork()
    if pid == 0:
        os.close(r)
        try:
            os.setsid()  # own session + process group: survives the caller's teardown
            devnull = os.open(os.devnull, os.O_RDONLY)
            logfd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
            os.dup2(devnull, 0)
            os.dup2(logfd, 1)
            os.dup2(logfd, 2)
            if devnull > 2:
                os.close(devnull)
            if logfd > 2:
                os.close(logfd)
            os.chdir(cwd)
            os.execvp(cmd[0], cmd)
        except Exception as exc:  # exec failed — report through the CLOEXEC pipe
            try:
                os.write(w, str(exc).encode("utf-8", "replace"))
            except OSError:
                pass
            os._exit(127)
    os.close(w)
    err = b""
    while True:
        chunk = os.read(r, 4096)
        if not chunk:
            break
        err += chunk
    os.close(r)
    if err:
        sys.stderr.write("Error: could not start '%s': %s\n"
                         % (name, err.decode("utf-8", "replace")))
        save(entries)
        sys.exit(1)
    now = time.time()
    entries.append({
        "name": name,
        "pid": pid,
        "pgid": pid,  # session leader of its own group
        "command": " ".join(shlex.quote(c) for c in cmd),
        "started": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(now)),
        "started_epoch": int(now),
        "cwd": cwd,
        "log": log,
    })
    save(entries)
    register(LEDGER)
    print(pid)
    sys.exit(0)

if OP == "check":
    # exit 0 alive (prints pid), 1 dead (entry reaped), 3 unknown name
    entries = load()
    entry = find(entries, ARGS[0])
    if entry is None:
        sys.exit(3)
    if alive(entry):
        print(entry.get("pid"))
        sys.exit(0)
    save([e for e in entries if e is not entry])
    sys.exit(1)

if OP == "stop":
    entries = load()
    names = list(ARGS)
    if names == ["--all"]:
        names = [e.get("name") for e in entries]
        if not names:
            print("  no services in the ledger.")
            sys.exit(0)
    rc = 0
    for name in names:
        entry = find(entries, name)
        if entry is None:
            sys.stderr.write("Error: no service named '%s' in the ledger.\n" % name)
            rc = 1
            continue
        pid, pgid = entry.get("pid"), entry.get("pgid")
        if not alive(entry):
            print("  service '%s' was already dead — stale entry removed." % name)
            entries = [e for e in entries if e is not entry]
            continue
        target = pgid if isinstance(pgid, int) and pgid > 1 else pid
        try:
            os.killpg(target, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        deadline = time.time() + GRACE
        while time.time() < deadline and alive(entry):
            time.sleep(0.1)
        escalated = False
        if alive(entry):
            escalated = True
            try:
                os.killpg(target, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            deadline = time.time() + 2
            while time.time() < deadline and alive(entry):
                time.sleep(0.1)
        suffix = " (escalated to KILL)" if escalated else ""
        print("  stopped service '%s' (pid %s)%s." % (name, pid, suffix))
        entries = [e for e in entries if e is not entry]
    save(entries)
    sys.exit(rc)

if OP == "list":
    # Global view: this directory's ledger plus every ledger in the index.
    # Actions (stop/logs) stay scoped to the cwd's ledger; run them from the
    # DIR column's directory.
    register(LEDGER)
    home = os.path.expanduser("~")
    ledgers = {os.path.abspath(LEDGER)} | index_paths()
    live_index = set()
    now = int(time.time())
    rows = []
    reaped = 0
    for lpath in sorted(ledgers):
        entries = load(lpath)
        if os.path.exists(lpath):
            live_index.add(lpath)
        if not entries:
            continue
        proj = os.path.dirname(os.path.dirname(lpath))
        pdisp = "~" + proj[len(home):] if proj.startswith(home) else proj
        kept = []
        for e in entries:
            ok = alive(e)
            if ok:
                kept.append(e)
            up = "-"
            started = e.get("started_epoch")
            if ok and isinstance(started, int):
                secs = max(0, now - started)
                if secs >= 86400:
                    up = "%dd%02dh" % (secs // 86400, (secs % 86400) // 3600)
                elif secs >= 3600:
                    up = "%dh%02dm" % (secs // 3600, (secs % 3600) // 60)
                elif secs >= 60:
                    up = "%dm%02ds" % (secs // 60, secs % 60)
                else:
                    up = "%ds" % secs
            cmdtext = str(e.get("command", ""))
            if len(cmdtext) > 34:
                cmdtext = cmdtext[:31] + "..."
            rows.append((str(e.get("name", "?")), str(e.get("pid", "?")), up,
                         "alive" if ok else "dead", pdisp, cmdtext,
                         str(e.get("log", ""))))
        if len(kept) != len(entries):
            save(kept, lpath)
            reaped += len(entries) - len(kept)
    # prune index lines whose ledger files vanished (deleted projects)
    if live_index != index_paths() and live_index:
        try:
            tmp = INDEX + ".tmp.%d" % os.getpid()
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write("\n".join(sorted(live_index)) + "\n")
            os.replace(tmp, INDEX)
        except OSError:
            pass
    if not rows:
        print("  no services running (in any registered ledger).")
        sys.exit(0)
    header = ("NAME", "PID", "UPTIME", "STATE", "DIR", "COMMAND", "LOG")
    widths = [max(len(header[i]), *(len(r[i]) for r in rows)) for i in range(6)]
    fmt = "  " + "  ".join("%%-%ds" % w for w in widths) + "  %s"
    print(fmt % header)
    for r in rows:
        print(fmt % r)
    if reaped:
        print("  (%d dead entr%s reaped from the ledger)"
              % (reaped, "y" if reaped == 1 else "ies"))
    print("  stop/logs act on one directory's ledger: run them from the DIR shown.")
    sys.exit(0)

if OP == "log-path":
    entry = find(load(), ARGS[0])
    if entry is not None and entry.get("log"):
        print(entry["log"])
        sys.exit(0)
    sys.exit(3)

sys.stderr.write("Error: unknown service ledger op '%s'.\n" % OP)
sys.exit(2)
PY
}

_service_require_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: 'botference service' requires python3 on PATH." >&2
    return 1
  fi
}

_service_validate_name() {
  local name=$1
  if ! [[ "$name" =~ ^[a-z0-9-]{1,32}$ ]]; then
    echo "Error: invalid service name '$name' — use [a-z0-9-], 1–32 chars." >&2
    return 2
  fi
}

service_cmd_start() {
  local name="${1:-}"
  if [ -z "$name" ] || [ "$name" = "--" ]; then
    echo "Error: usage: botference service start <name> -- <command…>" >&2
    return 2
  fi
  shift
  _service_validate_name "$name" || return 2
  if [ "${1:-}" != "--" ]; then
    echo "Error: expected '--' between the service name and the command:" >&2
    echo "  botference service start $name -- <command…>" >&2
    return 2
  fi
  shift
  if [ "$#" -eq 0 ]; then
    echo "Error: no command given after '--'." >&2
    return 2
  fi
  mkdir -p "$SERVICE_LOG_DIR"
  local log="${SERVICE_LOG_DIR}/service-${name}.log"
  local pid
  pid=$(_service_py start "$name" "$log" "${BOTFERENCE_PROJECT_ROOT:-$(pwd -P)}" "$@") || return $?
  # brief liveness check: catch commands that die instantly (typo, missing bin)
  sleep 1
  if ! _service_py check "$name" >/dev/null 2>&1; then
    echo "Error: service '$name' exited immediately. Last log lines:" >&2
    tail -n 15 "$log" 2>/dev/null | sed 's/^/    /' >&2
    return 1
  fi
  echo "  started service '$name' (pid $pid) — detached; survives this shell and its process group"
  echo "  log:  $log"
  echo "  stop: botference service stop $name"
}

service_cmd_stop() {
  if [ "$#" -eq 0 ]; then
    echo "Error: usage: botference service stop <name> | stop --all" >&2
    return 2
  fi
  _service_py stop "$@"
}

service_cmd_list() {
  _service_py list
}

service_cmd_logs() {
  local name="" lines=50 arg
  while [ "$#" -gt 0 ]; do
    arg=$1
    shift
    case "$arg" in
      -n)
        if [ "$#" -eq 0 ]; then
          echo "Error: -n requires a number." >&2
          return 2
        fi
        lines=$1
        shift
        ;;
      -n*) lines="${arg#-n}" ;;
      -*)
        echo "Error: unknown logs option '$arg' (usage: botference service logs <name> [-n N])." >&2
        return 2
        ;;
      *)
        if [ -n "$name" ]; then
          echo "Error: multiple service names given ('$name', '$arg')." >&2
          return 2
        fi
        name=$arg
        ;;
    esac
  done
  if [ -z "$name" ]; then
    echo "Error: usage: botference service logs <name> [-n N]" >&2
    return 2
  fi
  _service_validate_name "$name" || return 2
  if ! [[ "$lines" =~ ^[0-9]+$ ]]; then
    echo "Error: -n expects a number, got '$lines'." >&2
    return 2
  fi
  local log
  if ! log=$(_service_py log-path "$name" 2>/dev/null); then
    log="${SERVICE_LOG_DIR}/service-${name}.log"  # dead + reaped services keep their log
  fi
  if [ ! -f "$log" ]; then
    echo "Error: no log for service '$name' (looked at $log)." >&2
    return 1
  fi
  tail -n "$lines" "$log"
}

run_service_mode() {
  _service_require_python || return 1
  local cmd="${1:-}"
  if [ -z "$cmd" ]; then
    service_usage >&2
    return 2
  fi
  shift
  case "$cmd" in
    start) service_cmd_start "$@" ;;
    stop) service_cmd_stop "$@" ;;
    list|ls) service_cmd_list "$@" ;;
    logs) service_cmd_logs "$@" ;;
    help|--help|-h) service_usage ;;
    *)
      echo "Error: unknown service command '$cmd' (start|stop|list|logs)." >&2
      return 2
      ;;
  esac
}

# ── share-as-a-service (review --share --service, plan --share --service) ──
# Runs the whole share (server + tunnel) under the service lifecycle,
# waits (bounded) for the canonical "share this: <url>   password: <pw>"
# line to appear in the service log, prints it, and returns control.
run_share_as_service() {
  _service_require_python || return 1
  local name=$1
  shift
  mkdir -p "$SERVICE_LOG_DIR"
  local log="${SERVICE_LOG_DIR}/service-${name}.log"
  local offset=0 rc=0
  [ -f "$log" ] && offset=$(wc -c < "$log")
  service_cmd_start "$name" -- "$@" || rc=$?
  if [ "$rc" -eq 2 ] && _service_py check "$name" >/dev/null 2>&1; then
    # already running: idempotent for agents — reprint its last share line
    local prev
    # anchored: never match the start banner, which echoes the command
    prev=$(grep -E '^[[:space:]]*share this:' "$log" 2>/dev/null | tail -1 || true)
    if [ -n "$prev" ]; then
      echo "  service '$name' is already running; its last share line:"
      echo ""
      echo "$prev"
      echo ""
      return 0
    fi
    return 2
  fi
  [ "$rc" -eq 0 ] || return "$rc"
  # log may have been rotated at start
  if [ ! -f "$log" ] || [ "$(wc -c < "$log")" -lt "$offset" ]; then
    offset=0
  fi

  local deadline=$(( SECONDS + 90 )) fresh line
  echo "  waiting for the share URL (bounded, 90s)…"
  while [ "$SECONDS" -lt "$deadline" ]; do
    fresh=$(tail -c "+$((offset + 1))" "$log" 2>/dev/null || true)
    line=$(printf '%s\n' "$fresh" | grep -E '^[[:space:]]*share this:' | head -1 || true)
    if [ -n "$line" ]; then
      echo ""
      echo "$line"
      echo ""
      echo "  running as service '$name' — it outlives this shell (and your turn)."
      echo "  logs: botference service logs $name    stop: botference service stop $name"
      return 0
    fi
    if printf '%s\n' "$fresh" | grep -qE "cloudflared not found|did not produce a trycloudflare URL|BOTFERENCE_TUNNEL is set|your configured hostname"; then
      echo "  no tunnel URL — the service is up but serving locally. Recent log:"
      tail -n 12 "$log" | sed 's/^/    /'
      echo "  logs: botference service logs $name    stop: botference service stop $name"
      return 0
    fi
    if ! _service_py check "$name" >/dev/null 2>&1; then
      echo "Error: service '$name' exited before printing a share URL. Last log lines:" >&2
      tail -n 20 "$log" 2>/dev/null | sed 's/^/    /' >&2
      return 1
    fi
    sleep 1
  done
  echo "Error: timed out waiting for the share URL. The service is still running;" >&2
  echo "  inspect it: botference service logs $name    stop: botference service stop $name" >&2
  tail -n 20 "$log" 2>/dev/null | sed 's/^/    /' >&2
  return 1
}
