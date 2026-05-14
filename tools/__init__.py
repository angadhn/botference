from __future__ import annotations

"""Tool registry for botference_agent.py.

Collects tool definitions from submodules and provides per-agent registries.
Adding a tool = adding it to the right submodule's TOOLS dict + AGENT_TOOLS here.
"""

import os
import re
from pathlib import Path
from typing import Optional

from tools.core import TOOLS as _core_tools
from tools.checks import TOOLS as _checks_tools
from tools.pdf import TOOLS as _pdf_tools
from tools.search import TOOLS as _search_tools
from tools.download import TOOLS as _download_tools
from tools.claims import TOOLS as _claims_tools
from tools.interact import TOOLS as _interact_tools
from tools.github import TOOLS as _github_tools
from tools.latex import TOOLS as _latex_tools
from tools.verify import TOOLS as _verify_tools
from tools.paper_ledger import TOOLS as _paper_ledger_tools
from tools.visual import TOOLS as _visual_tools

# ── Merged registry ───────────────────────────────────────────

TOOLS = {}
TOOLS.update(_core_tools)
TOOLS.update(_checks_tools)
TOOLS.update(_pdf_tools)
TOOLS.update(_search_tools)
TOOLS.update(_download_tools)
TOOLS.update(_claims_tools)
TOOLS.update(_interact_tools)
TOOLS.update(_github_tools)
TOOLS.update(_latex_tools)
TOOLS.update(_verify_tools)
TOOLS.update(_paper_ledger_tools)
TOOLS.update(_visual_tools)

# ── Per-agent tool registries ─────────────────────────────────
# Every agent gets the essentials: read_file, write_file, git_commit, list_files, code_search
# Only agents that genuinely need full shell access get bash.

_ESSENTIALS = ["read_file", "write_file", "bash", "git_commit", "git_push", "list_files", "code_search"]

# Server-side tools — executed by the API, not locally.
# Keyed by tool name; values are the raw tool definitions sent to the API.
SERVER_TOOLS = {
    "web_search": {"type": "web_search_20250305", "name": "web_search"},
}

AGENT_TOOLS = {
    "paper-writer": _ESSENTIALS + ["check_language", "citation_lint", "compile_latex", "validate_support_requests"],
    "critic": _ESSENTIALS + ["check_language", "check_journal", "check_figure", "visual_check_html", "check_claims", "citation_verify_all", "verify_cited_claims", "build_cited_tracker_from_tex"],
    "scout": _ESSENTIALS + ["web_search", "pdf_metadata", "citation_lookup", "citation_verify", "citation_verify_all", "citation_manifest", "citation_download", "validate_paper_ledger", "render_paper_ledger_markdown", "validate_support_requests"],
    "deep-reader": _ESSENTIALS + ["pdf_metadata", "extract_figure", "view_pdf_page", "validate_paper_ledger", "render_paper_ledger_markdown", "validate_support_requests"],
    "research-coder": _ESSENTIALS,
    "figure-stylist": _ESSENTIALS + ["check_figure", "visual_check_html", "view_pdf_page"],
    "editor": _ESSENTIALS + ["check_claims", "check_language", "citation_lint", "citation_verify_all", "verify_cited_claims", "build_cited_tracker_from_tex"],
    "coherence-reviewer": _ESSENTIALS + ["check_claims", "check_language"],
    "provocateur": _ESSENTIALS + [],
    "synthesizer": _ESSENTIALS + ["citation_lint", "citation_verify_all"],
    "triage": _ESSENTIALS + ["pdf_metadata", "citation_verify_all", "validate_paper_ledger", "render_paper_ledger_markdown"],
    "coder": _ESSENTIALS + ["gh"],
    # plan mode uses claude CLI (not botference_agent.py) — no tool registry needed
}

DEFAULT_TOOLS = _ESSENTIALS

# All known tool names (for validating agent file declarations)
ALL_TOOL_NAMES = set(TOOLS.keys()) | set(SERVER_TOOLS.keys())
RESERVED_AGENT_NAMES = set(AGENT_TOOLS.keys()) | {"plan", "orchestrator"}


# ── Tool dispatch ─────────────────────────────────────────────

def api_schema(tool: dict) -> dict:
    """Strip function from tool def for the API payload."""
    return {k: v for k, v in tool.items() if k != "function"}


