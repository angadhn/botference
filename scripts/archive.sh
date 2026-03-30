#!/usr/bin/env bash
set -euo pipefail

# Archive current thread: move all per-thread files to archive/, restore blank templates.
#
# Usage: ./scripts/archive.sh
#   Reads thread name and date from checkpoint/plan files, creates archive/YYYY-MM-DD_thread/,
#   moves checkpoint, plan, agent outputs, reflections, inbox content, and usage log there,
#   then copies templates back and resets state.

# Framework home — defaults to script's parent dir (backward compatible).
# In BOTFERENCE_HOME mode, templates come from the framework; project files stay in CWD.
BOTFERENCE_HOME="${BOTFERENCE_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
BOTFERENCE_PROJECT_ROOT="${BOTFERENCE_PROJECT_ROOT:-$(pwd -P)}"
export BOTFERENCE_HOME BOTFERENCE_PROJECT_ROOT

# Load centralized path model
source "${BOTFERENCE_HOME}/lib/config.sh"
init_botference_paths

# --- Parse checkpoint for thread name and date ---
if [ ! -f "$BOTFERENCE_CHECKPOINT_FILE" ]; then
  echo "Error: $BOTFERENCE_CHECKPOINT_FILE not found" >&2
  exit 1
fi

THREAD=$(grep '^\*\*Thread:\*\*' "$BOTFERENCE_CHECKPOINT_FILE" | sed 's/\*\*Thread:\*\* *//' | tr -d '[:space:]')
LAST_UPDATED=$(grep '^\*\*Last updated:\*\*' "$BOTFERENCE_CHECKPOINT_FILE" | sed 's/\*\*Last updated:\*\* *//' | tr -d '[:space:]')

if [ -z "$THREAD" ] || echo "$THREAD" | grep -q '<.*>'; then
  echo "Error: checkpoint has no real thread name (still a template placeholder)" >&2
  echo "  Run './botference plan' first to create a thread." >&2
  exit 1
fi

# Use last-updated date if available, otherwise today
if [ -z "$LAST_UPDATED" ]; then
  LAST_UPDATED=$(date +%Y-%m-%d)
fi

ARCHIVE_DIR="${BOTFERENCE_ARCHIVE_DIR}/${LAST_UPDATED}_${THREAD}"
if [ -d "$ARCHIVE_DIR" ]; then
  SUFFIX=2
  while [ -d "${ARCHIVE_DIR}_${SUFFIX}" ]; do
    SUFFIX=$((SUFFIX + 1))
  done
  ARCHIVE_DIR="${ARCHIVE_DIR}_${SUFFIX}"
  echo "Archive target exists, using $ARCHIVE_DIR"
fi

# --- Verify templates exist ---
if [ ! -f "$BOTFERENCE_HOME/templates/checkpoint.md" ] || [ ! -f "$BOTFERENCE_HOME/templates/implementation-plan.md" ]; then
  echo "Error: templates/ directory missing required files" >&2
  echo "Expected: $BOTFERENCE_HOME/templates/checkpoint.md and $BOTFERENCE_HOME/templates/implementation-plan.md" >&2
  exit 1
fi
if [ ! -f "$BOTFERENCE_HOME/templates/HUMAN_REVIEW_NEEDED.md" ]; then
  echo "Error: templates/HUMAN_REVIEW_NEEDED.md missing" >&2
  exit 1
fi

# --- Archive ---
mkdir -p "$ARCHIVE_DIR"
mv "$BOTFERENCE_CHECKPOINT_FILE" "$ARCHIVE_DIR/"
mv "$BOTFERENCE_PLAN_FILE" "$ARCHIVE_DIR/"
if [ -f "$BOTFERENCE_REVIEW_FILE" ]; then
  mv "$BOTFERENCE_REVIEW_FILE" "$ARCHIVE_DIR/"
fi

# Also archive iteration_count for the record
if [ -f "$BOTFERENCE_COUNTER_FILE" ]; then
  cp "$BOTFERENCE_COUNTER_FILE" "$ARCHIVE_DIR/"
fi

