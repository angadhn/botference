"""Tool registry for botference_agent.py.

Collects tool definitions from submodules and provides per-agent registries.
Adding a tool = adding it to the right submodule's TOOLS dict + AGENT_TOOLS here.
"""

import os
import re
from pathlib import Path

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
    "paper-writer": _ESSENTIALS + ["check_language", "citation_lint", "compile_latex"],
    "critic": _ESSENTIALS + ["check_language", "check_journal", "check_figure", "check_claims", "citation_verify_all", "verify_cited_claims", "build_cited_tracker_from_tex"],
    "scout": _ESSENTIALS + ["web_search", "pdf_metadata", "citation_lookup", "citation_verify", "citation_verify_all", "citation_manifest", "citation_download"],
    "deep-reader": _ESSENTIALS + ["pdf_metadata", "extract_figure", "view_pdf_page"],
    "research-coder": _ESSENTIALS,
    "figure-stylist": _ESSENTIALS + ["check_figure", "view_pdf_page"],
    "editor": _ESSENTIALS + ["check_claims", "check_language", "citation_lint", "citation_verify_all", "verify_cited_claims", "build_cited_tracker_from_tex"],
    "coherence-reviewer": _ESSENTIALS + ["check_claims", "check_language"],
    "provocateur": _ESSENTIALS + [],
    "synthesizer": _ESSENTIALS + ["citation_lint", "citation_verify_all"],
    "triage": _ESSENTIALS + ["pdf_metadata", "citation_verify_all"],
    "coder": _ESSENTIALS + ["gh"],
    # plan mode uses claude CLI (not botference_agent.py) — no tool registry needed
}

DEFAULT_TOOLS = _ESSENTIALS

# All known tool names (for validating agent file declarations)
ALL_TOOL_NAMES = set(TOOLS.keys()) | set(SERVER_TOOLS.keys())


# ── Tool dispatch ─────────────────────────────────────────────

def api_schema(tool: dict) -> dict:
    """Strip function from tool def for the API payload."""
    return {k: v for k, v in tool.items() if k != "function"}


def execute_tool(name: str, tool_input: dict):
    """Dispatch a tool call to its colocated handler."""
    tool = TOOLS.get(name)
    if not tool:
        return f"Unknown tool: {name}"
    return tool["function"](tool_input)


def parse_tools_from_agent_file(agent_name: str):
    """Parse tool names from an agent's .md file ## Tools section.

    Returns a list of tool names if the agent file declares tools,
    or None if no ## Tools section is found (fall back to DEFAULT_TOOLS).

    Agent .md files list tools as backtick-quoted names:
        ## Tools
        - `web_search` — search the web
        - `check_language` — style check
    """
    # Resolve agent file: workspace-first, then BOTFERENCE_HOME
    botference_home = Path(os.environ.get("BOTFERENCE_HOME", "."))
    workspace_path = Path.cwd() / ".claude" / "agents" / f"{agent_name}.md"
    framework_path = botference_home / ".claude" / "agents" / f"{agent_name}.md"

    agent_path = workspace_path if workspace_path.exists() else framework_path
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
    # 1. Check hardcoded registry
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
