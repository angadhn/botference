#!/usr/bin/env python3
"""
evaluate_iteration.py — Post-iteration evaluation metric capture.

Runs after each iteration of botference. Collects metrics from multiple
sources and appends a single JSON line to logs/eval.jsonl.

Data sources:
  - logs/usage.jsonl  — token counts, cost, duration
  - git diff           — files changed, lines added/removed
  - check_language.py  — language quality gate (if available)
  - check_journal_compliance.py — journal compliance gate (if available)
  - $BOTFERENCE_RUN/context-pct  — peak context window utilization
  - $BOTFERENCE_RUN/yield        — whether context yield was triggered
  - checkpoint.md / implementation-plan.md — task completion

Usage:
  python3 scripts/evaluate_iteration.py --iteration 5
  python3 scripts/evaluate_iteration.py --iteration 5 --arch-mode parallel
  python3 scripts/evaluate_iteration.py --iteration 5 --run-tag serial-run-1
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PROJECT_ROOT))
_logs_dir = Path(os.environ.get("BOTFERENCE_LOGS_DIR", str(PROJECT_ROOT / "logs")))
USAGE_LOG = _logs_dir / "usage.jsonl"
EVAL_LOG = _logs_dir / "eval.jsonl"
CHECKPOINT = Path(os.environ.get("BOTFERENCE_CHECKPOINT_FILE", str(PROJECT_ROOT / "checkpoint.md")))
PLAN = Path(os.environ.get("BOTFERENCE_PLAN_FILE", str(PROJECT_ROOT / "implementation-plan.md")))
import os
_botference_run = os.environ.get("BOTFERENCE_RUN", "./run")
CTX_FILE = Path(_botference_run) / "context-pct"
YIELD_FILE = Path(_botference_run) / "yield"

# Files to exclude from productivity metrics (infra/meta files)
EXCLUDE_PATTERNS = {
    os.path.basename(os.environ.get("BOTFERENCE_CHECKPOINT_FILE", "checkpoint.md")),
    os.path.basename(os.environ.get("BOTFERENCE_PLAN_FILE", "implementation-plan.md")),
    "CHANGELOG.md",
    os.path.basename(os.environ.get("BOTFERENCE_COUNTER_FILE", "iteration_count")),
}
_ai_outputs_reldir = os.path.relpath(os.environ.get("BOTFERENCE_AI_OUTPUTS_DIR", "AI-generated-outputs"))
_logs_reldir = os.path.relpath(os.environ.get("BOTFERENCE_LOGS_DIR", "logs"))
EXCLUDE_PREFIXES = (f"{_ai_outputs_reldir}/", f"{_logs_reldir}/")


def run_cmd(cmd, cwd=None) -> tuple[int, str]:
    """Run a command, return (exit_code, stdout)."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=cwd or str(PROJECT_ROOT),
            timeout=30,
        )
        return result.returncode, result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return 1, ""


def get_usage_entry(iteration: int) -> dict:
    """Find the usage.jsonl entry for the given iteration."""
    if not USAGE_LOG.exists():
        return {}
    # Read in reverse — the latest entry for this iteration is most relevant
    entries = []
    with open(USAGE_LOG) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("iteration") == iteration and entry.get("type") != "thread_summary":
                entries.append(entry)
    return entries[-1] if entries else {}


def should_exclude(filepath: str) -> bool:
    """Check if a file should be excluded from productivity metrics."""
    if os.path.basename(filepath) in EXCLUDE_PATTERNS:
        return True
    for prefix in EXCLUDE_PREFIXES:
        if filepath.startswith(prefix):
            return True
    return False


def get_git_diff_stats() -> dict:
    """Get files changed, lines added/removed from the last commit."""
    rc, output = run_cmd(["git", "diff", "--numstat", "HEAD~1", "HEAD"])
    if rc != 0 or not output:
        # Try against empty tree if there's only one commit
        rc, output = run_cmd(["git", "diff", "--numstat", "--root", "HEAD"])
        if rc != 0 or not output:
            return {"files_changed": 0, "lines_added": 0, "lines_removed": 0}

    files_changed = 0
    lines_added = 0
    lines_removed = 0

    for line in output.split("\n"):
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        filepath = parts[2]
        if should_exclude(filepath):
            continue
        # Binary files show "-" for added/removed
        added = int(parts[0]) if parts[0] != "-" else 0
        removed = int(parts[1]) if parts[1] != "-" else 0
        files_changed += 1
        lines_added += added
        lines_removed += removed

    return {
        "files_changed": files_changed,
        "lines_added": lines_added,
        "lines_removed": lines_removed,
    }


def run_quality_check(script_name: str) -> tuple[bool, int]:
    """Run a quality check script if it exists. Returns (passed, issue_count)."""
    # Search in multiple locations
    candidates = [
        SCRIPT_DIR / script_name,
        PROJECT_ROOT / script_name,
    ]
    script_path = None
    for c in candidates:
        if c.exists():
            script_path = c
            break

    if script_path is None:
        return True, 0  # Script doesn't exist — pass by default

    rc, output = run_cmd(["python3", str(script_path)])
    passed = rc == 0
    # Try to count issues from output lines (heuristic: non-empty lines that look like issues)
    issue_count = 0
    if output:
        for line in output.split("\n"):
            line = line.strip()
            if line and not line.startswith(("OK", "PASS", "All ", "No ")):
                issue_count += 1
    return passed, issue_count


