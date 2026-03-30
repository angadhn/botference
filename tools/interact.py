"""Interactive tools: ask_choice, ask_question, scan_workspace.

Let agents interact with the user during planning sessions.
Questions print to stderr (visible in the terminal) and responses
are read from /dev/tty (the actual terminal, not stdin which may be piped).
"""

import os
import re
import glob
import sys


def _read_terminal_line(prompt_text=""):
    """Read a line from the terminal (/dev/tty), bypassing stdin."""
    try:
        with open("/dev/tty", "r") as tty:
            if prompt_text:
                print(prompt_text, end="", file=sys.stderr, flush=True)
            return tty.readline().strip()
    except OSError:
        return ""


def _handle_ask_choice(inp):
    question = inp["question"]
    options = inp["options"]

    print(f"\n{question}\n", file=sys.stderr)
    for i, opt in enumerate(options, 1):
        print(f"  {i}. {opt}", file=sys.stderr)
    print(file=sys.stderr)

    while True:
        response = _read_terminal_line("Your choice (number or text): ")
        if not response:
            return "Error: no terminal available for interactive input"

        # Accept a number
        try:
            idx = int(response) - 1
            if 0 <= idx < len(options):
                chosen = options[idx]
                print(f"  → {chosen}\n", file=sys.stderr)
                return chosen
            else:
                print(f"  Please enter 1–{len(options)}.", file=sys.stderr)
                continue
        except ValueError:
            pass

        # Accept free text (for "other" style options or elaboration)
        print(f"  → {response}\n", file=sys.stderr)
        return response


def _handle_ask_question(inp):
    question = inp["question"]

    print(f"\n{question}\n", file=sys.stderr)

    response = _read_terminal_line("> ")
    if not response:
        return "Error: no terminal available for interactive input"

    print(f"  → {response}\n", file=sys.stderr)
    return response


def _handle_scan_workspace(inp):
    """Deterministic workspace scan: detect state and summarize contents."""
    lines = []

    # --- Detect plan state ---
    state = "cold_start"
    _checkpoint = os.environ.get("BOTFERENCE_CHECKPOINT_FILE", "checkpoint.md")
    _plan = os.environ.get("BOTFERENCE_PLAN_FILE", "implementation-plan.md")
    for fname in (_checkpoint, _plan):
        if os.path.isfile(fname):
            try:
                content = open(fname).read()
                if "<" in content and ">" in content and re.search(r"<[^>]+>", content):
                    pass  # still a template
                elif content.strip():
                    state = "has_plan"
            except OSError:
                pass

    # Check if all tasks are complete
    if state == "has_plan" and os.path.isfile(_plan):
        text = open(_plan).read()
        checked = len(re.findall(r"^- \[x\]", text, re.MULTILINE))
        unchecked = len(re.findall(r"^- \[ \]", text, re.MULTILINE))
        if checked > 0 and unchecked == 0:
            state = "all_complete"

    lines.append(f"State: {state}")
    lines.append("Workspace:")

    # --- .tex files ---
    tex = sorted(glob.glob("**/*.tex", recursive=True))
    if tex:
        names = ", ".join(os.path.basename(f) for f in tex[:10])
        suffix = f" (+{len(tex)-10} more)" if len(tex) > 10 else ""
        lines.append(f"  .tex files: {names}{suffix}")

    # --- .bib files ---
    bib = sorted(glob.glob("**/*.bib", recursive=True))
    if bib:
        for b in bib[:5]:
            try:
                entries = len(re.findall(r"^@", open(b).read(), re.MULTILINE))
                lines.append(f"  .bib: {b} ({entries} entries)")
            except OSError:
                lines.append(f"  .bib: {b}")

    # --- Known directories ---
    _ai_dir = os.environ.get("BOTFERENCE_AI_OUTPUTS_DIR", "AI-generated-outputs")
    for dirname in ("human-inputs", "inputs", "corpus", "papers",
                    _ai_dir):
        if os.path.isdir(dirname):
            contents = os.listdir(dirname)
            if contents:
                names = ", ".join(sorted(contents)[:8])
                suffix = f" (+{len(contents)-8} more)" if len(contents) > 8 else ""
                lines.append(f"  {dirname}/: {names}{suffix}")
            else:
                lines.append(f"  {dirname}/: empty")

    # --- specs/publication-requirements.md ---
    if os.path.isfile("specs/publication-requirements.md"):
        lines.append("  specs/publication-requirements.md: present")

    # --- Source code ---
    code_exts = ("*.py", "*.R", "*.jl", "*.m", "*.js", "*.ts",
                 "*.go", "*.rs", "*.c", "*.cpp")
    code_files = []
    for ext in code_exts:
        code_files.extend(glob.glob(f"**/{ext}", recursive=True))
    if code_files:
        # Group by extension
        by_ext = {}
        for f in code_files:
            e = os.path.splitext(f)[1]
            by_ext.setdefault(e, []).append(f)
        parts = []
        for e, files in sorted(by_ext.items()):
            lang = {".py": "Python", ".R": "R", ".jl": "Julia", ".m": "MATLAB",
                    ".js": "JavaScript", ".ts": "TypeScript", ".go": "Go",
                    ".rs": "Rust", ".c": "C", ".cpp": "C++"}.get(e, e)
            parts.append(f"{lang} ({len(files)} files)")
        lines.append(f"  Source code: {', '.join(parts)}")

    # --- Prior AI outputs ---
    ai_dirs = [d for d in (_ai_dir,)
               if os.path.isdir(d) and os.listdir(d)]
    if not ai_dirs:
        lines.append("  Prior AI outputs: none")

    return "\n".join(lines)


TOOLS = {
    "ask_choice": {
        "name": "ask_choice",
        "description": (
            "Present a multiple-choice question to the user and return their "
            "selection. The user sees numbered options and can pick by number "
            "or type a free-text answer. Use for structured intake questions "
            "where there are clear categories."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question to display",
                },
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of options. The user can pick one or type a free-text answer.",
                },
            },
            "required": ["question", "options"],
        },
        "function": _handle_ask_choice,
    },
    "ask_question": {
        "name": "ask_question",
        "description": (
            "Ask the user an open-ended question and return their free-text "
            "answer. Use when you need a detailed or unpredictable response "
            "rather than a choice from fixed options."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question to display",
                },
            },
            "required": ["question"],
        },
        "function": _handle_ask_question,
    },
    "scan_workspace": {
        "name": "scan_workspace",
        "description": (
            "Scan the workspace and return a structured summary of its state. "
            "Reports whether this is a cold start, has an existing plan, or "
            "all tasks are complete. Lists .tex, .bib, source code files, "
            "known directories (human-inputs, corpus, etc.), and prior AI outputs. "
            "Takes no parameters."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
        "function": _handle_scan_workspace,
    },
}
