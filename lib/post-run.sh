#!/usr/bin/env bash

cb_reset() {
  CB_CONSECUTIVE_FAILURES=0
  rm -f "$CB_FILE"
}

cb_record_failure() {
  CB_CONSECUTIVE_FAILURES=$((CB_CONSECUTIVE_FAILURES + 1))
  echo "$CB_CONSECUTIVE_FAILURES" > "$CB_FILE"
}

cb_record_success() {
  if [ "$CB_CONSECUTIVE_FAILURES" -gt 0 ]; then
    echo "  Circuit breaker: reset after $CB_CONSECUTIVE_FAILURES failure(s)"
  fi
  cb_reset
}

cb_is_open() {
  [ "$CB_CONSECUTIVE_FAILURES" -ge "$CB_THRESHOLD" ]
}

validate_single_task_completion() {
  # Compares plan before/after an iteration using set diff. Returns 1 if >1 task was newly checked.
  local before=$1
  local after=$2
  local before_set after_set newly_checked count

  before_set=$(grep '^\- \[x\]' "$before" 2>/dev/null \
    | sed 's/^- \[x\] \([0-9][0-9]*\)\..*/\1/' | sort -n) || true
  after_set=$(grep '^\- \[x\]' "$after" 2>/dev/null \
    | sed 's/^- \[x\] \([0-9][0-9]*\)\..*/\1/' | sort -n) || true

  newly_checked=$(comm -13 <(printf '%s\n' $before_set | grep -v '^$') \
                           <(printf '%s\n' $after_set | grep -v '^$')) || true
  count=$(echo "$newly_checked" | grep -c '[0-9]') || count=0

  if [ "$count" -gt 1 ]; then
    echo "  ✗ Multi-task violation: tasks $(echo $newly_checked | tr '\n' ',' | sed 's/,$//') completed in one iteration (max 1)"
    return 1
  fi
  return 0
}

halt_loop_with_error() {
  LOOP_EXIT_CODE=1
}

validate_plan_tdd_structure() {
  # Checks that unchecked coder TDD tasks have all required sub-fields.
  local plan_path=$1
  local rc=0
  local task_line sub_lines

  while IFS= read -r task_line; do
    # Get line number of this task
    local line_num
    line_num=$(grep -n -F -- "$task_line" "$plan_path" | head -1 | cut -d: -f1)
    [ -z "$line_num" ] && continue

    # Collect indented lines following this task (sub-fields)
    sub_lines=$(awk -v start="$line_num" '
      NR > start {
        if (/^- \[/) exit
        if (/^  /) print
        else exit
      }
    ' "$plan_path")

    local missing=""
    echo "$sub_lines" | grep -q 'RED:' || missing="${missing} RED:"
    echo "$sub_lines" | grep -q 'GREEN:' || missing="${missing} GREEN:"
    echo "$sub_lines" | grep -q 'VERIFY:' || missing="${missing} VERIFY:"
    echo "$sub_lines" | grep -q 'Commits:' || missing="${missing} Commits:"

    if [ -n "$missing" ]; then
      echo "  ✗ TDD task missing fields:${missing}"
      echo "    Task: $task_line"
      rc=1
    fi

    # Reject placeholder content in RED:/GREEN: lines
    local placeholder_re='\.\.\.|TBD|TODO|write a test showing'
    local line
    while IFS= read -r line; do
      if echo "$line" | grep -qE "$placeholder_re"; then
        echo "  ✗ TDD task has placeholder content: $line"
        echo "    Task: $task_line"
        rc=1
      fi
    done <<< "$(echo "$sub_lines" | grep -E '^  (RED|GREEN):')"
  done < <(grep '^- \[ \]' "$plan_path" | grep 'red/green TDD' | grep '\*\*coder\*\*')

  return $rc
}


restore_circuit_breaker_state() {
  if [ -f "$CB_FILE" ]; then
    CB_CONSECUTIVE_FAILURES=$(cat "$CB_FILE" 2>/dev/null | tr -d '[:space:]')
    if ! [[ "$CB_CONSECUTIVE_FAILURES" =~ ^[0-9]+$ ]]; then
      CB_CONSECUTIVE_FAILURES=0
    fi
  fi
}

cleanup_loop_processes() {
  [ -n "${JSONL_MONITOR_PID:-}" ] && kill "$JSONL_MONITOR_PID" 2>/dev/null || true
  [ -n "${MONITOR_PID:-}" ] && kill "$MONITOR_PID" 2>/dev/null || true
  [ -n "${CLAUDE_PID:-}" ] && kill "$CLAUDE_PID" 2>/dev/null || true
  rm -f "$YIELD_FILE" "$CTX_FILE" "$BUDGET_FILE"
}

plan_is_allowed_file() {
  policy_path_allowed "$1" "plan"
}

_snapshot_sig_for_path() {
  local abs_path=$1
  if [ -f "$abs_path" ]; then
    cksum < "$abs_path" | awk '{print $1 ":" $2}'
  else
    printf '__missing__'
  fi
}

snapshot_roots_for_mode() {
  local mode=${1:-plan}

  if [ "$BOTFERENCE_WORK_DIR" = "$BOTFERENCE_PROJECT_ROOT" ] && [ ! -d "${BOTFERENCE_PROJECT_DIR}" ]; then
    printf '.\n'
    return 0
  fi

  if [ ! -d "${BOTFERENCE_PROJECT_DIR}" ] && [ "$BOTFERENCE_WORK_DIR" != "$BOTFERENCE_PROJECT_ROOT" ]; then
    project_relative_path "$BOTFERENCE_WORK_DIR"
  else
    printf '%s\n' "${BOTFERENCE_PROJECT_DIR_NAME}"
  fi

  local roots=""
  case "$mode" in
    plan) roots="$BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS" ;;
    build) roots="$BOTFERENCE_BUILD_EXTRA_WRITE_ROOTS" ;;
  esac

  printf '%s' "$roots" | tr ',' '\n' | awk 'NF' | sort -u
}

