#!/usr/bin/env bash

# ── Centralized path initialization ─────────────────────────
# Requires BOTFERENCE_HOME and BOTFERENCE_PROJECT_ROOT to be set (bootstrap).
# Defines all canonical path variables with migration shim support.

init_botference_paths() {
  BOTFERENCE_PROJECT_DIR_NAME="${BOTFERENCE_PROJECT_DIR_NAME:-botference}"
  BOTFERENCE_PROJECT_DIR="${BOTFERENCE_PROJECT_ROOT}/${BOTFERENCE_PROJECT_DIR_NAME}"
  BOTFERENCE_PROJECT_CONFIG_FILE="${BOTFERENCE_PROJECT_DIR}/project.json"
  BOTFERENCE_PROJECT_AGENT_DIR="${BOTFERENCE_PROJECT_DIR}/agents"
  BOTFERENCE_PROJECT_README_FILE="${BOTFERENCE_PROJECT_DIR}/README.md"
  BOTFERENCE_CHANGELOG_FILE="${BOTFERENCE_PROJECT_ROOT}/CHANGELOG.md"
  export BOTFERENCE_PROJECT_DIR_NAME BOTFERENCE_PROJECT_DIR
  export BOTFERENCE_PROJECT_CONFIG_FILE BOTFERENCE_PROJECT_AGENT_DIR
  export BOTFERENCE_PROJECT_README_FILE BOTFERENCE_CHANGELOG_FILE

  # -- Framework-owned paths (anchored on BOTFERENCE_HOME) --
  BOTFERENCE_SPECS_DIR="${BOTFERENCE_HOME}/specs"
  BOTFERENCE_PROMPTS_DIR="${BOTFERENCE_HOME}/prompts"
  BOTFERENCE_TEMPLATES_DIR="${BOTFERENCE_HOME}/templates"
  export BOTFERENCE_SPECS_DIR BOTFERENCE_PROMPTS_DIR BOTFERENCE_TEMPLATES_DIR

  # -- Project-owned paths (anchored on BOTFERENCE_PROJECT_ROOT) --
  BOTFERENCE_PROJECT_SPECS_DIR="${BOTFERENCE_PROJECT_ROOT}/specs"
  export BOTFERENCE_PROJECT_SPECS_DIR

  if [ -d "${BOTFERENCE_PROJECT_DIR}" ]; then
    BOTFERENCE_WORK_DIR="${BOTFERENCE_PROJECT_DIR}"
    BOTFERENCE_BUILD_DIR="${BOTFERENCE_PROJECT_DIR}/build"
    BOTFERENCE_ARCHIVE_DIR="${BOTFERENCE_PROJECT_DIR}/archive"
    BOTFERENCE_CHANGELOG_FILE="${BOTFERENCE_PROJECT_DIR}/CHANGELOG.md"
  else
    BOTFERENCE_ARCHIVE_DIR="${BOTFERENCE_PROJECT_ROOT}/archive"
    # Migration shim: working files
    # Prefer work/ when present; fall back to project root for legacy layouts.
    if [ -d "${BOTFERENCE_PROJECT_ROOT}/work" ]; then
      BOTFERENCE_WORK_DIR="${BOTFERENCE_PROJECT_ROOT}/work"
    else
      BOTFERENCE_WORK_DIR="${BOTFERENCE_PROJECT_ROOT}"
    fi

    # Migration shim: build artifacts
    # Prefer build/ when present; fall back to project root for legacy layouts.
    if [ -d "${BOTFERENCE_PROJECT_ROOT}/build" ]; then
      BOTFERENCE_BUILD_DIR="${BOTFERENCE_PROJECT_ROOT}/build"
    else
      BOTFERENCE_BUILD_DIR="${BOTFERENCE_PROJECT_ROOT}"
    fi
  fi
  export BOTFERENCE_WORK_DIR BOTFERENCE_BUILD_DIR BOTFERENCE_ARCHIVE_DIR

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

  mkdir -p "$BOTFERENCE_ARCHIVE_DIR"
  mkdir -p "$BOTFERENCE_RUN_DIR"

  if [ -d "${BOTFERENCE_PROJECT_DIR}" ]; then
    mkdir -p "$BOTFERENCE_PROJECT_AGENT_DIR" "$BOTFERENCE_HANDOFF_HISTORY_DIR"
    mkdir -p "$BOTFERENCE_AI_OUTPUTS_DIR" "$BOTFERENCE_LOGS_DIR"
  fi

  load_project_policy
}

