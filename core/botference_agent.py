#!/usr/bin/env python3
"""
botference_agent.py — Thin agent runner with per-agent tool registries.

Replaces `claude -p` inside botference. Loads an agent .md file as the
system prompt, registers only the tools that agent needs, and loops until
the model stops requesting tools.

Tool definitions live in tools/ (core.py, checks.py, pdf.py). This file
is just the loop, auth, and CLI.

Usage:
  python botference_agent.py --agent paper-writer --task "Write the methods section"
  python botference_agent.py --agent critic --task "$(cat prompts/build.md)"
"""

import argparse
import json
import os
import sys

from pathlib import Path

# Add project root to path so we can import tools/ and core/ siblings
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.redact import preview_text, redact_text
from tools.fmt import fmt_banner, fmt_tool_call, fmt_tool_result, fmt_separator
from tools import execute_tool, get_tools_for_agent, resolve_agent_file
from tools._pricing import PRICING
from providers import (
    detect_provider, create_client, call_model,
    format_assistant_message, format_tool_results,
    get_transient_errors, get_status_error_class,
    get_context_window, percent_of_limit,
)


def context_threshold(model: str) -> float:
    """Return the context usage threshold for a model.

    Matches the shell-level thresholds in botference:349-352:
    20% for >=1M windows, 45% for <1M.
    """
    return 0.20 if get_context_window(model) >= 1_000_000 else 0.45


def estimate_tool_result_tokens(tool_results: list) -> int:
    """Estimate token count from tool result payloads (~4 chars per token)."""
    total_chars = 0
    for tr in tool_results:
        content = tr.get("content", "")
        if isinstance(content, str):
            total_chars += len(content)
        elif isinstance(content, list):
            # Multimodal content blocks
            for block in content:
                if isinstance(block, dict) and "text" in block:
                    total_chars += len(block["text"])
    return total_chars // 4


def should_stop_for_context(input_tokens: int, output_tokens: int,
                            model: str, tool_result_tokens: int = 0) -> bool:
    """Return True if the estimated next-turn input exceeds the context threshold.

    The next request includes: this turn's input + this turn's output
    (appended as assistant message) + tool result payloads.
    """
    window = get_context_window(model)
    return percent_of_limit(input_tokens, output_tokens,
                            tool_result_tokens, window) >= 100.0


def should_yield() -> bool:
    """Check if the shell monitor has signalled the agent to yield.

    The monitor (lib/monitor.sh) touches $BOTFERENCE_RUN/yield when context usage
    exceeds the threshold.  Guards against empty BOTFERENCE_RUN to avoid resolving
    a bare 'yield' relative to cwd.
    """
    run_dir = os.environ.get("BOTFERENCE_RUN", "")
    if not run_dir:
        return False
    return os.path.exists(os.path.join(run_dir, "yield"))


def truncate_result(result: str, limit: int = 50000) -> str:
    """Truncate tool results while preserving complete lines/JSON entries.

    If the result exceeds `limit` chars, keep complete lines from the start
    up to the limit, then append a summary of what was dropped.
    """
    if len(result) <= limit:
        return result

    total_chars = len(result)
    lines = result.split("\n")
    total_lines = len(lines)

    kept = []
    kept_chars = 0
    kept_count = 0

    for line in lines:
        # +1 for the newline we'll rejoin with
        if kept_chars + len(line) + 1 > limit:
            break
        kept.append(line)
        kept_chars += len(line) + 1
        kept_count += 1

    # If even the first line exceeds the limit, keep it truncated
    if not kept:
        kept.append(lines[0][:limit])
        kept_count = 1

    dropped = total_lines - kept_count
    summary = (
        f"\n\n[truncated: kept {kept_count} of {total_lines} lines, "
        f"{kept_chars} of {total_chars} chars — {dropped} lines dropped]"
    )
    return "\n".join(kept) + summary


def load_env():
    """Load .env file if it exists (avoids needing python-dotenv)."""
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())


load_env()


# ── Path context ───────────────────────────────────────────────

def _build_file_layout_preamble() -> str:
    """Build the file layout preamble explaining state/build layout."""
    project_root = Path(os.environ.get("BOTFERENCE_PROJECT_ROOT", os.getcwd())).resolve()
    work_dir = Path(os.environ.get("BOTFERENCE_WORK_DIR", str(project_root))).resolve()
    build_dir = Path(os.environ.get("BOTFERENCE_BUILD_DIR", str(project_root))).resolve()
    work_rel = os.path.relpath(work_dir, project_root)
    build_rel = os.path.relpath(build_dir, project_root)
    return (
        "## File Layout\n"
        "\n"
        "Thread state files and generated outputs live in dedicated directories.\n"
        "The build system resolves paths automatically.\n"
        "Use bare names in conversation and plans — the mapping is:\n"
        "\n"
        "- **Thread files** (`checkpoint.md`, `implementation-plan.md`, `inbox.md`,\n"
        "  `HUMAN_REVIEW_NEEDED.md`, `iteration_count`):\n"
        f"  Under `{work_rel}/`.\n"
        "\n"
        "- **Generated outputs** (`AI-generated-outputs/`, `logs/`, `run/`):\n"
        f"  Under `{build_rel}/`.\n"
        "\n"
    )


