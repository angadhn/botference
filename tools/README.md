> [!NOTE]
> This README was AI-generated. I (Angadh) have not manually authored this nor checked it.

# tools/

Self-contained tool implementations for `botference_agent.py` and the MCP fallback
(`core/fallback_agent_mcp.py` exposes the same tools to `claude -p` for OAuth/Max plan users).
Each module contains both the tool schema definitions and their full handler logic —
no subprocess indirection. Per-agent tool registries defined in `__init__.py`.

Based on [ghuntley's agent architecture](https://ghuntley.com/agent) ([repo](https://github.com/ghuntley/how-to-build-a-coding-agent)): colocated tool definitions + handlers, registered per-agent.

| Module | Tools | Notes |
|--------|-------|-------|
| `core.py` | read_file, write_file, bash | |
| `search.py` | list_files, code_search | |
| `checks.py` | *(compatibility shim)* | Re-exports the split check/citation tool modules so existing imports keep working |
| `check_language.py` | check_language | LaTeX/Markdown prose checks |
| `check_journal.py` | check_journal | Word count, page estimate, bibliography field checks |
| `check_figure.py` | check_figure | Raster/vector figure compliance checks |
| `visual.py` | visual_check_html | Headless Chromium screenshots and deterministic HTML layout checks; Playwright is optional but required for actual rendering |
| `citations.py` | citation_lint, citation_lookup, citation_verify, citation_verify_all, citation_manifest | Citation handlers built on `_citation.py` |
| `claims.py` | check_claims | Cross-ref .tex + evidence-ledger + .bib |
| `paper_ledger.py` | validate_paper_ledger, render_paper_ledger_markdown, validate_support_requests | Research paper lifecycle and support-request checks |
| `pdf.py` | pdf_metadata, extract_figure | Inlined from scripts; fitz lazy-imported |
| `download.py` | citation_download | Unpaywall + SciHub fallback; uses `_citation.manifest_add` |
| `_citation.py` | *(internal)* | Shared citation functions (17 funcs from former `scripts/citation_tools.py`) |
| `_pricing.py` | *(internal)* | Shared pricing table for Anthropic + OpenAI models |
| `_helpers.py` | *(internal)* | Shared helper utilities |
| `_paths.py` | *(internal)* | `_scripts_dir()` path resolution |
| `redact.py` | *(utility)* | Secret redaction + preview truncation for logs |
| `fmt.py` | *(utility)* | Rich formatted output for botference_agent.py headless mode |
| `interact.py` | ask_choice, ask_question, scan_workspace | Interactive intake tools (unused — plan mode uses claude CLI) |
| `github.py` | gh | GitHub CLI wrapper for PRs, issues, releases |
| `cli.py` | *(dispatcher)* | CLI entry point — invoke any tool from Bash (`cli.py <tool> '<json>'`) |

`__init__.py` merges all modules into a single TOOLS dict, defines AGENT_TOOLS (per-agent tool assignments), and provides `execute_tool()` and `get_tools_for_agent()` for dispatch.