def execute_tool(name: str, tool_input: dict):
    """Dispatch a tool call to its colocated handler."""
    tool = TOOLS.get(name)
    if not tool:
        return f"Unknown tool: {name}"
    violation = _mutation_policy_violation(name, tool_input)
    if violation:
        return violation
    return tool["function"](tool_input)


def _active_tool_mode() -> str:
    return os.environ.get("BOTFERENCE_ACTIVE_MODE", "build").strip() or "build"


def _extra_write_roots_for_mode(mode: str) -> list[Path]:
    env_name = "BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS" if mode == "plan" else "BOTFERENCE_BUILD_EXTRA_WRITE_ROOTS"
    raw = os.environ.get(env_name, "")
    project_root = _project_root()
    roots: list[Path] = []
    for root in raw.split(","):
        root = root.strip()
        if not root:
            continue
        candidate = Path(root).expanduser()
        if not candidate.is_absolute():
            candidate = project_root / candidate
        roots.append(candidate.resolve())
    return roots


def _project_root() -> Path:
    return Path(os.environ.get("BOTFERENCE_PROJECT_ROOT", os.getcwd())).resolve()


def _project_dir_name() -> str:
    return os.environ.get("BOTFERENCE_PROJECT_DIR_NAME", "botference")


def _project_dir() -> Path:
    return Path(os.environ.get("BOTFERENCE_PROJECT_DIR", _project_root() / _project_dir_name())).resolve()


def _work_dir() -> Path:
    return Path(os.environ.get("BOTFERENCE_WORK_DIR", _project_root())).resolve()


def _resolved_tool_path(raw_path: str) -> Path:
    return (Path.cwd() / raw_path).resolve() if not os.path.isabs(raw_path) else Path(raw_path).resolve()


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _policy_path_allowed_python(path: Path, mode: str) -> bool:
    project_root = _project_root()
    if ".git" in path.parts:
        return False

    work_dir = _work_dir()
    project_dir = _project_dir()
    project_dir_exists = project_dir.is_dir()
    project_config_exists = (_project_root() / _project_dir_name() / "project.json").is_file()

    if _is_relative_to(path, project_root):
        if work_dir == project_root and not project_dir_exists:
            if mode == "plan":
                return path.name in {
                    "checkpoint.md",
                    "implementation-plan.md",
                    "inbox.md",
                } or path.name.startswith("implementation-plan-")
            return True

        if not project_config_exists and mode == "plan" and work_dir != project_root and _is_relative_to(path, work_dir):
            return True

    for root in _extra_write_roots_for_mode(mode):
        if _is_relative_to(path, root):
            return True
    return False


def _mutation_policy_violation(name: str, tool_input: dict) -> Optional[str]:
    candidate_paths: list[str] = []
    if name in {"write_file", "edit_file", "delete_file"}:
        if isinstance(tool_input.get("file_path"), str):
            candidate_paths.append(tool_input["file_path"])
    elif name == "compile_latex":
        target = tool_input.get("file", "main.tex")
        if isinstance(target, str) and target.strip():
            candidate_paths.append(str(Path(target).parent))
    elif name == "build_cited_tracker_from_tex":
        if isinstance(tool_input.get("output_file"), str):
            candidate_paths.append(tool_input["output_file"])
    elif name == "extract_figure" and not tool_input.get("list_only"):
        if isinstance(tool_input.get("output_dir"), str):
            candidate_paths.append(tool_input["output_dir"])
    elif name == "citation_lint":
        if isinstance(tool_input.get("bib_dir"), str):
            candidate_paths.append(tool_input["bib_dir"])
    elif name == "citation_lookup" and isinstance(tool_input.get("output_file"), str):
        candidate_paths.append(tool_input["output_file"])
    elif name == "citation_download" and isinstance(tool_input.get("papers_dir"), str):
        candidate_paths.append(tool_input["papers_dir"])
    elif name == "citation_manifest" and tool_input.get("file") and isinstance(tool_input.get("papers_dir"), str):
        candidate_paths.append(tool_input["papers_dir"])
    elif name == "verify_cited_claims":
        if isinstance(tool_input.get("output_dir"), str):
            candidate_paths.append(tool_input["output_dir"])
        if tool_input.get("auto_download") and isinstance(tool_input.get("papers_dir"), str):
            candidate_paths.append(tool_input["papers_dir"])
    elif name == "render_paper_ledger_markdown" and isinstance(tool_input.get("output_file"), str):
        candidate_paths.append(tool_input["output_file"])
    elif name == "visual_check_html" and isinstance(tool_input.get("output_dir"), str):
        candidate_paths.append(tool_input["output_dir"])

    if not candidate_paths:
        return None

    mode = _active_tool_mode()
    for raw_path in candidate_paths:
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        resolved = _resolved_tool_path(raw_path.strip())
        if not _policy_path_allowed_python(resolved, mode):
            rel_project = os.path.relpath(resolved, _project_root()) if _is_relative_to(resolved, _project_root()) else str(resolved)
            return (
                f"Error: {name} blocked by project policy. "
                f"Path '{rel_project}' is outside allowed write roots for {mode} mode."
            )
    return None