def build_path_preamble(botference_home: Path) -> str:
    """Build a preamble that tells the agent where framework vs project files are.

    Always emits the file layout section (work/build fallback).
    When BOTFERENCE_HOME != CWD, also emits split-project path resolution.
    """
    cwd = Path.cwd().resolve()
    rh = botference_home.resolve()

    file_layout = _build_file_layout_preamble()

    if rh == cwd:
        # Self-hosted mode: framework IS the project. Only need file layout.
        return file_layout

    return (
        "## Path Context\n"
        "\n"
        "botference is running as an engine on a separate project.\n"
        f"- **BOTFERENCE_HOME** (framework): `{rh}`\n"
        f"- **Working directory** (project): `{cwd}`\n"
        "\n"
        "File paths in this prompt use short names. Resolve them as follows:\n"
        "- **Framework files** — prefix with BOTFERENCE_HOME:\n"
        "  `specs/*`, `templates/*`, `prompt-*.md`\n"
        f"  Example: `specs/writing-style.md` → `{rh}/specs/writing-style.md`\n"
        "- **Agent files** — project-local first: `botference/agents/{name}.md`,\n"
        "  then `.claude/agents/{name}.md`, then BOTFERENCE_HOME built-ins\n"
        "- **Project files** — relative to working directory\n"
        "\n"
        + file_layout
    )


# ── Agent loop ─────────────────────────────────────────────────

def run_agent(agent_name: str, system_prompt: str, task: str, model: str,
              max_tokens: int, output_json: str = None, effort: str = None):
    import time as _time
    start_ms = int(_time.time() * 1000)

    provider = detect_provider(model)
    client = create_client(provider)

    # Build tool list for this agent
    tool_names, tools = get_tools_for_agent(agent_name)

    fmt_banner(agent_name, provider, tool_names, model)

    messages = [{"role": "user", "content": task}]
    num_turns = 0
    total_input = 0
    total_output = 0
    total_cache_create = 0
    total_cache_read = 0
    tools_called = []

    _TRANSIENT = get_transient_errors(provider)
    _STATUS_ERROR = get_status_error_class(provider)
    _MAX_RETRIES = 3
    _RETRY_DELAYS = [5, 15, 45]

    while True:
        # Retry transient API errors (rate limit, overload, network).
        # Non-transient errors (auth, bad request) propagate immediately.
        response = None
        for _attempt in range(_MAX_RETRIES + 1):
            try:
                response = call_model(
                    client, provider, model, system_prompt,
                    tools, messages, max_tokens, effort=effort,
                )
                break
            except Exception as e:
                if _STATUS_ERROR and isinstance(e, _STATUS_ERROR):
                    if e.status_code in (500, 529) and _attempt < _MAX_RETRIES:
                        delay = _RETRY_DELAYS[_attempt]
                        print(f"  [retry] API error ({e.status_code}), attempt {_attempt + 1}/{_MAX_RETRIES}, waiting {delay}s", file=sys.stderr)
                        _time.sleep(delay)
                        continue
                    raise
                if _TRANSIENT and isinstance(e, _TRANSIENT):
                    if _attempt < _MAX_RETRIES:
                        delay = _RETRY_DELAYS[_attempt]
                        print(f"  [retry] {type(e).__name__}, attempt {_attempt + 1}/{_MAX_RETRIES}, waiting {delay}s", file=sys.stderr)
                        _time.sleep(delay)
                        continue
                    raise
                raise

        if response is None:
            raise RuntimeError("API call failed after all retries")
        num_turns += 1
        total_input += response.input_tokens
        total_output += response.output_tokens
        total_cache_create += response.cache_creation_input_tokens
        total_cache_read += response.cache_read_input_tokens

        # Add assistant response to conversation
        messages.append(format_assistant_message(provider, response))

        # Process response
        tool_results = []
        for text in response.text_blocks:
            print(text)
        if response.tool_calls:
            fmt_separator()
        for tc in response.tool_calls:
            fmt_tool_call(tc.name, tc.input)
            tools_called.append(tc.name)
            try:
                result = execute_tool(tc.name, tc.input)
            except Exception as e:
                result = f"Tool error: {type(e).__name__}: {e}"
            if isinstance(result, list):
                # Multimodal result (image + text content blocks)
                text_parts = [b["text"] for b in result if b.get("type") == "text"]
                log_preview = "; ".join(text_parts) if text_parts else "(image content)"
                fmt_tool_result(tc.name, preview_text(log_preview))
                tool_results.append({"type": "tool_result", "tool_use_id": tc.id, "content": result})
            else:
                result = truncate_result(result)
                fmt_tool_result(tc.name, preview_text(result))
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tc.id,
                    "content": result,
                })

        # If no tools were called, agent is done
        if not tool_results:
            break

        # Feed results back, loop again
        messages.append(format_tool_results(provider, tool_results))

        # End-of-turn gates
        if should_yield():
            print("  [yield] Context threshold reached — stopping agent loop", file=sys.stderr)
            break
        if should_stop_for_context(response.input_tokens, response.output_tokens,
                                   model, estimate_tool_result_tokens(tool_results)):
            ctx_limit = get_context_window(model)
            pct = int(context_threshold(model) * 100)
            print(f"  [context] Input tokens ({response.input_tokens}) exceed "
                  f"{pct}% of context window ({ctx_limit}) — stopping", file=sys.stderr)
            break

    duration_ms = int(_time.time() * 1000) - start_ms

    # Compute cost from token usage
    prices = PRICING.get(model, PRICING["claude-sonnet-4-6"])
    total_cost_usd = round(
        (total_input * prices["input"]
         + total_output * prices["output"]
         + total_cache_read * prices["cache_read"]
         + total_cache_create * prices["cache_create"]) / 1_000_000,
        6,
    )

    # Write usage JSON compatible with botference's jq parsing
    usage = {
        "is_error": False,
        "num_turns": num_turns,
        "duration_ms": duration_ms,
        "total_cost_usd": total_cost_usd,
        "tools_called": tools_called,
        "result": preview_text(response.text_blocks[0] if response.text_blocks else ""),
        "usage": {
            "input_tokens": total_input,
            "output_tokens": total_output,
            "cache_creation_input_tokens": total_cache_create,
            "cache_read_input_tokens": total_cache_read,
        },
        "modelUsage": {
            model: {
                "inputTokens": total_input,
                "outputTokens": total_output,
                "cacheCreationInputTokens": total_cache_create,
                "cacheReadInputTokens": total_cache_read,
            }
        },
    }
    usage_json = json.dumps(usage)
    if output_json:
        with open(output_json, "w") as f:
            f.write(redact_text(usage_json))
    print(redact_text(usage_json), file=sys.stderr)


