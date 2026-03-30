#!/usr/bin/env bash

# ── Centralized path initialization ─────────────────────────
# Requires BOTFERENCE_HOME and BOTFERENCE_PROJECT_ROOT to be set (bootstrap).
# Defines all canonical path variables with migration shim support.

init_botference_paths() {
  # -- Framework-owned paths (anchored on BOTFERENCE_HOME) --
  BOTFERENCE_SPECS_DIR="${BOTFERENCE_HOME}/specs"
  BOTFERENCE_PROMPTS_DIR="${BOTFERENCE_HOME}/prompts"
  BOTFERENCE_TEMPLATES_DIR="${BOTFERENCE_HOME}/templates"
  export BOTFERENCE_SPECS_DIR BOTFERENCE_PROMPTS_DIR BOTFERENCE_TEMPLATES_DIR

  # -- Project-owned paths (anchored on BOTFERENCE_PROJECT_ROOT) --
  BOTFERENCE_PROJECT_SPECS_DIR="${BOTFERENCE_PROJECT_ROOT}/specs"
  BOTFERENCE_ARCHIVE_DIR="${BOTFERENCE_PROJECT_ROOT}/archive"
  export BOTFERENCE_PROJECT_SPECS_DIR BOTFERENCE_ARCHIVE_DIR

  # Migration shim: working files
  # Prefer work/ when present; fall back to project root for legacy layouts.
  if [ -d "${BOTFERENCE_PROJECT_ROOT}/work" ]; then
    BOTFERENCE_WORK_DIR="${BOTFERENCE_PROJECT_ROOT}/work"
  else
    BOTFERENCE_WORK_DIR="${BOTFERENCE_PROJECT_ROOT}"
  fi
  export BOTFERENCE_WORK_DIR

  # Migration shim: build artifacts
  # Prefer build/ when present; fall back to project root for legacy layouts.
  if [ -d "${BOTFERENCE_PROJECT_ROOT}/build" ]; then
    BOTFERENCE_BUILD_DIR="${BOTFERENCE_PROJECT_ROOT}/build"
  else
    BOTFERENCE_BUILD_DIR="${BOTFERENCE_PROJECT_ROOT}"
  fi
  export BOTFERENCE_BUILD_DIR

  # -- Derived file paths (working files) --
  BOTFERENCE_PLAN_FILE="${BOTFERENCE_WORK_DIR}/implementation-plan.md"
  BOTFERENCE_CHECKPOINT_FILE="${BOTFERENCE_WORK_DIR}/checkpoint.md"
  BOTFERENCE_INBOX_FILE="${BOTFERENCE_WORK_DIR}/inbox.md"
  BOTFERENCE_REVIEW_FILE="${BOTFERENCE_WORK_DIR}/HUMAN_REVIEW_NEEDED.md"
  BOTFERENCE_COUNTER_FILE="${BOTFERENCE_WORK_DIR}/iteration_count"
  export BOTFERENCE_PLAN_FILE BOTFERENCE_CHECKPOINT_FILE BOTFERENCE_INBOX_FILE
  export BOTFERENCE_REVIEW_FILE BOTFERENCE_COUNTER_FILE

  # -- Relay handoff paths (working files) --
  BOTFERENCE_HANDOFF_HISTORY_DIR="${BOTFERENCE_WORK_DIR}/handoffs"
  BOTFERENCE_HANDOFF_CLAUDE_FILE="${BOTFERENCE_WORK_DIR}/handoff-claude.md"
  BOTFERENCE_HANDOFF_CODEX_FILE="${BOTFERENCE_WORK_DIR}/handoff-codex.md"
  export BOTFERENCE_HANDOFF_HISTORY_DIR
  export BOTFERENCE_HANDOFF_CLAUDE_FILE BOTFERENCE_HANDOFF_CODEX_FILE

  # -- Derived paths (build artifacts) --
  BOTFERENCE_AI_OUTPUTS_DIR="${BOTFERENCE_BUILD_DIR}/AI-generated-outputs"
  BOTFERENCE_LOGS_DIR="${BOTFERENCE_BUILD_DIR}/logs"
  BOTFERENCE_RUN_DIR="${BOTFERENCE_BUILD_DIR}/run"
  export BOTFERENCE_AI_OUTPUTS_DIR BOTFERENCE_LOGS_DIR BOTFERENCE_RUN_DIR

  # Legacy alias: BOTFERENCE_RUN is used extensively throughout the codebase
  BOTFERENCE_RUN="$BOTFERENCE_RUN_DIR"
  export BOTFERENCE_RUN

  mkdir -p "$BOTFERENCE_RUN_DIR"
}

# ── CLI argument parsing ─────────────────────────────────────

parse_loop_args() {
  PIPE_MODE=false
  LOOP_MODE="build"
  PROMPT_FILE="prompts/build.md"
  ARCH_MODE=""
  RUN_TAG=""
  MAX_ITERATIONS=""
  SHOW_HELP=false
  CLI_MODEL=""
  BOTFERENCE_MODE=false
  DEBUG_PANES=false
  UI_MODE="textual"

  for arg in "$@"; do
    case "$arg" in
      -p) PIPE_MODE=true ;;
      plan) LOOP_MODE="plan"; PROMPT_FILE=""; BOTFERENCE_MODE=true ;;
      research-plan) LOOP_MODE="research-plan"; PROMPT_FILE="prompts/plan.md"; BOTFERENCE_MODE=true ;;
      archive) LOOP_MODE="archive"; PROMPT_FILE="" ;;
      build) LOOP_MODE="build"; PROMPT_FILE="prompts/build.md" ;;
      --serial) ARCH_MODE="serial" ;;
      --parallel) ARCH_MODE="parallel" ;;
      --orchestrated) ARCH_MODE="orchestrated" ;;
      --run-tag=*) RUN_TAG="${arg#--run-tag=}" ;;
      --anthropic-model=*) CLI_MODEL="${arg#--anthropic-model=}" ;;
      --claude) BOTFERENCE_MODE=false ;;
      --botference|--group) BOTFERENCE_MODE=true ;;
      --ink) UI_MODE="ink" ;;
      --textual) UI_MODE="textual" ;;
      --no-debug-panes) DEBUG_PANES=false ;;
      --help|-h) SHOW_HELP=true ;;
      [0-9]*) MAX_ITERATIONS="$arg" ;;
    esac
  done
}

