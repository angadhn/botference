#!/usr/bin/env bash

estimate_input_cost() {
  local agent_name=$1
  local thread=""
  local total_bytes=0

  local BYTES_PER_TOKEN=35
  # Use model-aware context window if resolve_context_window is available
  local CONTEXT_WINDOW
  CONTEXT_WINDOW=$(resolve_context_window "${ANTHROPIC_MODEL:-claude-opus-4-6}" 2>/dev/null || echo 1000000)
  local BASELINE_OVERHEAD=3000
  local EFFECTIVE_WINDOW=$(( CONTEXT_WINDOW - BASELINE_OVERHEAD ))

  thread=$(extract_thread)

  if [ "$thread" = "unknown" ]; then
    echo 0
    return
  fi

  local base="${BOTFERENCE_AI_OUTPUTS_DIR:-AI-generated-outputs}/$thread"

  case "$agent_name" in
    deep-reader)
      for f in "$base/deep-analysis/notes.md" \
               "$base/scout-corpus/scored_papers.md"; do
        [ -f "$f" ] && total_bytes=$(( total_bytes + $(wc -c < "$f") ))
      done
      ;;
    paper-writer)
      for f in "$base/deep-analysis/notes.md" \
               "$base/deep-analysis/report.tex" \
               "$base/deep-analysis/section_map.md" \
               "$base/writing/outline.md"; do
        [ -f "$f" ] && total_bytes=$(( total_bytes + $(wc -c < "$f") ))
      done
      ;;
    research-coder)
      for f in "$base/deep-analysis/notes.md" \
               "$base/critic-review/figure_proposals.md"; do
        [ -f "$f" ] && total_bytes=$(( total_bytes + $(wc -c < "$f") ))
      done
      ;;
    critic)
      for f in "$base/deep-analysis/report.tex" \
               "$base/deep-analysis/notes.md"; do
        [ -f "$f" ] && total_bytes=$(( total_bytes + $(wc -c < "$f") ))
      done
      ;;
    *)
      echo 0
      return
      ;;
  esac

  local input_tokens=$(( total_bytes * 10 / BYTES_PER_TOKEN ))
  local input_pct=$(( input_tokens * 100 / EFFECTIVE_WINDOW ))
  echo "$input_pct"
}

compute_budget_info() {
  local agent_name=$1
  local pct=${2:-0}
  local headroom=$(( CONTEXT_THRESHOLD - pct ))
  local max_step=0
  local recommendation="PROCEED"
  local input_cost=0

  if [ -f "${BOTFERENCE_HOME}/context-budgets.json" ] && command -v jq &>/dev/null; then
    max_step=$(jq -r --arg a "$agent_name" '.[$a].max_step // 0' \
      "${BOTFERENCE_HOME}/context-budgets.json" 2>/dev/null || echo 0)
  fi

  input_cost=$(estimate_input_cost "$agent_name")
  if [ "$input_cost" -gt 0 ]; then
    local static_read_cost
    static_read_cost=$(jq -r --arg a "$agent_name" \
      '.[$a].steps.read_inputs // .[$a].steps.read_chunk // 0' \
      "${BOTFERENCE_HOME}/context-budgets.json" 2>/dev/null || echo 0)
    if [ "$input_cost" -gt "$static_read_cost" ]; then
      max_step=$(( max_step + input_cost - static_read_cost ))
    fi
  fi

  if [ "$max_step" -gt 0 ]; then
    local caution_threshold=$(( max_step * 3 / 2 ))
    if [ "$headroom" -le "$max_step" ]; then
      recommendation="YIELD"
      if [ ! -f "$YIELD_FILE" ]; then
        touch "$YIELD_FILE"
      fi
    elif [ "$headroom" -le "$caution_threshold" ]; then
      recommendation="CAUTION"
    fi
  fi

  cat > "$BUDGET_FILE" <<BUDGETEOF
agent=$agent_name
context_pct=$pct
threshold=$CONTEXT_THRESHOLD
headroom=$headroom
max_step_cost=$max_step
input_file_cost=$input_cost
recommendation=$recommendation
BUDGETEOF
}

monitor_context() {
  local pid=$1
  local iter_start=$2
  local ignore_until=$3
  local agent_name=${4:-unknown}
  local last_heartbeat=$iter_start

  while kill -0 "$pid" 2>/dev/null; do
    local now
    now=$(date +%s)
    if [ -f "$CTX_FILE" ] && [ "$now" -ge "$ignore_until" ]; then
      local file_time
      local pct
      if [[ "$OSTYPE" == "darwin"* ]]; then
        file_time=$(stat -f %m "$CTX_FILE" 2>/dev/null || echo 0)
      else
        file_time=$(stat -c %Y "$CTX_FILE" 2>/dev/null || echo 0)
      fi
      if [ "$file_time" -ge "$iter_start" ]; then
        pct=$(cat "$CTX_FILE" 2>/dev/null | tr -d '[:space:]')

        if [ -n "$pct" ] 2>/dev/null; then
          compute_budget_info "$agent_name" "$pct"
        fi

        if [ -n "$pct" ] && [ "$pct" -ge "$CONTEXT_THRESHOLD" ] 2>/dev/null; then
          if [ ! -f "$YIELD_FILE" ]; then
            echo ""
            echo "⚠  Context at ${pct}% (threshold: ${CONTEXT_THRESHOLD}%) — yield signal sent"
            echo "   Claude will finish current subtask, then hand off."
            touch "$YIELD_FILE"
          fi
        fi

        if (( now - last_heartbeat >= HEARTBEAT_INTERVAL )); then
          local elapsed=$(( now - iter_start ))
          local mins=$(( elapsed / 60 ))
          local secs=$(( elapsed % 60 ))
          local changed
          local rec=""

          changed=$(git diff --stat --no-color 2>/dev/null | tail -1 | sed 's/^ *//' || echo "")
          if [ -f "$BUDGET_FILE" ]; then
            rec=$(grep '^recommendation=' "$BUDGET_FILE" 2>/dev/null | cut -d= -f2)
          fi

          printf "  [%dm%02ds] context: %s%%" "$mins" "$secs" "$pct"
          if [ -n "$rec" ]; then
            printf " [%s]" "$rec"
          fi
          if [ -n "$changed" ]; then
            printf " | %s" "$changed"
          fi
          printf "\n"
          last_heartbeat=$now
        fi
      fi
    fi
    sleep "$POLL_INTERVAL"
  done
}
