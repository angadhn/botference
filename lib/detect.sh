#!/usr/bin/env bash

extract_next_task_from_checkpoint() {
  local checkpoint_path=$1
  local next_task=""

  next_task=$(grep -i '^\*\*Next Task\*\*:\|^Next Task:' "$checkpoint_path" 2>/dev/null \
    | head -1 | sed 's/.*: *//' | sed 's/\*//g')
  if [ -z "$next_task" ]; then
    next_task=$(awk '/^## Next Task/{found=1; next} found && /[^ ]/{print; exit}' \
      "$checkpoint_path" 2>/dev/null)
  fi

  echo "$next_task" | sed 's/([^)]*)//g; s/\*//g; s/^ *//; s/ *$//'
}

extract_first_unchecked_task_block() {
  local plan_path=$1
  awk '
    /^- \[ \]/ {
      if (in_block) exit
      in_block=1
      print
      next
    }
    in_block {
      if (/^- \[[ x]\]/ || /^###+? /) exit
      print
    }
  ' "$plan_path" 2>/dev/null
}

extract_agent_from_task_block() {
  local task_block=$1
  local agent=""

  agent=$(printf "%s\n" "$task_block" \
    | grep -o '\*\*[^*][^*]*\*\*' \
    | tail -1 \
    | sed 's/\*\*//g' \
    | sed 's/[^a-zA-Z0-9_-]//g')

  if [ -z "$agent" ]; then
    agent=$(printf "%s\n" "$task_block" \
      | tail -1 \
      | sed 's/^ *//; s/ *$//' )
    agent="${agent##* }"
    agent=$(echo "$agent" | sed 's/[^a-zA-Z0-9_-]//g')
  fi

  echo "$agent"
}

detect_agent_from_checkpoint() {
  local checkpoint_path=$1
  local plan_path=${2:-}
  local next_task=""

  next_task=$(extract_next_task_from_checkpoint "$checkpoint_path")

  # Determine if next_task is a terminal/non-task state.
  # Structured task lines start with a digit or checkbox ("- [").
  # Anything else is prose (e.g. "Thread ready for review") or an
  # explicit terminal marker — fall through to the plan.
  local is_terminal=false
  case "$next_task" in
    none*|None*|"<"*|""|[Aa]ll\ tasks\ complete*|*ready\ to\ archive*|[Ss][Tt][Aa][Gg][Ee]\ [Gg][Aa][Tt][Ee]*)
      is_terminal=true
      ;;
    *)
      if ! echo "$next_task" | grep -qE '^[0-9]|^- \['; then
        is_terminal=true
      fi
      ;;
  esac

  if $is_terminal; then
    if [ -n "$plan_path" ]; then
      next_task=$(extract_first_unchecked_task_block "$plan_path")
      if printf "%s\n" "$next_task" | grep -q '<task description>\|<agent>'; then
        next_task=""
      fi
    else
      next_task=""
    fi
  fi

  if [ -z "$next_task" ]; then
    echo ""
    return
  fi

  local agent
  agent=$(extract_agent_from_task_block "$next_task")

  # Validate: extracted word must correspond to a real agent file.
  # Prevents annotations (e.g. "TDD") from being mistaken for agents.
  if [ -n "$agent" ]; then
    local agent_file
    agent_file=$(resolve_agent_path "$agent")
    if [ -z "$agent_file" ]; then
      echo ""
      return
    fi
  fi

  echo "$agent"
}

detect_current_phase() {
  local plan_path=$1
  local in_phase=""
  while IFS= read -r line; do
    if echo "$line" | grep -q '^## Phase'; then
      in_phase="$line"
    fi
    if echo "$line" | grep -q '^\- \[ \]'; then
      echo "$in_phase"
      return
    fi
  done < "$plan_path"
  echo ""
}

is_parallel_phase() {
  local phase_line=$1
  echo "$phase_line" | grep -qi '(parallel)'
}