plan_write_state_snapshot() {
  local snapshot_file=$1
  local mode=${2:-plan}
  : > "$snapshot_file"

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ -f "$BOTFERENCE_PROJECT_CONFIG_FILE" ]; then
      (
        cd "$BOTFERENCE_PROJECT_ROOT"
        find . \( -name .git -o -path './.git/*' \) -prune -o -type f -print | sed 's#^\./##' | sort
      ) | while IFS= read -r path; do
        [ -n "$path" ] || continue
        local abs_path="$BOTFERENCE_PROJECT_ROOT/$path"
        printf '%s\t%s\n' "$(_snapshot_sig_for_path "$abs_path")" "$path" >> "$snapshot_file"
      done
      sort -u "$snapshot_file" -o "$snapshot_file"
      return 0
    fi

    while IFS= read -r root; do
      [ -n "$root" ] || continue
      local abs_root="$BOTFERENCE_PROJECT_ROOT/$root"

      if [ -f "$abs_root" ]; then
        printf '%s\t%s\n' "$(_snapshot_sig_for_path "$abs_root")" "$root" >> "$snapshot_file"
        continue
      fi
      if [ ! -d "$abs_root" ]; then
        continue
      fi

      (
        cd "$BOTFERENCE_PROJECT_ROOT"
        find "$root" -type f | sort
      ) | while IFS= read -r path; do
        [ -n "$path" ] || continue
        local abs_path="$BOTFERENCE_PROJECT_ROOT/$path"
        printf '%s\t%s\n' "$(_snapshot_sig_for_path "$abs_path")" "$path" >> "$snapshot_file"
      done
    done < <(snapshot_roots_for_mode "$mode")
    sort -u "$snapshot_file" -o "$snapshot_file"
    return 0
  fi

  while IFS= read -r path; do
    [ -z "$path" ] && continue
    local sig
    if [ -f "$path" ]; then
      sig=$(git hash-object "$path" 2>/dev/null || cksum < "$path" | awk '{print $1}')
    else
      sig="__missing__"
    fi
    printf '%s\t%s\n' "$sig" "$path" >> "$snapshot_file"
  done < <(
    {
      git diff --name-only 2>/dev/null
      git diff --cached --name-only 2>/dev/null
      git ls-files --others --exclude-standard 2>/dev/null
    } | awk 'NF' | sort -u
  )
}

plan_collect_changed_paths() {
  local before_snapshot=$1
  local after_snapshot=$2
  python3 - "$before_snapshot" "$after_snapshot" <<'PY'
import sys

def load(path):
    data = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.rstrip("\n")
                if not raw:
                    continue
                sig, _, name = raw.partition("\t")
                data[name] = sig
    except FileNotFoundError:
        pass
    return data

before = load(sys.argv[1])
after = load(sys.argv[2])
for name in sorted(set(before) | set(after)):
    if before.get(name) != after.get(name):
        print(name)
PY
}

audit_mode_changed_files() {
  local mode=$1
  local before_snapshot=$2
  local allowed_out=$3
  local violations_out=$4
  local after_snapshot
  after_snapshot=$(mktemp)
  : > "$allowed_out"
  : > "$violations_out"

  plan_write_state_snapshot "$after_snapshot" "$mode"
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if policy_path_allowed "$path" "$mode"; then
      printf '%s\n' "$path" >> "$allowed_out"
    else
      printf '%s\n' "$path" >> "$violations_out"
    fi
  done < <(plan_collect_changed_paths "$before_snapshot" "$after_snapshot")

  rm -f "$after_snapshot"

  if [ -s "$violations_out" ]; then
    cp "$violations_out" "$PLAN_AUDIT_FILE"
    return 1
  fi

  rm -f "$PLAN_AUDIT_FILE"
  return 0
}