def get_peak_context_pct() -> int:
    """Read peak context percentage from the monitoring file."""
    if CTX_FILE.exists():
        try:
            return int(CTX_FILE.read_text().strip())
        except (ValueError, OSError):
            pass
    return 0


def get_context_yield() -> bool:
    """Check if context yield was triggered."""
    return YIELD_FILE.exists()


def get_task_completion(iteration: int) -> tuple[bool, str]:
    """Check if the current iteration completed its task.

    Looks at the most recent git commit to see if implementation-plan.md
    had a task checked off.
    """
    # Check if implementation-plan.md was modified in the last commit
    _plan_path = os.path.relpath(str(PLAN))
    rc, output = run_cmd(["git", "diff", "HEAD~1", "HEAD", "--", _plan_path])
    if rc != 0:
        return False, ""

    # Look for lines that changed from [ ] to [x]
    task_name = ""
    for line in output.split("\n"):
        if line.startswith("+") and "[x]" in line and not line.startswith("+++"):
            # Extract task name: strip markdown formatting
            task_name = line.lstrip("+").strip()
            task_name = task_name.split(". ", 1)[-1] if ". " in task_name else task_name
            # Remove bold markers and trailing agent name
            task_name = task_name.replace("**", "")
            # Truncate at " — " to get just the task description
            if " — " in task_name:
                parts = task_name.split(" — ")
                task_name = parts[0] + (" — " + parts[1] if len(parts) > 1 else "")
            return True, task_name

    return False, ""


def detect_agent_and_thread() -> tuple[str, str]:
    """Read agent and thread from checkpoint.md."""
    agent = "unknown"
    thread = "unknown"
    if CHECKPOINT.exists():
        text = CHECKPOINT.read_text()
        for line in text.split("\n"):
            if "Last agent:" in line:
                agent = line.split(":", 1)[-1].replace("*", "").strip()
            if "Thread:" in line:
                thread = line.split(":", 1)[-1].replace("*", "").strip()
    return agent, thread


def main():
    parser = argparse.ArgumentParser(description="Capture post-iteration evaluation metrics")
    parser.add_argument("--iteration", type=int, required=True, help="Current iteration number")
    parser.add_argument("--arch-mode", default="serial", help="Architecture mode (serial/parallel)")
    parser.add_argument("--run-tag", default="", help="Tag for this run (for comparison)")
    parser.add_argument("--eval-log", type=Path, default=EVAL_LOG, help="Path to eval.jsonl output")
    parser.add_argument("--dry-run", action="store_true", help="Print entry without writing to file")
    args = parser.parse_args()

    # 1. Usage data (cost, tokens, duration)
    usage = get_usage_entry(args.iteration)

    # 2. Git diff stats (productivity)
    diff_stats = get_git_diff_stats()

    # 3. Quality gates
    lang_pass, lang_issues = run_quality_check("check_language.py")
    journal_pass, journal_issues = run_quality_check("check_journal_compliance.py")

    # 4. Context efficiency
    peak_ctx = get_peak_context_pct()
    ctx_yield = get_context_yield()

    # If we don't have a context reading from the file, estimate from tokens
    if peak_ctx == 0 and usage.get("input_tokens", 0) > 0:
        from providers import get_context_window
        model = usage.get("model", "claude-opus-4-7")
        ctx_window = get_context_window(model)
        peak_ctx = int(usage["input_tokens"] / ctx_window * 100)

    # 5. Task completion
    task_done, task_name = get_task_completion(args.iteration)

    # 6. Agent and thread
    agent, thread = detect_agent_and_thread()

    # Build eval entry
    entry = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "run_tag": args.run_tag or f"{args.arch_mode}-default",
        "arch_mode": args.arch_mode,
        "iteration": args.iteration,
        "agent": usage.get("agent", agent),
        "thread": usage.get("thread", thread),
        "cost_usd": usage.get("cost_usd", 0.0),
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "duration_ms": usage.get("duration_ms", 0),
        "files_changed": diff_stats["files_changed"],
        "lines_added": diff_stats["lines_added"],
        "lines_removed": diff_stats["lines_removed"],
        "language_check_pass": lang_pass,
        "language_check_issues": lang_issues,
        "journal_check_pass": journal_pass,
        "journal_check_issues": journal_issues,
        "peak_context_pct": peak_ctx,
        "context_yield": ctx_yield,
        "task_completed": task_done,
        "task_name": task_name,
    }

    json_line = json.dumps(entry, ensure_ascii=False)

    if args.dry_run:
        print(json_line)
        return

    # Append to eval.jsonl
    args.eval_log.parent.mkdir(parents=True, exist_ok=True)
    with open(args.eval_log, "a") as f:
        f.write(json_line + "\n")

    print(f"Eval logged: iter={args.iteration} agent={entry['agent']} "
          f"cost=${entry['cost_usd']:.4f} files={entry['files_changed']} "
          f"task_done={entry['task_completed']} ctx={entry['peak_context_pct']}%")


if __name__ == "__main__":
    main()