show_help() {
  cat <<'HELP'
Usage: ./botference [options] [plan|research-plan|archive|build] [iterations]

Modes:
  plan              Freeform planning room (botference mode by default)
  research-plan     Structured planning with prompts/plan.md (botference mode)
  archive           Archive current thread and restore blank templates
  build             Build loop (default)

Options:
  -p                Non-interactive (pipe) mode
  --anthropic-model=<name>  Override Anthropic model (Claude participant)
  --claude          Solo Claude mode (skip Codex, use claude CLI only)
  --ink             Use Ink (Node.js) TUI for botference mode
  --textual         Use Textual (Python) TUI for botference mode (default)
  --no-debug-panes  Disable debug panes in botference mode
  --serial          Force serial architecture
  --parallel        Force parallel architecture
  --run-tag=<tag>   Tag for this run (used in logs)
  --help, -h        Show this help and exit

Supported models:
  claude-opus-4-6       Anthropic Opus 4.6  (1M context)
  claude-sonnet-4-6     Anthropic Sonnet 4.6 (1M context)
  claude-haiku-4-5      Anthropic Haiku 4.5  (200k context)
  gpt-5.4               OpenAI GPT-5.4       (272k context)
  gpt-4o                OpenAI GPT-4o        (128k context)
  o3                    OpenAI o3            (200k context)
  o4-mini               OpenAI o4-mini       (200k context)

Model resolution order:
  1. --anthropic-model flag
  2. ANTHROPIC_MODEL env var
  3. Per-agent model in context-budgets.json
  4. Default: claude-opus-4-6

Environment variables:
  ANTHROPIC_MODEL          Global Anthropic model override (same as --anthropic-model)
  OPENAI_MODEL           OpenAI participant model (default: gpt-5.4)
  BOTFERENCE_HOME          Path to botference framework install
  ANTHROPIC_API_KEY     API key for Anthropic models
  OPENAI_API_KEY        API key for OpenAI models

Examples:
  ./botference plan                                   # Freeform planning room
  ./botference plan --claude                          # Solo Claude freeform planning
  ./botference research-plan                          # Structured planning (botference)
  ./botference research-plan --claude                 # Structured planning (solo Claude)
  ./botference archive                                # Archive current thread state
  ./botference plan --anthropic-model=claude-sonnet-4-6  # Override Anthropic model
  OPENAI_MODEL=o3 ./botference plan                     # Override OpenAI model
  ./botference -p build                               # Non-interactive build loop
  ./botference --anthropic-model=claude-sonnet-4-6 -p    # Build with Sonnet
  ./botference -p build 10                            # Build for max 10 iterations
HELP
}

resolve_arch_mode_from_plan() {
  local cli_override=${1:-}
  local plan_path=${2:-${BOTFERENCE_PLAN_FILE:-implementation-plan.md}}
  local arch_mode="$cli_override"

  if [ -z "$arch_mode" ]; then
    arch_mode=$(grep -i '^\*\*Architecture:\*\*\|^Architecture:' "$plan_path" 2>/dev/null \
      | head -1 | sed 's/.*: *//' | sed 's/\*//g' | tr -d '[:space:]' \
      | tr '[:upper:]' '[:lower:]' || true)
  fi

  if [ -z "$arch_mode" ] || ! echo "$arch_mode" | grep -qE '^(serial|parallel|orchestrated|auto)$'; then
    arch_mode="serial"
  fi

  echo "$arch_mode"
}

resolve_botference_home() {
  local script_path=$1
  if [ -z "${BOTFERENCE_HOME:-}" ]; then
    BOTFERENCE_HOME="$(cd "$(dirname "$script_path")" && pwd)"
  fi
  if [ ! -f "${BOTFERENCE_HOME}/core/botference_agent.py" ]; then
    echo "Error: BOTFERENCE_HOME (${BOTFERENCE_HOME}) does not contain botference_agent.py"
    exit 1
  fi
  export BOTFERENCE_HOME
}

restore_iteration_counter() {
  COUNTER_FILE=${COUNTER_FILE:-${BOTFERENCE_COUNTER_FILE:-iteration_count}}
  if [ -f "$COUNTER_FILE" ]; then
    ITERATION=$(cat "$COUNTER_FILE")
    if ! [[ "$ITERATION" =~ ^[0-9]+$ ]]; then
      echo "Warning: invalid iteration_count ('$ITERATION'), resetting to 0" >&2
      ITERATION=0
    fi
  else
    ITERATION=0
  fi
}

print_loop_banner() {
  echo "=== Council Loop ==="
  echo "Loop mode: $LOOP_MODE"
  echo "Prompt: $PROMPT_FILE"
  if $PIPE_MODE; then
    echo "IO mode: non-interactive (-p)"
  else
    echo "IO mode: interactive"
  fi
  echo "Architecture mode: $ARCH_MODE"
  echo "Context yield threshold: ${CONTEXT_THRESHOLD}%"
  [ -n "${MAX_ITERATIONS:-}" ] && echo "Max iterations: $MAX_ITERATIONS"
  echo "Double Ctrl+C to stop"
  echo ""
}
