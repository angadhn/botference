#!/usr/bin/env bash

resolve_model() {
  local agent_name="${1:-}"
  local budgets_file="${BOTFERENCE_HOME}/context-budgets.json"
  local model=""

  # ANTHROPIC_MODEL is a global override — when set, it wins over per-agent config.
  # This lets `ANTHROPIC_MODEL=gpt-5.4 botference -p build` run all agents on GPT-5.4.
  if [ -n "${ANTHROPIC_MODEL:-}" ]; then
    echo "$ANTHROPIC_MODEL"
    return
  fi

  # Otherwise check per-agent model in context-budgets.json
  if [ -n "$agent_name" ] && [ -f "$budgets_file" ] && command -v jq >/dev/null 2>&1; then
    model=$(jq -r --arg a "$agent_name" '.[$a].model // empty' "$budgets_file" 2>/dev/null || true)
  fi
  if [ -z "$model" ]; then
    model="${ANTHROPIC_MODEL:-claude-opus-4-7}"
  fi
  echo "$model"
}

resolve_effort() {
  local agent_name="${1:-}"
  local budgets_file="${BOTFERENCE_HOME}/context-budgets.json"
  local effort=""

  if [ -n "$agent_name" ] && [ -f "$budgets_file" ] && command -v jq >/dev/null 2>&1; then
    effort=$(jq -r --arg a "$agent_name" '.[$a].effort // empty' "$budgets_file" 2>/dev/null || true)
  fi
  echo "$effort"
}

resolve_model_and_effort() {
  # Resolves CLI model name and effort flag for a given agent.
  # Sets globals: CLI_MODEL, EFFORT_FLAG
  # Usage: resolve_model_and_effort <model> <agent_name>
  local model="${1:-}"
  local agent_name="${2:-}"
  local effort

  CLI_MODEL=$(resolve_cli_model "$model")
  effort=$(resolve_effort "$agent_name")
  EFFORT_FLAG=""
  if [ -n "$effort" ]; then
    EFFORT_FLAG="--effort $effort"
  fi
}


is_openai_model() {
  local model="${1:-}"
  case "$model" in
    gpt-*|o1*|o3*|o4*) return 0 ;;
    *) return 1 ;;
  esac
}

# Returns 0 if ANTHROPIC_API_KEY is set to a regular API key (sk-ant-api*).
# OAuth tokens (sk-ant-oat*) and missing keys both return 1.
has_anthropic_api_key() {
  local key="${ANTHROPIC_API_KEY:-}"
  [ -z "$key" ] && return 1
  case "$key" in
    sk-ant-api*) return 0 ;;
    *) return 1 ;;
  esac
}

# Returns 0 if the model is an Anthropic model (anything not matched by is_openai_model).
is_anthropic_model() {
  local model="${1:-}"
  is_openai_model "$model" && return 1
  return 0
}