# Archive per-thread agent outputs (ai-generated-outputs/<thread>/)
# Note: the outputs directory may be a symlink to ../ai-generated-outputs in
# split-layout mode. mv and find resolve through symlinks transparently.
if [ -d "$BOTFERENCE_AI_OUTPUTS_DIR/$THREAD" ]; then
  mkdir -p "$ARCHIVE_DIR/ai-generated-outputs"
  mv "$BOTFERENCE_AI_OUTPUTS_DIR/$THREAD" "$ARCHIVE_DIR/ai-generated-outputs/"
  echo "Archived $BOTFERENCE_AI_OUTPUTS_DIR/$THREAD/"
fi

# Archive reflections (reflections/*.md under outputs dir, preserve .gitkeep)
REFLECTION_DIR="$BOTFERENCE_AI_OUTPUTS_DIR/reflections"
REFLECTION_FILES=$(find "$REFLECTION_DIR/" -name '*.md' -not -name '.gitkeep' 2>/dev/null || true)
if [ -n "$REFLECTION_FILES" ]; then
  mkdir -p "$ARCHIVE_DIR/reflections"
  for f in $REFLECTION_FILES; do
    mv "$f" "$ARCHIVE_DIR/reflections/"
  done
  echo "Archived reflections"
fi

# Archive relay handoff history (work/handoffs/) if present
if [ -d "$BOTFERENCE_HANDOFF_HISTORY_DIR" ]; then
  mv "$BOTFERENCE_HANDOFF_HISTORY_DIR" "$ARCHIVE_DIR/handoffs"
  echo "Archived handoff history"
fi

# Clear live handoff files (not the archival record)
rm -f "$BOTFERENCE_HANDOFF_CLAUDE_FILE" "$BOTFERENCE_HANDOFF_CODEX_FILE"

# Archive inbox if it has content, then reset it
if [ -f "$BOTFERENCE_INBOX_FILE" ] && [ -s "$BOTFERENCE_INBOX_FILE" ]; then
  cp "$BOTFERENCE_INBOX_FILE" "$ARCHIVE_DIR/"
  echo "Archived inbox"
fi
> "$BOTFERENCE_INBOX_FILE"

# Archive CHANGELOG.md (accumulates per-iteration entries across all threads)
if [ -f CHANGELOG.md ]; then
  mv CHANGELOG.md "$ARCHIVE_DIR/"
  echo "# CHANGELOG" > CHANGELOG.md
  echo "Archived and reset CHANGELOG.md"
fi

# Clean project-local runtime state
rm -rf "$BOTFERENCE_RUN_DIR"
echo "Cleaned runtime state directory"

echo "Archived to $ARCHIVE_DIR/"

# --- Restore blank templates ---
cp "$BOTFERENCE_HOME/templates/checkpoint.md" "$BOTFERENCE_CHECKPOINT_FILE"
cp "$BOTFERENCE_HOME/templates/implementation-plan.md" "$BOTFERENCE_PLAN_FILE"
cp "$BOTFERENCE_HOME/templates/HUMAN_REVIEW_NEEDED.md" "$BOTFERENCE_REVIEW_FILE"

echo "Restored blank templates"

# --- Write thread summary to usage log ---
USAGE_LOG="$BOTFERENCE_LOGS_DIR/usage.jsonl"
if [ -f "$USAGE_LOG" ]; then
  SUMMARY=$(jq -sc --arg thread "$THREAD" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    [ .[] | select(.thread == $thread and .error != true) ] |
    if length > 0 then
      {type: "thread_summary", timestamp: $ts, thread: $thread,
       iterations: length,
       first_iteration: (map(.iteration) | min),
       last_iteration: (map(.iteration) | max),
       total_input_tokens: (map(.input_tokens // 0) | add),
       total_output_tokens: (map(.output_tokens // 0) | add),
       total_cost_usd: (map(.cost_usd // 0) | add | . * 100 | round / 100),
       total_duration_ms: (map(.duration_ms // 0) | add),
       agents_used: (map(.agent) | unique)}
    else empty end
  ' "$USAGE_LOG" 2>/dev/null)
  if [ -n "$SUMMARY" ]; then
    echo "$SUMMARY" >> "$USAGE_LOG"
    echo "Thread summary written to $USAGE_LOG"
  fi
fi

# --- Reset iteration counter ---
echo "0" > "$BOTFERENCE_COUNTER_FILE"
echo "Reset iteration counter to 0"

echo ""
echo "Archive complete: $ARCHIVE_DIR"
echo "Root files reset. Ready for a new thread."