load_project_policy() {
  BOTFERENCE_PROJECT_PROFILE="legacy"
  BOTFERENCE_MODE_PLAN_ALLOWED=true
  BOTFERENCE_MODE_RESEARCH_PLAN_ALLOWED=true
  BOTFERENCE_MODE_BUILD_ALLOWED=true
  BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS=""
  BOTFERENCE_BUILD_EXTRA_WRITE_ROOTS=""
  BOTFERENCE_AGENT_OVERRIDES=""
  export BOTFERENCE_PROJECT_PROFILE BOTFERENCE_MODE_PLAN_ALLOWED
  export BOTFERENCE_MODE_RESEARCH_PLAN_ALLOWED BOTFERENCE_MODE_BUILD_ALLOWED
  export BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS BOTFERENCE_BUILD_EXTRA_WRITE_ROOTS
  export BOTFERENCE_AGENT_OVERRIDES

  if [ ! -f "$BOTFERENCE_PROJECT_CONFIG_FILE" ]; then
    return 0
  fi

  local policy_env
  policy_env=$(python3 - "$BOTFERENCE_PROJECT_CONFIG_FILE" <<'PY'
import json
import shlex
import sys
from pathlib import Path

cfg = Path(sys.argv[1])
data = json.loads(cfg.read_text(encoding="utf-8"))

def roots(name):
    return ",".join(data.get("write_roots", {}).get(name, []))

def mode(name, default=True):
    return "true" if data.get("modes", {}).get(name, default) else "false"

def q(value):
    return shlex.quote(value)

print(f"BOTFERENCE_PROJECT_PROFILE={q(data.get('profile', 'legacy'))}")
print(f"BOTFERENCE_MODE_PLAN_ALLOWED={mode('plan')}")
print(f"BOTFERENCE_MODE_RESEARCH_PLAN_ALLOWED={mode('research_plan')}")
print(f"BOTFERENCE_MODE_BUILD_ALLOWED={mode('build')}")
print(f"BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS={q(roots('plan'))}")
print(f"BOTFERENCE_BUILD_EXTRA_WRITE_ROOTS={q(roots('build'))}")
print(f"BOTFERENCE_AGENT_OVERRIDES={q(','.join(data.get('agent_overrides', [])))}")
PY
)
  eval "$policy_env"
  export BOTFERENCE_PROJECT_PROFILE BOTFERENCE_MODE_PLAN_ALLOWED
  export BOTFERENCE_MODE_RESEARCH_PLAN_ALLOWED BOTFERENCE_MODE_BUILD_ALLOWED
  export BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS BOTFERENCE_BUILD_EXTRA_WRITE_ROOTS
  export BOTFERENCE_AGENT_OVERRIDES
}

mode_is_allowed() {
  local mode=$1
  case "$mode" in
    plan) $BOTFERENCE_MODE_PLAN_ALLOWED ;;
    research-plan) $BOTFERENCE_MODE_RESEARCH_PLAN_ALLOWED ;;
    build) $BOTFERENCE_MODE_BUILD_ALLOWED ;;
    *) return 0 ;;
  esac
}

reserved_agent_names() {
  local agent_dir="${BOTFERENCE_HOME}/.claude/agents"
  if [ -d "$agent_dir" ]; then
    find "$agent_dir" -maxdepth 1 -type f -name '*.md' -exec basename {} .md \; | sort -u
  fi
}

project_agent_override_allowed() {
  local agent_name=$1
  local overrides=",${BOTFERENCE_AGENT_OVERRIDES},"
  [[ "$overrides" == *",$agent_name,"* ]]
}