plan_audit_changed_files() {
  audit_mode_changed_files "plan" "$@"
}

plan_commit_and_push_changes() {
  local changed_file=$1
  local files=()
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    files+=("$path")
  done < "$changed_file"

  if [ ${#files[@]} -eq 0 ]; then
    echo "  (no plan-state changes to commit)"
    return 0
  fi

  git add -- "${files[@]}" 2>/dev/null || {
    echo "  ✗ Could not stage plan-state files"
    return 1
  }

  if git diff --cached --quiet -- "${files[@]}" 2>/dev/null; then
    echo "  (no staged plan-state changes to commit)"
    return 0
  fi

  local thread_name="${CURRENT_THREAD:-plan}"
  git commit -m "plan: update plan state for ${thread_name}" --quiet 2>/dev/null || {
    echo "  ✗ Could not commit plan-state files"
    return 1
  }

  local branch_name=""
  branch_name=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if git remote get-url origin >/dev/null 2>&1 && [ -n "$branch_name" ] && [ "$branch_name" != "HEAD" ]; then
    git push origin "HEAD:${branch_name}" --quiet 2>/dev/null || {
      echo "  ✗ Plan files committed locally, but push failed"
      return 1
    }
    echo "  Plan-state files committed and pushed."
  else
    echo "  Plan-state files committed locally (push skipped — no origin or detached HEAD)."
  fi

  return 0
}

plan_violation_paths_still_dirty() {
  if [ ! -f "$PLAN_AUDIT_FILE" ]; then
    return 1
  fi

  local still_dirty=1
  local seen=""
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if git ls-files --others --exclude-standard -- "$path" 2>/dev/null | grep -q .; then
      printf '%s\n' "$path"
      still_dirty=0
      continue
    fi
    if ! git diff --quiet -- "$path" 2>/dev/null; then
      printf '%s\n' "$path"
      still_dirty=0
      continue
    fi
    if ! git diff --cached --quiet -- "$path" 2>/dev/null; then
      printf '%s\n' "$path"
      still_dirty=0
      continue
    fi
  done < "$PLAN_AUDIT_FILE"

  return "$still_dirty"
}

# Kill and wait for a background process by PID.
# Caller is responsible for resetting the PID variable afterward.
cleanup_pid() {
  local pid=$1
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

# Build session file path from SESSION_ID, log usage via log_interactive_session_usage.
# Uses globals: ITERATION, LOOP_MODE, CURRENT_THREAD, USAGE_LOG
log_interactive_session() {
  local session_id=$1
  local agent_name=$2
  local project_dir
  project_dir=$(echo "$PWD" | tr '/' '-' | sed 's/^-//')
  local session_file="$HOME/.claude/projects/${project_dir}/${session_id}.jsonl"
  if [ -f "$session_file" ]; then
    log_interactive_session_usage "$session_file" "$ITERATION" "$agent_name" "$LOOP_MODE" "$CURRENT_THREAD" \
      && echo "  Usage logged to $USAGE_LOG" \
      || echo "  (could not log usage data)"
  else
    echo "  (session file not found — usage not logged)"
  fi
}

# Capture eval metrics and check for human review gate.
# Exits the loop (exit 0) if human review is requested.
post_iteration() {
  capture_eval_metrics || echo "  (eval capture skipped)"
  if handle_human_review_gate; then
    exit 0
  fi
}

handle_interrupt_signal() {
  local now
  now=$(date +%s)
  if (( now - LAST_CTRL_C < 3 )); then
    echo ""
    echo "Stopped."
    cleanup_loop_processes
    exit 0
  fi

  LAST_CTRL_C=$now
  echo ""
  echo "Press Ctrl+C again within 3s to stop."
}

print_output_json_summary() {
  local output_file=$1
  echo "  --- Post-run usage summary ---"
  jq -r '
    if .is_error then "  Result: ERROR — \(.result)"
    else
      "  Result: success (\(.num_turns) turns, \(.duration_ms/1000 | floor)s)" +
      (.modelUsage // {} | to_entries[] |
        "\n  Model: \(.key)" +
        "\n    input: \(.value.inputTokens // 0) | cache_create: \(.value.cacheCreationInputTokens // 0) | cache_read: \(.value.cacheReadInputTokens // 0) | output: \(.value.outputTokens // 0)") +
      (if .total_cost_usd then "\n  Cost: $\(.total_cost_usd)" else "" end)
    end
  ' "$output_file" 2>/dev/null || echo "  (could not parse output JSON)"
}

log_usage_from_output_json() {
  local output_file=$1
  local iteration=$2
  local agent_name=$3
  local loop_mode=$4
  local thread=$5
  local parallel_sub=${6:-}
  local timestamp

  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$(dirname "$USAGE_LOG")"

  jq -c \
    --arg iter "$iteration" \
    --arg agent "$agent_name" \
    --arg mode "$loop_mode" \
    --arg ts "$timestamp" \
    --arg thread "$thread" \
    --arg sub "$parallel_sub" '
    if .is_error then
      {iteration: ($iter|tonumber), timestamp: $ts, thread: $thread, agent: $agent, loop_mode: $mode,
       error: true, message: .result}
      + (if $sub != "" then {parallel_sub: ($sub|tonumber)} else {} end)
    else
      {iteration: ($iter|tonumber), timestamp: $ts, thread: $thread, agent: $agent, loop_mode: $mode,
       model: (.modelUsage // {} | keys[0] // "unknown"),
       num_turns: .num_turns, duration_ms: .duration_ms,
       input_tokens: .usage.input_tokens,
       cache_read_input_tokens: .usage.cache_read_input_tokens,
       cache_creation_input_tokens: .usage.cache_creation_input_tokens,
       output_tokens: .usage.output_tokens,
       cost_usd: .total_cost_usd}
      + (if (.tools_called // []) | length > 0 then {tools_called: (.tools_called // [])} else {} end)
      + (if $sub != "" then {parallel_sub: ($sub|tonumber)} else {} end)
    end
  ' "$output_file" >> "$USAGE_LOG" 2>/dev/null
}

log_interactive_session_usage() {
  local session_file=$1
  local iteration=$2
  local agent_name=$3
  local loop_mode=$4
  local thread=$5
  local timestamp

  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$(dirname "$USAGE_LOG")"

  python3 "${BOTFERENCE_HOME}/scripts/extract_session_usage.py" "$session_file" \
    | jq -c \
      --arg iter "$iteration" \
      --arg agent "$agent_name" \
      --arg mode "$loop_mode" \
      --arg ts "$timestamp" \
      --arg thread "$thread" \
      '. + {iteration: ($iter|tonumber), timestamp: $ts, thread: $thread, agent: $agent, loop_mode: $mode}' \
    >> "$USAGE_LOG" 2>/dev/null
}

capture_eval_metrics() {
  python3 "${BOTFERENCE_HOME}/scripts/evaluate_iteration.py" \
    --iteration "$ITERATION" \
    --arch-mode "${ARCH_MODE:-serial}" \
    --run-tag "${RUN_TAG:-}" \
    2>/dev/null
}

handle_human_review_gate() {
  local template_file="${BOTFERENCE_HOME}/templates/HUMAN_REVIEW_NEEDED.md"
  if [ -f "${BOTFERENCE_REVIEW_FILE:-HUMAN_REVIEW_NEEDED.md}" ] && ! diff -q "${BOTFERENCE_REVIEW_FILE:-HUMAN_REVIEW_NEEDED.md}" "$template_file" >/dev/null 2>&1; then
    echo ""
    echo "╔══════════════════════════════════════════════╗"
    echo "║  HUMAN REVIEW REQUESTED                     ║"
    echo "╚══════════════════════════════════════════════╝"
    echo ""
    cat "${BOTFERENCE_REVIEW_FILE:-HUMAN_REVIEW_NEEDED.md}"
    echo ""
    echo "To continue: review above, edit checkpoint.md if needed, then:"
    echo "  rm ${BOTFERENCE_REVIEW_FILE:-HUMAN_REVIEW_NEEDED.md} && botference -p"
    return 0
  fi
  return 1
}

restore_truncated_files() {
  local truncated
  local _review_name
  _review_name=$(basename "${BOTFERENCE_REVIEW_FILE:-HUMAN_REVIEW_NEEDED.md}")
  truncated=$(git diff --numstat 2>/dev/null | awk -v excl="$_review_name" '$1 == 0 && $2 > 0 && $3 != excl {print $3}' || true)
  if [ -n "$truncated" ]; then
    echo "  ⚠  TRUNCATED FILES DETECTED:"
    echo "$truncated" | sed 's/^/    /'
    echo "  Restoring from HEAD..."
    echo "$truncated" | xargs git checkout HEAD --
  fi
}

append_changelog_entry() {
  if [ -f "$BOTFERENCE_CHANGELOG_FILE" ] || [ "$ITERATION" -eq 1 ]; then
    local last_msg
    last_msg=$(git log -1 --format='%s' 2>/dev/null || echo "no commit")
    printf "\n## Iteration %d — %s\n- %s\n" "$ITERATION" "$(date +%Y-%m-%d)" "$last_msg" >> "$BOTFERENCE_CHANGELOG_FILE"
  fi
}