collect_phase_tasks() {
  local plan_path=$1
  local target_phase=$2
  local in_target=false

  while IFS= read -r line; do
    if echo "$line" | grep -q '^## Phase'; then
      if [ "$line" = "$target_phase" ]; then
        in_target=true
      elif $in_target; then
        break
      fi
    fi

    if $in_target && echo "$line" | grep -q '^\- \[ \]'; then
      local task_desc
      task_desc=$(echo "$line" | sed 's/^- \[ \] [0-9]*\. *//' | sed 's/\*//g')
      local agent_name="${task_desc##* }"
      agent_name=$(echo "$agent_name" | sed 's/[^a-zA-Z0-9_-]//g')
      echo "${agent_name}|${task_desc}"
    fi
  done < "$plan_path"
}

validate_phase_dependencies() {
  # Checks if all (depends: N) dependencies in a parallel phase are satisfied ([x]).
  # Returns 0 if safe to parallelize, 1 if any dependency is unsatisfied.
  local plan_path=$1
  local target_phase=$2
  local violations=0

  while IFS= read -r line; do
    if ! echo "$line" | grep -q '^\- \[ \]'; then
      continue
    fi
    # Extract depends annotation: (depends: 1,2,3)
    local deps
    deps=$(echo "$line" | grep -o '(depends: [0-9,]*)')
    if [ -z "$deps" ]; then
      continue
    fi
    # Extract the task number
    local task_num
    task_num=$(echo "$line" | sed 's/^- \[ \] \([0-9]*\)\..*/\1/')
    # Parse dependency numbers
    local dep_nums
    dep_nums=$(echo "$deps" | sed 's/(depends: //; s/)//' | tr ',' ' ')
    for dep in $dep_nums; do
      # Check if dependency task is completed ([x])
      if ! grep -q "^\- \[x\] ${dep}\." "$plan_path" 2>/dev/null; then
        echo "  ⚠  Task $task_num depends on uncompleted task $dep"
        violations=$((violations + 1))
      fi
    done
  done < <(collect_phase_tasks_raw "$plan_path" "$target_phase")

  return $((violations > 0 ? 1 : 0))
}

collect_phase_tasks_raw() {
  # Like collect_phase_tasks but returns raw lines (not agent|desc format)
  local plan_path=$1
  local target_phase=$2
  local in_target=false

  while IFS= read -r line; do
    if echo "$line" | grep -q '^## Phase'; then
      if [ "$line" = "$target_phase" ]; then
        in_target=true
      elif $in_target; then
        break
      fi
    fi
    if $in_target && echo "$line" | grep -q '^\- \[ \]'; then
      echo "$line"
    fi
  done < "$plan_path"
}

resolve_agent_path() {
  local agent_name=$1
  local project_agent_path="${BOTFERENCE_PROJECT_AGENT_DIR}/${agent_name}.md"
  local compat_path=".claude/agents/${agent_name}.md"
  local framework_path="${BOTFERENCE_HOME}/.claude/agents/${agent_name}.md"

  if reserved_agent_names | grep -qx "$agent_name" && ! project_agent_override_allowed "$agent_name"; then
    if [ -f "$framework_path" ]; then
      echo "$framework_path"
    fi
    return
  fi

  if [ -f "$project_agent_path" ]; then
    echo "$project_agent_path"
  elif [ -f "$compat_path" ]; then
    echo "$compat_path"
  elif [ -f "${BOTFERENCE_HOME}/.claude/agents/${agent_name}.md" ]; then
    echo "$framework_path"
  fi
}

extract_agent_name() {
  local name
  name=$(grep '^\*\*Last agent:\*\*' "${BOTFERENCE_CHECKPOINT_FILE:-checkpoint.md}" 2>/dev/null \
    | sed 's/\*\*Last agent:\*\* *//' | tr -d '[:space:]' | head -1)
  echo "${name:-unknown}"
}

extract_thread() {
  local thread
  thread=$(grep '^\*\*Thread:\*\*\|^Thread:' "${BOTFERENCE_CHECKPOINT_FILE:-checkpoint.md}" 2>/dev/null \
    | head -1 | sed 's/.*: *//' | sed 's/\*//g' | tr -d '[:space:]')
  if [ -z "$thread" ] || [ "$thread" = "<thread-name>" ]; then
    echo "unknown"
  else
    echo "$thread"
  fi
}