# Build the full system prompt for claude -p headless mode.
# Outputs to stdout: path preamble (if needed) + agent .md + tool-via-bash appendix.
build_claude_system_prompt() {
  local agent_name="${1:-}"

  local project_agent_path="${BOTFERENCE_PROJECT_AGENT_DIR}/${agent_name}.md"
  local compat_path=".claude/agents/${agent_name}.md"
  local framework_path="${BOTFERENCE_HOME}/.claude/agents/${agent_name}.md"

  local is_reserved=false
  if reserved_agent_names | grep -qx "$agent_name"; then
    is_reserved=true
  fi

  # Resolve agent file with the same precedence as botference_agent.py/tools/__init__.py
  local agent_file=""
  if $is_reserved && ! project_agent_override_allowed "$agent_name"; then
    agent_file="$framework_path"
  elif [ -f "$project_agent_path" ]; then
    agent_file="$project_agent_path"
  elif [ -f "$compat_path" ]; then
    agent_file="$compat_path"
  elif [ -f "$framework_path" ]; then
    agent_file="$framework_path"
  else
    echo "Error: agent '${agent_name}' not found in workspace or framework" >&2
    return 1
  fi

  # Build path preamble (mirrors botference_agent.py:build_path_preamble)
  local cwd rh
  cwd=$(pwd -P)
  rh=$(cd "$BOTFERENCE_HOME" && pwd -P)
  if [ "$rh" != "$cwd" ]; then
    cat <<PREAMBLE_EOF
## Path Context

botference is running as an engine on a separate project.
- **BOTFERENCE_HOME** (framework): \`${rh}\`
- **Working directory** (project): \`${cwd}\`

File paths in this prompt use short names. Resolve them as follows:
- **Framework files** — prefix with BOTFERENCE_HOME:
  \`specs/*\`, \`templates/*\`, \`prompt-*.md\`
  Example: \`specs/writing-style.md\` → \`${rh}/specs/writing-style.md\`
- **Agent files** — project-local first: \`botference/agents/{name}.md\`,
  then \`.claude/agents/{name}.md\`, then BOTFERENCE_HOME built-ins
- **Project files** — relative to working directory

PREAMBLE_EOF
  fi

  local work_rel build_rel
  work_rel=$(python3 - <<'PY'
import os
from pathlib import Path
project = Path(os.environ["BOTFERENCE_PROJECT_ROOT"]).resolve()
work = Path(os.environ["BOTFERENCE_WORK_DIR"]).resolve()
print(os.path.relpath(work, project))
PY
)
  build_rel=$(python3 - <<'PY'
import os
from pathlib import Path
project = Path(os.environ["BOTFERENCE_PROJECT_ROOT"]).resolve()
build = Path(os.environ["BOTFERENCE_BUILD_DIR"]).resolve()
print(os.path.relpath(build, project))
PY
)

  # File layout preamble — always emitted (mirrors _build_file_layout_preamble)
  cat <<LAYOUT_EOF
## File Layout

Thread state files and generated outputs live in dedicated directories.
The build system resolves paths automatically.
Use bare names in conversation and plans — the mapping is:

- **Thread files** (\`checkpoint.md\`, \`implementation-plan.md\`, \`inbox.md\`,
  \`HUMAN_REVIEW_NEEDED.md\`, \`iteration_count\`):
  Under \`${work_rel}/\`.

- **Generated outputs** (\`AI-generated-outputs/\`, \`logs/\`, \`run/\`):
  Under \`${build_rel}/\`.

LAYOUT_EOF

  # Agent .md content
  cat "$agent_file"

  # Tools are exposed via MCP server (core/fallback_agent_mcp.py), not via bash template.
  # No tool-via-bash appendix needed.
}

# Generate a temporary MCP config JSON pointing to core/fallback_agent_mcp.py for the given agent.
# Outputs the path to the config file.
build_mcp_config() {
  local agent_name="${1:-}"
  local work_dir="${2:-}"
  local config_file="${BOTFERENCE_RUN}/mcp-${agent_name}.json"

  # mcp requires Python ≥3.10; find the best available interpreter
  local py="python3"
  for candidate in python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1; then
      py="$candidate"
      break
    fi
  done

  # If a work_dir is specified (worktree), set cwd so the MCP server
  # resolves file paths relative to the worktree, not the main project.
  local abs_work_dir=""
  local cwd_line=""
  local extra_args=""
  if [ -n "$work_dir" ] && [ "$work_dir" != "." ]; then
    abs_work_dir=$(cd "$work_dir" && pwd)
    cwd_line="\"cwd\": \"${abs_work_dir}\","
    extra_args=", \"--cwd\", \"${abs_work_dir}\""
  fi

  cat > "$config_file" <<EOF
{
  "mcpServers": {
    "botference-tools": {
      ${cwd_line}
      "command": "${py}",
      "args": ["${BOTFERENCE_HOME}/core/fallback_agent_mcp.py", "${agent_name}"${extra_args}]
    }
  }
}
EOF
  echo "$config_file"
}

resolve_cli_model() {
  # Append [1m] to Claude model names when the context window is 1M.
  # This tells the claude CLI to use the extended context window.
  local model="${1:-claude-opus-4-7}"
  local ctx_window
  ctx_window=$(resolve_context_window "$model")
  if [ "$ctx_window" -ge 1000000 ] 2>/dev/null; then
    case "$model" in
      claude-*) echo "${model}[1m]" ;;
      *) echo "$model" ;;
    esac
  else
    echo "$model"
  fi
}

resolve_context_window() {
  # BOTFERENCE_CONTEXT_WINDOW overrides per-model defaults (e.g. 1000000 for 1M plans)
  if [ -n "${BOTFERENCE_CONTEXT_WINDOW:-}" ]; then
    echo "$BOTFERENCE_CONTEXT_WINDOW"
    return
  fi
  local model="${1:-claude-opus-4-7}"
  case "$model" in
    gpt-5-latest) echo 272000 ;;
    gpt-5.5*) echo 258000 ;;
    gpt-5.4*) echo 272000 ;;
    gpt-4o|gpt-4o-mini) echo 128000 ;;
    claude-haiku*) echo 200000 ;;
    *) echo 1000000 ;;  # Claude Opus/Sonnet default 1M; set BOTFERENCE_CONTEXT_WINDOW=200000 to revert
  esac
}

# ── Worktree isolation functions ─────────────────────────────

create_worktree() {
  # Creates an isolated git worktree for a parallel task.
  # Usage: create_worktree <iteration> <task_index>
  # Returns the worktree directory path on stdout.
  local iteration=$1
  local task_idx=$2
  local wt_name="iter-${iteration}-task-${task_idx}"
  local wt_dir=".worktrees/${wt_name}"
  local branch_name="parallel/${wt_name}"

  # Clean up stale worktree/branch from a previous run
  if git branch --list "$branch_name" | grep -q "$branch_name" 2>/dev/null; then
    git worktree remove "$wt_dir" --force 2>/dev/null || true
    rm -rf "$wt_dir" 2>/dev/null || true
    git branch -D "$branch_name" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
  fi

  # Ensure HEAD exists (worktree requires at least one commit)
  if ! git rev-parse HEAD >/dev/null 2>&1; then
    git add -A 2>/dev/null || true
    git commit -m "chore: auto-commit for worktree support" --quiet 2>/dev/null || true
  fi

  mkdir -p .worktrees
  git worktree add "$wt_dir" -b "$branch_name" HEAD --quiet 2>/dev/null
  if [ $? -ne 0 ]; then
    echo ""
    return 1
  fi
  echo "$wt_dir"
}

remove_worktree() {
  # Removes a worktree and its branch.
  # Usage: remove_worktree <worktree_dir>
  local wt_dir=$1
  local branch_name

  # Extract branch name from worktree
  branch_name=$(git -C "$wt_dir" rev-parse --abbrev-ref HEAD 2>/dev/null)

  git worktree remove "$wt_dir" --force 2>/dev/null || rm -rf "$wt_dir"
  if [ -n "$branch_name" ] && [ "$branch_name" != "HEAD" ]; then
    git branch -D "$branch_name" 2>/dev/null || true
  fi

  # Clean up .worktrees dir if empty
  rmdir .worktrees 2>/dev/null || true
}

merge_worktree() {
  # Merges a worktree's branch into the current branch.
  # Usage: merge_worktree <worktree_dir> [agent_name]
  # Returns 0 on success, 1 on conflict.
  local wt_dir=$1
  local agent_name=${2:-unknown}
  local branch_name

  branch_name=$(git -C "$wt_dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ -z "$branch_name" ] || [ "$branch_name" = "HEAD" ]; then
    echo "  ⚠  Cannot determine branch for worktree $wt_dir"
    return 1
  fi

  # Check if there are any commits to merge
  local main_branch
  main_branch=$(git rev-parse --abbrev-ref HEAD)
  # Auto-commit any uncommitted work the agent left behind
  local uncommitted
  uncommitted=$(git -C "$wt_dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$uncommitted" -gt 0 ]; then
    echo "  📦 Auto-committing $uncommitted uncommitted files from $agent_name"
    git -C "$wt_dir" add -A 2>/dev/null
    git -C "$wt_dir" commit -m "auto-commit: uncommitted work from parallel agent $agent_name" --quiet 2>/dev/null || true
  fi

  if git merge-base --is-ancestor "$branch_name" "$main_branch" 2>/dev/null; then
    # No new commits on the branch — nothing to merge
    return 0
  fi

  if git merge "$branch_name" --no-edit -m "merge: parallel agent $agent_name ($branch_name)" 2>/dev/null; then
    return 0
  else
    # Conflict detected — resolve shared files by keeping ours (we reconcile them separately)
    # but preserve the agent's new files (the actual work product)
    local conflict_files
    conflict_files=$(git diff --name-only --diff-filter=U 2>/dev/null)
    local has_content_conflict=false

    for cf in $conflict_files; do
      case "$cf" in
        checkpoint.md|implementation-plan.md)
          # Expected conflict on shared files — resolve by keeping ours
          git checkout --ours "$cf" 2>/dev/null
          git add "$cf" 2>/dev/null
          ;;
        *)
          # Real content conflict — flag it
          has_content_conflict=true
          echo "  ⚠  Content conflict in $cf from $agent_name"
          ;;
      esac
    done

    if $has_content_conflict; then
      echo "  ⚠  Merge conflict from $agent_name ($branch_name) — non-trivial conflicts"
      git merge --abort 2>/dev/null || true
      return 1
    else
      # All conflicts were on shared files (resolved) — complete the merge
      git commit --no-edit -m "merge: parallel agent $agent_name ($branch_name)" 2>/dev/null
      return 0
    fi
  fi
}

# ── Merge scripts for shared files ───────────────────────────

merge_checkpoints() {
  # Merges N checkpoint.md files from worktrees into one.
  # Concatenates "What I Did" / knowledge state, takes latest "Next Task".
  # Usage: merge_checkpoints <output_path> <wt_checkpoint_1> [wt_checkpoint_2] ...
  local output_path=$1
  shift
  local wt_checkpoints=("$@")

  if [ ${#wt_checkpoints[@]} -eq 0 ]; then
    return 0
  fi

  # Read the base checkpoint (from main) as template
  local base_checkpoint="$output_path"
  local merged_knowledge=""
  local merged_did=""
  local latest_next_task=""

  # Harvest pre-existing state from the base checkpoint first (worktree entries
  # come later and win on dedup, so base rows are only kept if no worktree updates them)
  local base_knowledge
  base_knowledge=$(awk '/^## Knowledge State/{found=1; next} /^## /{found=0} found && /^\|/ && !/^\|.*Task.*Status/ && !/^\|[-]+/' "$base_checkpoint" 2>/dev/null)
  if [ -n "$base_knowledge" ]; then
    merged_knowledge="${base_knowledge}"$'\n'
  fi
  local base_did
  base_did=$(awk '/^## (What I Did|Last Action|Work Done)/{found=1; next} /^## /{found=0} found' "$base_checkpoint" 2>/dev/null)
  if [ -n "$base_did" ]; then
    merged_did="${base_did}"$'\n'
  fi

  for wt_cp in "${wt_checkpoints[@]}"; do
    if [ ! -f "$wt_cp" ]; then continue; fi

    # Extract "What I Did" or similar section content
    local did_section
    did_section=$(awk '/^## (What I Did|Last Action|Work Done)/{found=1; next} /^## /{found=0} found' "$wt_cp" 2>/dev/null)
    if [ -n "$did_section" ]; then
      merged_did="${merged_did}${did_section}"$'\n'
    fi

    # Extract knowledge state table rows — all data rows (deduped later)
    local knowledge_rows
    knowledge_rows=$(awk '/^## Knowledge State/{found=1; next} /^## /{found=0} found && /^\|/ && !/^\|.*Task.*Status/ && !/^\|[-]+/' "$wt_cp" 2>/dev/null)
    if [ -n "$knowledge_rows" ]; then
      merged_knowledge="${merged_knowledge}${knowledge_rows}"$'\n'
    fi
  done

  # Rebuild checkpoint: keep header from base, inject merged sections
  local header
  header=$(awk '/^## Knowledge State/{exit} {print}' "$base_checkpoint")
  local last_updated
  last_updated=$(date +%Y-%m-%d)

  {
    echo "$header" | sed "s/\*\*Last updated:\*\*.*/\*\*Last updated:\*\* $last_updated/"
    echo "## Knowledge State"
    echo ""
    echo "| Task | Status | Notes |"
    echo "|------|--------|-------|"
    if [ -n "$merged_knowledge" ]; then
      # Dedup by task column (col 2), last-seen wins (later in worktree-array order)
      echo "$merged_knowledge" | awk -F'|' '
        NF>=3 { k=$2; gsub(/^[ \t]+|[ \t]+$/,"",k); d[k]=$0; if(!(k in idx)){idx[k]=++n;o[n]=k} }
        END { for(i=1;i<=n;i++) print d[o[i]] }
      '
    fi
    echo ""
    if [ -n "$merged_did" ]; then
      echo "## What I Did"
      echo ""
      echo "$merged_did"
    fi
    echo "## Last Reflection"
    echo ""
    echo "<parallel merge — see individual agent outputs>"
    echo ""
    echo "## Next Task"
    echo ""
    # Read next unchecked task directly from the plan (don't trust agent-written text)
    local plan_next
    plan_next=$(grep '^\- \[ \]' "${BOTFERENCE_PLAN_FILE:-implementation-plan.md}" 2>/dev/null \
      | grep -v '<task description>\|<agent>' \
      | head -1 | sed 's/^- \[ \] //' | sed 's/\*//g')
    if [ -n "$plan_next" ]; then
      echo "$plan_next"
    else
      echo "<all tasks complete>"
    fi
  } > "$output_path"
}

merge_plan_checkboxes() {
  # Unions checkbox state across N copies of implementation-plan.md.
  # If ANY copy has [x] for a task, the result is [x].
  # Usage: merge_plan_checkboxes <main_plan_path> <wt_plan_1> [wt_plan_2] ...
  local main_plan=$1
  shift
  local wt_plans=("$@")

  # Collect all task numbers that are checked in any worktree copy
  local checked_tasks=""
  for wt_plan in "${wt_plans[@]}"; do
    if [ ! -f "$wt_plan" ]; then continue; fi
    local nums
    nums=$(grep '^\- \[x\]' "$wt_plan" 2>/dev/null | sed 's/^- \[x\] \([0-9]*\)\..*/\1/')
    checked_tasks="${checked_tasks} ${nums}"
  done

  # Apply checked state to main plan
  for num in $checked_tasks; do
    if [ -z "$num" ]; then continue; fi
    # Replace [ ] with [x] for this task number
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s/^- \[ \] ${num}\./- [x] ${num}./" "$main_plan"
    else
      sed -i "s/^- \[ \] ${num}\./- [x] ${num}./" "$main_plan"
    fi
  done
}

# ── Pre-merge validation ─────────────────────────────────────

validate_worktree_output() {
  # Checks that a worktree agent produced meaningful output before merging.
  # Usage: validate_worktree_output <worktree_dir> [agent_name] [base_commit]
  # Returns 0 if valid, 1 if output should be rejected.
  local wt_dir=$1
  local agent_name=${2:-unknown}
  local base_commit=${3:-}
  local issues=0

  # Check: agent made at least one commit beyond the base
  # Use the base_commit captured BEFORE any merges (avoids HEAD-advance bug)
  local commit_count
  if [ -n "$base_commit" ]; then
    commit_count=$(git -C "$wt_dir" rev-list --count HEAD ^"$base_commit" 2>/dev/null || echo 0)
  else
    commit_count=$(git -C "$wt_dir" rev-list --count HEAD ^"$(git rev-parse HEAD)" 2>/dev/null || echo 0)
  fi
  if [ "$commit_count" -eq 0 ]; then
    echo "  ⚠  $agent_name: no commits in worktree (empty work)"
    issues=$((issues + 1))
  fi

  # Check: diff is not unreasonably large (>5000 lines suggests runaway)
  local ref="${base_commit:-HEAD~${commit_count}}"
  local diff_lines
  diff_lines=$(git -C "$wt_dir" diff --stat "$ref"..HEAD 2>/dev/null | tail -1 | grep -o '[0-9]* insertion' | grep -o '[0-9]*' || echo 0)
  if [ "$diff_lines" -gt 5000 ]; then
    echo "  ⚠  $agent_name: unusually large diff ($diff_lines insertions)"
    # Warning only — don't reject
  fi

  return $((issues > 0 ? 1 : 0))
}

# ── Orchestrated execution ───────────────────────────────────

run_orchestrator() {
  # Runs the orchestrator agent to get a dispatch decision.
  # Returns the JSON output path on stdout.
  local output_file="${BOTFERENCE_RUN}/orchestrator-${ITERATION}.json"
  rm -f "$output_file"

  local orch_model
  orch_model=$(resolve_model "orchestrator")
  local orch_prompt
  orch_prompt="You are the orchestrator. Read implementation-plan.md and checkpoint.md.
Determine which tasks to dispatch next and output ONLY a JSON dispatch instruction.
Do NOT do any work yourself. Do NOT scrape, write, or edit files.
Your ONLY job is to decide what agents to run and output JSON.

See your full instructions in your agent prompt (botference/agents/orchestrator.md, .claude/agents/orchestrator.md, or BOTFERENCE_HOME built-ins)."

  echo "  🎯 Running orchestrator..." >&2

  local use_claude_fallback=false
  if is_anthropic_model "$orch_model" && ! has_anthropic_api_key; then
    use_claude_fallback=true
  fi

  if $use_claude_fallback; then
    local agent_system_prompt mcp_config cli_model orch_effort orch_effort_flag
    agent_system_prompt=$(build_claude_system_prompt "orchestrator")
    mcp_config=$(build_mcp_config "orchestrator")
    cli_model=$(resolve_cli_model "$orch_model")
    orch_effort=$(resolve_effort "orchestrator")
    orch_effort_flag=""
    [ -n "$orch_effort" ] && orch_effort_flag="--effort $orch_effort"
    echo "$orch_prompt" | claude --model "$cli_model" \
      $orch_effort_flag \
      --tools "" \
      --mcp-config "$mcp_config" \
      --append-system-prompt "$agent_system_prompt" \
      --output-format json \
      --dangerously-skip-permissions > "$output_file" 2>/dev/null || true
  else
    echo "$orch_prompt" | python3 "${BOTFERENCE_HOME}/core/botference_agent.py" \
      --agent "orchestrator" --task - --model "$orch_model" \
      --output-json "$output_file" 2>/dev/null || true
  fi

  if [ ! -f "$output_file" ] || [ ! -s "$output_file" ]; then
    echo "  ⚠  Orchestrator produced no output" >&2
    echo ""
    return 1
  fi

  echo "$output_file"
  return 0
}

parse_orchestrator_dispatch() {
  # Extracts dispatch JSON from orchestrator output.
  # The output file may be claude --output-format json (wrapped) or raw JSON from botference_agent.py.
  local output_file=$1

  # Try to extract the assistant's text content which should contain the JSON
  local json_text
  json_text=$(python3 -c "
import json, sys, re

data = json.load(open('$output_file'))

# Extract text containing the dispatch JSON
text = ''
if isinstance(data, dict):
    result = data.get('result', '')
    # result can be a string (claude CLI) or array of blocks (API)
    if isinstance(result, str):
        text = result
    elif isinstance(result, list):
        for block in result:
            if isinstance(block, dict) and block.get('type') == 'text':
                text = block['text']
                break
    # Maybe the top-level dict IS the dispatch
    if not text and 'action' in data:
        print(json.dumps(data))
        sys.exit(0)

# Strip markdown code fences
text = text.strip()
if text.startswith('\`\`\`'):
    lines = text.split('\n')
    # Remove first line (fence + language) and last line (fence)
    text = '\n'.join(lines[1:])
    if text.rstrip().endswith('\`\`\`'):
        text = text.rstrip()[:-3].rstrip()

# Try parsing as JSON
try:
    d = json.loads(text)
    print(json.dumps(d))
except:
    # Last resort: regex extract
    match = re.search(r'\{.*\"action\".*\}', text, re.DOTALL)
    if match:
        print(match.group())
    else:
        print('{}')
        sys.exit(1)
" 2>/dev/null)

  if [ -z "$json_text" ]; then
    echo "{}"
    return 1
  fi

  echo "$json_text"
}

run_orchestrated_phase() {
  # Orchestrator-driven execution: ask the orchestrator what to do, then do it.
  # All python3 extractions are guarded with || to prevent set -e crashes.

  local orch_output=""
  orch_output=$(run_orchestrator) || true

  if [ -z "$orch_output" ] || [ ! -f "$orch_output" ]; then
    echo "  ⚠  Orchestrator failed — falling back to plan-driven execution"
    return 1
  fi

  local dispatch_json=""
  dispatch_json=$(parse_orchestrator_dispatch "$orch_output") || true

  if [ -z "$dispatch_json" ] || [ "$dispatch_json" = "{}" ]; then
    echo "  ⚠  Orchestrator produced unparseable output — falling back"
    return 1
  fi

  local action=""
  action=$(echo "$dispatch_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('action',''))" 2>/dev/null) || true

  echo "  🎯 Orchestrator action: $action"

  case "$action" in
    done)
      echo "  ✓ Orchestrator says: all tasks complete"
      return 2
      ;;
    dispatch)
      local is_parallel="false"
      is_parallel=$(echo "$dispatch_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print('true' if d.get('parallel') else 'false')" 2>/dev/null) || true
      local reasoning=""
      reasoning=$(echo "$dispatch_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('reasoning',''))" 2>/dev/null) || true

      echo "  🎯 Orchestrator: $reasoning"

      if [ "$is_parallel" = "true" ]; then
        local phase_name=""
        phase_name=$(echo "$dispatch_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('phase',''))" 2>/dev/null) || true
        if [ -n "$phase_name" ]; then
          # Detect the actual phase heading from the plan (orchestrator gives display name)
          local detected_phase=""
          detected_phase=$(detect_current_phase "${BOTFERENCE_PLAN_FILE:-implementation-plan.md}") || true
          if [ -n "$detected_phase" ] && is_parallel_phase "$detected_phase"; then
            run_parallel_phase "$detected_phase"
            return 0
          else
            # Try matching the orchestrator's phase name
            CURRENT_PHASE="## $phase_name"
            run_parallel_phase "$CURRENT_PHASE"
            return 0
          fi
        fi
      fi

      # Serial dispatch — extract the single task's agent
      local agent_name=""
      agent_name=$(echo "$dispatch_json" | python3 -c "import json,sys; d=json.load(sys.stdin); tasks=d.get('tasks',[]); print(tasks[0]['agent'] if tasks else '')" 2>/dev/null) || true
      if [ -n "$agent_name" ]; then
        echo "  Orchestrator dispatching serial agent: $agent_name"
        CURRENT_AGENT="$agent_name"
        return 0
      fi

      echo "  ⚠  Orchestrator dispatch had no tasks"
      return 1
      ;;
    adapt)
      local reasoning=""
      reasoning=$(echo "$dispatch_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('reasoning',''))" 2>/dev/null) || true
      echo "  🔄 Orchestrator adapting plan: $reasoning"

      # Apply adaptations to implementation-plan.md
      echo "$dispatch_json" | python3 -c "
import json, sys
try:
    dispatch = json.load(sys.stdin)
    changes = dispatch.get('changes', [])
    import os; _plan = os.environ.get('BOTFERENCE_PLAN_FILE', 'implementation-plan.md')
    with open(_plan) as f:
        plan = f.read()
    import re
    for change in changes:
        task_num = change.get('task_num')
        action = change.get('change')
        if action == 'skip':
            plan = re.sub(
                rf'^- \[ \] {task_num}\.',
                f'- [x] {task_num}. [SKIPPED: {change.get(\"reason\",\"\")}]',
                plan, flags=re.MULTILINE)
        elif action == 'split':
            subtasks = change.get('subtasks', [])
            if subtasks:
                parent_match = re.search(rf'^(- \[ \] {task_num}\..*)$', plan, re.MULTILINE)
                if parent_match:
                    insert_pos = parent_match.end()
                    subtask_lines = '\n'.join(f'- [ ] {st}' for st in subtasks)
                    plan = plan[:insert_pos] + '\n' + subtask_lines + plan[insert_pos:]
                    plan = plan.replace(parent_match.group(), parent_match.group() + ' [SPLIT]')
    with open(_plan, 'w') as f:
        f.write(plan)
except Exception as e:
    print(f'Adaptation error: {e}', file=sys.stderr)
" 2>/dev/null || true

      git add "${BOTFERENCE_PLAN_FILE:-implementation-plan.md}" 2>/dev/null || true
      git commit -m "orchestrator: adapt plan — $reasoning" --quiet 2>/dev/null || true
      return 0
      ;;
    *)
      echo "  ⚠  Orchestrator returned unknown action: '$action'"
      return 1
      ;;
  esac
}

# ── Parallel phase execution ────────────────────────────────

check_duplicate_agents() {
  # Detects duplicate agent names in a parallel phase.
  # Returns 1 with error output if duplicates found, 0 otherwise.
  # Usage: check_duplicate_agents "scout" "critic" "scout"
  local seen=()
  for a in "$@"; do
    for s in "${seen[@]}"; do
      if [ "$s" = "$a" ]; then
        echo "  ✗ Parallel phase aborted: agent '$a' appears multiple times"
        echo "    Same-agent parallel execution causes merge conflicts on shared output files."
        echo "    Fix: split duplicate agents into separate phases, or use unique agent names."
        return 1
      fi
    done
    seen+=("$a")
  done
  return 0
}

run_parallel_phase() {
  local phase_line=$1
  local pids=()
  local agents=()
  local worktrees=()

  echo "  ⚡ Parallel phase detected: $phase_line"
  echo "  🌿 Using worktree isolation"

  # Capture base commit BEFORE any work — used for validation after merges
  local base_commit
  base_commit=$(git rev-parse HEAD)

  # --- Collect: read all tasks into arrays before any work ---
  local task_agents=()
  local task_descs=()
  while IFS='|' read -r agent_name task_desc; do
    task_agents+=("$agent_name")
    task_descs+=("$task_desc")
  done < <(collect_phase_tasks "${BOTFERENCE_PLAN_FILE:-implementation-plan.md}" "$phase_line")

  if [ ${#task_agents[@]} -eq 0 ]; then
    echo "  No parallel tasks to run."
    return 1
  fi

  # --- Validate: fail closed on duplicate agent names ---
  if ! check_duplicate_agents "${task_agents[@]}"; then
    return 1
  fi

  # --- Spawn: create worktrees and dispatch agents ---
  local task_idx=0
  for i in "${!task_agents[@]}"; do
    local agent_name="${task_agents[$i]}"
    local task_desc="${task_descs[$i]}"
    task_idx=$((task_idx + 1))
    local output_dir="${BOTFERENCE_RUN}/parallel-${ITERATION}-${task_idx}"
    mkdir -p "$output_dir"

    local agent_path
    agent_path=$(resolve_agent_path "$agent_name")
    if [ -z "$agent_path" ]; then
      echo "  ⚠  Skipping parallel task (agent not found): $agent_name"
      echo "     Checked: ${BOTFERENCE_PROJECT_AGENT_DIR}/${agent_name}.md, .claude/agents/${agent_name}.md, ${BOTFERENCE_HOME}/.claude/agents/${agent_name}.md"
      continue
    fi

    # Create isolated worktree for this agent
    local wt_dir
    wt_dir=$(create_worktree "$ITERATION" "$task_idx")
    if [ -z "$wt_dir" ] || [ ! -d "$wt_dir" ]; then
      echo "  ⚠  Failed to create worktree for task $task_idx ($agent_name) — running without isolation"
      wt_dir=""
    else
      echo "  🌿 Worktree: $wt_dir (task $task_idx: $agent_name)"
    fi

    local agent_model
    agent_model=$(resolve_model "$agent_name")

    # Auth-detection: Anthropic model but no API key → use MCP via claude CLI
    local use_claude_fallback=false
    if is_anthropic_model "$agent_model" && ! has_anthropic_api_key; then
      use_claude_fallback=true
      echo "  Spawning parallel agent: $agent_name (task $task_idx, model $agent_model, MCP mode)"
    else
      echo "  Spawning parallel agent: $agent_name (task $task_idx, model $agent_model)"
    fi

    local task_prompt
    task_prompt="## Assigned Task

${task_desc}

$(cat "$PROMPT_FILE")"

    # Determine working directory: worktree if available, otherwise current dir (legacy)
    local work_dir="${wt_dir:-.}"

    # Export task index so agents can namespace outputs to avoid collisions
    export PARALLEL_TASK_IDX=$task_idx

    if $use_claude_fallback; then
      local agent_system_prompt mcp_config
      agent_system_prompt=$(build_claude_system_prompt "$agent_name")
      mcp_config=$(build_mcp_config "$agent_name" "$work_dir")
      local cli_model par_effort par_effort_flag
      cli_model=$(resolve_cli_model "$agent_model")
      par_effort=$(resolve_effort "$agent_name")
      par_effort_flag=""
      [ -n "$par_effort" ] && par_effort_flag="--effort $par_effort"
      (cd "$work_dir" && echo "$task_prompt" | claude --model "$cli_model" \
        $par_effort_flag \
        --tools "" \
        --mcp-config "$mcp_config" \
        --append-system-prompt "$agent_system_prompt" \
        --output-format json \
        --dangerously-skip-permissions > "${output_dir}/output.json") &
    else
      (cd "$work_dir" && echo "$task_prompt" | python3 "${BOTFERENCE_HOME}/core/botference_agent.py" \
        --agent "$agent_name" --task - --model "$agent_model" \
        --output-json "${output_dir}/output.json") &
    fi
    pids+=($!)
    agents+=("$agent_name")
    worktrees+=("$wt_dir")

    # Stagger spawns to avoid rate limiting when hitting OAuth simultaneously
    sleep 2
  done
  unset PARALLEL_TASK_IDX

  if [ ${#pids[@]} -eq 0 ]; then
    echo "  No parallel tasks to run (all agents not found)."
    return 1
  fi

  # --- Phase 2: Wait for all agents ---
  echo "  Waiting for ${#pids[@]} parallel agents..."
  local failed=0
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}" 2>/dev/null; then
      echo "  ✓ ${agents[$i]} completed (task $((i + 1)))"
    else
      echo "  ✗ ${agents[$i]} failed (task $((i + 1)), exit $?)"
      failed=$((failed + 1))
    fi
  done

  echo "  Parallel phase complete: $((${#pids[@]} - failed))/${#pids[@]} succeeded"

  # --- Phase 3: Collect paths from ALL worktrees, then validate and merge ---
  # IMPORTANT: Collect paths BEFORE validation. Even if a worktree's merge is
  # skipped, its implementation-plan.md may have checkboxes we need.
  local wt_checkpoints=()
  local wt_plans=()
  local merge_failures=0

  for i in "${!worktrees[@]}"; do
    local wt="${worktrees[$i]}"
    if [ -z "$wt" ] || [ ! -d "$wt" ]; then
      continue
    fi

    # Always collect paths for reconciliation (regardless of validation outcome)
    local _cp_rel="${BOTFERENCE_CHECKPOINT_FILE#$BOTFERENCE_PROJECT_ROOT/}"
    local _plan_rel="${BOTFERENCE_PLAN_FILE#$BOTFERENCE_PROJECT_ROOT/}"
    [ -f "$wt/$_cp_rel" ] && wt_checkpoints+=("$wt/$_cp_rel")
    [ -f "$wt/$_plan_rel" ] && wt_plans+=("$wt/$_plan_rel")

    # Validate: did the agent produce work?
    if ! validate_worktree_output "$wt" "${agents[$i]}" "$base_commit"; then
      echo "  ⚠  Skipping git merge for ${agents[$i]} (no commits)"
      merge_failures=$((merge_failures + 1))
      continue
    fi

    # Merge worktree branch into main
    if merge_worktree "$wt" "${agents[$i]}"; then
      echo "  🔀 Merged ${agents[$i]} (task $((i + 1)))"
    else
      echo "  ⚠  Merge failed for ${agents[$i]} — branch preserved"
      merge_failures=$((merge_failures + 1))
    fi
  done

  # --- Phase 4: Reconcile shared files ---
  echo "  Reconciling shared files..."

  if [ ${#wt_plans[@]} -gt 0 ]; then
    merge_plan_checkboxes "${BOTFERENCE_PLAN_FILE:-implementation-plan.md}" "${wt_plans[@]}"
    local checked_after
    checked_after=$(grep -c '^\- \[x\]' "${BOTFERENCE_PLAN_FILE:-implementation-plan.md}" 2>/dev/null || echo 0)
    echo "  ☑  Plan checkboxes merged from ${#wt_plans[@]} worktrees ($checked_after tasks now checked)"
  fi

  if [ ${#wt_checkpoints[@]} -gt 0 ]; then
    merge_checkpoints "${BOTFERENCE_CHECKPOINT_FILE:-checkpoint.md}" "${wt_checkpoints[@]}"
    echo "  📋 Checkpoint merged from ${#wt_checkpoints[@]} worktrees"
  fi

  # Commit the reconciled state
  git add "${BOTFERENCE_CHECKPOINT_FILE:-checkpoint.md}" "${BOTFERENCE_PLAN_FILE:-implementation-plan.md}" 2>/dev/null
  git commit -m "merge: reconcile parallel phase — ${#pids[@]} agents" --quiet 2>/dev/null || true

  # --- Phase 4b: Post-merge validation (warnings only) ---
  if [ -f "main.tex" ]; then
    if pdflatex -interaction=nonstopmode -halt-on-error main.tex >/dev/null 2>&1; then
      echo "  ✓ Post-merge: LaTeX compiles"
    else
      echo "  ⚠  Post-merge: LaTeX compilation failed — check main.tex"
    fi
  fi

  # --- Phase 5: Usage logging ---
  for i in "${!agents[@]}"; do
    local idx=$((i + 1))
    local output_file="${BOTFERENCE_RUN}/parallel-${ITERATION}-${idx}/output.json"
    if [ -f "$output_file" ]; then
      log_usage_from_output_json "$output_file" "$ITERATION" "${agents[$i]}" "$LOOP_MODE" "$CURRENT_THREAD" "$idx"
    fi
  done

  # --- Phase 6: Cleanup worktrees ---
  for wt in "${worktrees[@]}"; do
    if [ -n "$wt" ] && [ -d "$wt" ]; then
      remove_worktree "$wt"
    fi
  done
  echo "  🧹 Worktrees cleaned up"

  if [ "$merge_failures" -gt 0 ]; then
    echo "  ⚠  $merge_failures merge issue(s) — check logs above"
  fi

  return 0
}