# ── CLI ────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Botference agent runner")
    parser.add_argument("--agent", required=True, help="Agent name (e.g., paper-writer)")
    parser.add_argument("--task", required=True, help="Task prompt (or - to read from stdin)")
    default_model = os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-7")
    parser.add_argument("--model", default=default_model,
                        help="Model to use (auto-detects provider from name)")
    parser.add_argument("--max-tokens", type=int, default=None, help="Max output tokens (default: from context-budgets.json or 8096)")
    parser.add_argument("--output-json", help="Write usage JSON to this path (compatible with botference)")
    parser.add_argument(
        "--system-prompt-file",
        help="Use this file as system prompt instead of botference/agents/{agent}.md or the built-in agent prompt",
    )
    args = parser.parse_args()

    # Resolve BOTFERENCE_HOME: env var > script directory
    botference_home = Path(os.environ.get("BOTFERENCE_HOME", str(Path(__file__).parent.parent)))

    # Resolve max_tokens + effort: CLI flag > context-budgets.json > defaults
    effort = None
    agent_budget = {}
    budgets_path = botference_home / "context-budgets.json"
    if budgets_path.exists():
        try:
            budgets = json.loads(budgets_path.read_text())
            agent_budget = budgets.get(args.agent, {})
            effort = agent_budget.get("effort")
        except (json.JSONDecodeError, KeyError):
            pass

    if args.max_tokens is None:
        args.max_tokens = agent_budget.get("max_tokens", 32768) if agent_budget else 32768

    # Load agent prompt (workspace-first resolution)
    if args.system_prompt_file:
        prompt_path = args.system_prompt_file
    else:
        resolved = resolve_agent_file(args.agent)
        framework_path = botference_home / ".claude" / "agents" / f"{args.agent}.md"
        project_agent_dir = Path(os.environ.get("BOTFERENCE_PROJECT_AGENT_DIR", str(Path.cwd() / "botference" / "agents")))
        compat_path = Path.cwd() / ".claude" / "agents" / f"{args.agent}.md"
        if resolved is not None:
            prompt_path = str(resolved)
        else:
            print(f"Error: agent '{args.agent}' not found in:", file=sys.stderr)
            print(f"  project: {project_agent_dir / f'{args.agent}.md'}", file=sys.stderr)
            print(f"  compatibility: {compat_path}", file=sys.stderr)
            print(f"  framework: {framework_path}", file=sys.stderr)
            sys.exit(1)
    with open(prompt_path) as f:
        system_prompt = f.read()

    # Prepend path context so agents resolve framework vs project files correctly
    path_preamble = build_path_preamble(botference_home)
    if path_preamble:
        system_prompt = path_preamble + system_prompt

    # Read task from stdin if -
    task = sys.stdin.read() if args.task == "-" else args.task

    run_agent(args.agent, system_prompt, task, args.model, args.max_tokens, args.output_json, effort=effort)


if __name__ == "__main__":
    main()