validate_project_agents() {
  local had_error=false
  local agent_file agent_name
  for base in "$BOTFERENCE_PROJECT_AGENT_DIR" "${BOTFERENCE_PROJECT_ROOT}/.claude/agents"; do
    [ -d "$base" ] || continue
    while IFS= read -r agent_file; do
      [ -z "$agent_file" ] && continue
      agent_name=$(basename "$agent_file" .md)
      if reserved_agent_names | grep -qx "$agent_name" && ! project_agent_override_allowed "$agent_name"; then
        echo "Error: project agent '$agent_name' shadows a built-in agent but is not listed in agent_overrides." >&2
        echo "  Move it to a unique name or add '$agent_name' to ${BOTFERENCE_PROJECT_CONFIG_FILE}." >&2
        had_error=true
      fi
    done < <(find "$base" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort)
  done

  if $had_error; then
    return 1
  fi
  return 0
}

project_relative_path() {
  local path=$1
  local rel="${path#$BOTFERENCE_PROJECT_ROOT/}"
  if [ "$path" = "$BOTFERENCE_PROJECT_ROOT" ]; then
    rel="."
  fi
  printf '%s\n' "$rel"
}

policy_path_allowed() {
  local path=$1
  local mode=$2
  local rel
  rel=$(project_relative_path "$path")

  # Legacy/self-hosted mode keeps the old behavior.
  if [ "$BOTFERENCE_WORK_DIR" = "$BOTFERENCE_PROJECT_ROOT" ] && [ ! -d "${BOTFERENCE_PROJECT_DIR}" ]; then
    case "$mode" in
      plan)
        case "$(basename "$path")" in
          checkpoint.md|implementation-plan.md|implementation-plan-*.md|inbox.md)
            return 0
            ;;
        esac
        return 1
        ;;
      *)
        return 0
        ;;
    esac
  fi

  case "$rel" in
    "${BOTFERENCE_PROJECT_DIR_NAME}/implementation-plan.md"|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/implementation-plan-"*.md|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/checkpoint.md"|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/inbox.md"|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/HUMAN_REVIEW_NEEDED.md"|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/iteration_count"|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/CHANGELOG.md"|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/handoff-claude.md"|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/handoff-codex.md")
      return 0
      ;;
    "${BOTFERENCE_PROJECT_DIR_NAME}/handoffs/"*|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/archive/"*|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/build/logs/"*|\
    "${BOTFERENCE_PROJECT_DIR_NAME}/build/run/"*)
      return 0
      ;;
  esac

  local roots=""
  case "$mode" in
    plan) roots="$BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS" ;;
    build) roots="$BOTFERENCE_BUILD_EXTRA_WRITE_ROOTS" ;;
  esac

  local root
  for root in $(printf '%s' "$roots" | tr ',' ' '); do
    [ -n "$root" ] || continue
    case "$rel" in
      "$root"|"$root/"*)
        return 0
        ;;
    esac
  done
  return 1
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
  INIT_PROFILE="vault-drafter"

  for arg in "$@"; do
    case "$arg" in
      -p) PIPE_MODE=true ;;
      init) LOOP_MODE="init"; PROMPT_FILE=""; BOTFERENCE_MODE=false ;;
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
      --profile=*) INIT_PROFILE="${arg#--profile=}" ;;
      --no-debug-panes) DEBUG_PANES=false ;;
      --help|-h) SHOW_HELP=true ;;
      [0-9]*) MAX_ITERATIONS="$arg" ;;
    esac
  done
}

show_help() {
  cat <<'HELP'
Usage: botference [options] [init|plan|research-plan|archive|build] [iterations]

Modes:
  init              Bootstrap a project-local botference/ directory
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
  --profile=<name>  Init profile (default: vault-drafter)
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
  botference init                                     # Bootstrap botference/ in this project
  botference plan                                     # Freeform planning room
  botference plan --claude                            # Solo Claude freeform planning
  botference research-plan                            # Structured planning (botference)
  botference research-plan --claude                   # Structured planning (solo Claude)
  botference archive                                  # Archive current thread state
  botference plan --anthropic-model=claude-sonnet-4-6 # Override Anthropic model
  OPENAI_MODEL=o3 botference plan                     # Override OpenAI model
  botference -p build                                 # Non-interactive build loop
  botference --anthropic-model=claude-sonnet-4-6 -p  # Build with Sonnet
  botference -p build 10                              # Build for max 10 iterations
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

is_interactive_plan_mode() {
  [[ "$LOOP_MODE" == "plan" || "$LOOP_MODE" == "research-plan" ]] && ! $PIPE_MODE
}