def _project_agent_roots() -> list[Path]:
    project_root = Path.cwd()
    roots = []
    project_agent_dir = os.environ.get("BOTFERENCE_PROJECT_AGENT_DIR", "")
    if project_agent_dir:
        roots.append(Path(project_agent_dir))
    roots.append(project_root / ".claude" / "agents")
    return roots


def _framework_agent_root() -> Path:
    botference_home = Path(os.environ.get("BOTFERENCE_HOME", "."))
    return botference_home / ".claude" / "agents"


def _override_names() -> set[str]:
    raw = os.environ.get("BOTFERENCE_AGENT_OVERRIDES", "")
    return {name for name in raw.split(",") if name}


def _reserved_override_allowed(agent_name: str) -> bool:
    return agent_name in _override_names()


def resolve_agent_file(agent_name: str) -> Path | None:
    """Resolve an agent prompt file with project-local precedence.

    Reserved built-in names use the framework agent by default unless the
    project explicitly opts into overriding that name.
    """
    framework_path = _framework_agent_root() / f"{agent_name}.md"
    project_candidates = [
        root / f"{agent_name}.md"
        for root in _project_agent_roots()
    ]

    if agent_name in RESERVED_AGENT_NAMES and not _reserved_override_allowed(agent_name):
        return framework_path if framework_path.exists() else None

    for path in project_candidates:
        if path.exists():
            return path
    if framework_path.exists():
        return framework_path
    return None


def parse_tools_from_agent_file(agent_name: str):
    """Parse tool names from an agent's .md file ## Tools section.

    Returns a list of tool names if the agent file declares tools,
    or None if no ## Tools section is found (fall back to DEFAULT_TOOLS).

    Agent .md files list tools as backtick-quoted names:
        ## Tools
        - `web_search` — search the web
        - `check_language` — style check
    """
    agent_path = resolve_agent_file(agent_name)
    if agent_path is None:
        return None
    if not agent_path.exists():
        return None

    text = agent_path.read_text()

    # Find ## Tools section
    in_tools = False
    declared = []
    for line in text.splitlines():
        if re.match(r'^## Tools\b', line):
            in_tools = True
            continue
        if in_tools and re.match(r'^## ', line):
            break  # next section
        if in_tools:
            # Extract backtick-quoted tool names: `tool_name`
            matches = re.findall(r'`(\w[\w-]*)`', line)
            for m in matches:
                if m in ALL_TOOL_NAMES:
                    declared.append(m)

    if not declared:
        return None

    return declared


def get_tools_for_agent(agent_name: str) -> tuple[list[str], list[dict]]:
    """Return (tool_names, api_schemas) for an agent.

    Resolution order:
    1. Hardcoded AGENT_TOOLS registry (framework agents)
    2. Parsed from agent .md file ## Tools section (custom agents)
    3. DEFAULT_TOOLS (essentials only)

    Server-side tools (e.g. web_search) use their raw definition directly.
    Client-side tools use api_schema() to strip the handler function.
    """
    tool_names = None

    # Built-ins remain authoritative unless the project explicitly overrides
    # that reserved agent name.
    if agent_name in AGENT_TOOLS and not _reserved_override_allowed(agent_name):
        tool_names = AGENT_TOOLS.get(agent_name)

    # 2. Parse from agent .md file
    if tool_names is None:
        declared = parse_tools_from_agent_file(agent_name)
        if declared:
            tool_names = list(_ESSENTIALS) + declared
        else:
            tool_names = list(DEFAULT_TOOLS)

    schemas = []
    for t in tool_names:
        if t in SERVER_TOOLS:
            schemas.append(SERVER_TOOLS[t])
        elif t in TOOLS:
            schemas.append(api_schema(TOOLS[t]))
        # Skip unknown tools silently (may be documentation-only)
    return tool_names, schemas
