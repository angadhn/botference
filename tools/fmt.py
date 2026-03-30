"""Formatting for botference_agent.py headless output.

Pure formatting utility — no TOOLS dict, so it won't affect the tool registry.
Uses Rich library for bordered panels and syntax highlighting when available,
falls back to plain ANSI codes otherwise.
"""

import os
import sys

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.syntax import Syntax
    from rich.text import Text
    from rich import box
    _HAS_RICH = True
except ImportError:
    _HAS_RICH = False

# ── Shared data ──────────────────────────────────────────────

# Tool → color mapping by category
_TOOL_COLORS = {
    # Mutations (green)
    "write_file": "green",
    "git_commit": "green",
    "git_push": "green",
    # Read/inspect (cyan)
    "read_file": "cyan",
    "list_files": "cyan",
    "code_search": "cyan",
    "pdf_metadata": "cyan",
    "view_pdf_page": "cyan",
    "extract_figure": "cyan",
    # Shell (yellow)
    "bash": "yellow",
    # Verification (magenta)
    "check_language": "magenta",
    "check_journal": "magenta",
    "check_figure": "magenta",
    "check_claims": "magenta",
    "citation_lint": "magenta",
    "citation_verify": "magenta",
    "citation_verify_all": "magenta",
    "citation_lookup": "magenta",
    "citation_manifest": "magenta",
    # Network/external (blue)
    "search_papers": "blue",
    "download_paper": "blue",
    "citation_download": "blue",
    "web_search": "blue",
    "gh": "blue",
}

# Primary argument key per tool (for concise display)
_PRIMARY_KEYS = {
    "read_file": "path",
    "write_file": "path",
    "bash": "command",
    "code_search": "pattern",
    "git_commit": "message",
    "git_push": "branch",
    "list_files": "path",
    "gh": "subcommand",
}

# File extensions → Syntax lexer names (Rich path only)
_LEXERS = {
    ".py": "python", ".md": "markdown", ".tex": "latex", ".sh": "bash",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".js": "javascript",
    ".ts": "typescript", ".toml": "toml", ".bib": "bibtex",
}


def _extract_primary(name: str, inp: dict) -> str:
    """Extract the most informative argument for display."""
    key = _PRIMARY_KEYS.get(name)
    if key and key in inp:
        val = str(inp[key])
        if name == "bash" and len(val) > 80:
            val = val[:77] + "..."
        return val
    for v in inp.values():
        if isinstance(v, str):
            return v[:80] + ("..." if len(str(v)) > 80 else "")
    return ""


# ── Rich implementation ─────────────────────────────────────

if _HAS_RICH:
    _stderr = Console(file=sys.stderr)

    def _tool_color(name: str) -> str:
        return _TOOL_COLORS.get(name, "dim")

    def fmt_banner(agent: str, provider: str, tools: list[str], model: str):
        body = (
            f"[bold]{agent}[/bold]\n"
            f"[dim]Provider:[/dim] {provider}\n"
            f"[dim]Model:[/dim] {model}\n"
            f"[dim]Tools:[/dim] {', '.join(tools)}"
        )
        _stderr.print(Panel(
            body,
            title="[bold blue]botference[/bold blue]",
            border_style="blue",
            box=box.ROUNDED,
        ))

    def fmt_tool_call(name: str, inp: dict):
        text = Text()
        text.append(f"  {name}", style=f"bold {_tool_color(name)}")
        primary = _extract_primary(name, inp)
        if primary:
            text.append(f"  {primary}", style="bold")
        _stderr.print(text)

    def fmt_tool_result(tool_name: str, preview: str):
        if not preview:
            _stderr.print(Text("  (empty result)", style="dim"))
            return
        lower = preview.lower()
        if lower.startswith("tool error:") or lower.startswith("error:"):
            _stderr.print(Panel(preview, border_style="red", title="Error", box=box.ROUNDED))
            return
        if "wrote" in lower and ("chars" in lower or "bytes" in lower):
            _stderr.print(Panel(preview, border_style="green", box=box.ROUNDED))
            return
        _stderr.print(Text(f"  {preview}", style="dim"))

    def fmt_code_result(code: str, filepath: str):
        ext = os.path.splitext(filepath)[1].lower()
        lexer = _LEXERS.get(ext)
        if not lexer:
            _stderr.print(Text(code, style="dim"))
            return
        _stderr.print(Syntax(code, lexer, line_numbers=True, theme="monokai"))

    def fmt_separator():
        _stderr.rule(style="dim")


# ── ANSI fallback ────────────────────────────────────────────

else:
    _COLOR = (
        hasattr(sys.stderr, "isatty")
        and sys.stderr.isatty()
        and os.environ.get("NO_COLOR") is None
    )

    _RESET = "\033[0m" if _COLOR else ""
    _BOLD = "\033[1m" if _COLOR else ""
    _DIM = "\033[2m" if _COLOR else ""

    _ANSI = {
        "green": "\033[32m" if _COLOR else "",
        "cyan": "\033[36m" if _COLOR else "",
        "yellow": "\033[33m" if _COLOR else "",
        "magenta": "\033[35m" if _COLOR else "",
        "blue": "\033[34m" if _COLOR else "",
        "red": "\033[31m" if _COLOR else "",
        "dim": "\033[2m" if _COLOR else "",
    }

    def _ansi(color_name: str) -> str:
        return _ANSI.get(color_name, _DIM)

    def _tool_color_ansi(name: str) -> str:
        return _ansi(_TOOL_COLORS.get(name, "dim"))

    def fmt_banner(agent: str, provider: str, tools: list[str], model: str):
        lines = [
            f"{_BOLD}Agent:{_RESET} {agent}",
            f"{_DIM}Provider:{_RESET} {provider}",
            f"{_DIM}Tools:{_RESET} {', '.join(tools)}",
            f"{_DIM}Model:{_RESET} {model}",
            "",
        ]
        print("\n".join(lines), file=sys.stderr)

    def fmt_tool_call(name: str, inp: dict):
        color = _tool_color_ansi(name)
        primary = _extract_primary(name, inp)
        if primary:
            print(f"  {color}{name}{_RESET}  {_BOLD}{primary}{_RESET}", file=sys.stderr)
        else:
            print(f"  {color}{name}{_RESET}", file=sys.stderr)

    def fmt_tool_result(tool_name: str, preview: str):
        if not preview:
            print(f"  {_DIM}(empty result){_RESET}", file=sys.stderr)
            return
        lower = preview.lower()
        if lower.startswith("tool error:") or lower.startswith("error:"):
            print(f"  {_ANSI['red']}{preview}{_RESET}", file=sys.stderr)
            return
        if "wrote" in lower and ("chars" in lower or "bytes" in lower):
            print(f"  {_ANSI['green']}{preview}{_RESET}", file=sys.stderr)
            return
        print(f"  {_DIM}{preview}{_RESET}", file=sys.stderr)

    def fmt_code_result(code: str, filepath: str):
        print(f"{_DIM}{code}{_RESET}", file=sys.stderr)

    def fmt_separator():
        width = min(os.get_terminal_size(fallback=(80, 24)).columns, 80)
        print(f"{_DIM}{'─' * width}{_RESET}", file=sys.stderr)
