"""Check tools: check_claims.

Cross-references a .tex file and its .bib against the evidence ledger,
flagging unsupported claims, low-confidence inferences, and stale entries.
"""

import re
from pathlib import Path

from tools._helpers import format_truncated, parse_jsonl


def _extract_bib_keys(bib_path: str) -> set[str]:
    """Extract all @type{key, entries from a .bib file."""
    keys = set()
    try:
        with open(bib_path) as f:
            for match in re.finditer(r"@\w+\{(\w[\w:-]*)", f.read()):
                keys.add(match.group(1))
    except FileNotFoundError:
        pass
    return keys


def _extract_cite_keys(tex_path: str) -> set[str]:
    r"""Extract all citation keys from \cite{...}, \citep{...}, \citet{...} etc."""
    keys = set()
    try:
        with open(tex_path) as f:
            text = f.read()
        for match in re.finditer(r"\\cite[tp]?\{([^}]+)\}", text):
            for key in match.group(1).split(","):
                keys.add(key.strip())
    except FileNotFoundError:
        pass
    return keys


def _handle_check_claims(inp):
    tex_file = inp["tex_file"]
    ledger_file = inp["ledger_file"]
    bib_file = inp.get("bib_file", "")

    # Parse inputs
    entries = parse_jsonl(ledger_file, on_error="record")
    if not entries:
        return f"No evidence ledger found at {ledger_file} (or it is empty). Cannot check claims."

    bib_keys = _extract_bib_keys(bib_file) if bib_file else set()
    cite_keys = _extract_cite_keys(tex_file)

    # Collect all source keys referenced in the ledger
    ledger_source_keys = {e["source_key"] for e in entries if "source_key" in e}

    # ── Flag 1: Low-confidence inferences ────────────────────────
    low_conf = [
        e for e in entries
        if e.get("extraction_type") == "inference" and e.get("confidence") == "low"
    ]

    # ── Flag 2: Stale entries (source_key not in bib) ────────────
    stale = []
    if bib_keys:
        stale = [
            e for e in entries
            if "source_key" in e and e["source_key"] not in bib_keys
        ]

    # ── Flag 3: Cited sources with no ledger backing ─────────────
    # Keys cited in .tex but absent from the ledger
    uncovered_cites = sorted(cite_keys - ledger_source_keys) if cite_keys else []

    # ── Flag 4: Parse errors ─────────────────────────────────────
    errors = [e["_error"] for e in entries if "_error" in e]

    # ── Build report ─────────────────────────────────────────────
    lines = ["## check_claims report", ""]
    lines.append(f"Ledger entries: {len(entries)}")
    lines.append(f"Bib keys: {len(bib_keys)}")
    lines.append(f"Cited keys in .tex: {len(cite_keys)}")
    lines.append(f"Ledger source keys: {len(ledger_source_keys)}")
    lines.append("")

    # Summary counts
    n_issues = len(low_conf) + len(stale) + len(uncovered_cites) + len(errors)
    if n_issues == 0:
        lines.append("**PASS** — no issues found.")
        return "\n".join(lines)

    lines.append(f"**{n_issues} issue(s) found:**")
    lines.append("")

    if low_conf:
        lines.append(f"### Low-confidence inferences ({len(low_conf)})")
        lines.append("These need stronger sourcing or hedging language:")
        lines.extend(format_truncated(
            low_conf, 20,
            lambda e: f"- [{e.get('source_key', '?')}] {e.get('claim', '?')[:120]}",
        ))
        lines.append("")

    if stale:
        lines.append(f"### Stale entries ({len(stale)})")
        lines.append("Source key not found in .bib — source was removed but claim remains:")
        lines.extend(format_truncated(
            stale, 20,
            lambda e: f"- [{e.get('source_key', '?')}] {e.get('claim', '?')[:120]}",
        ))
        lines.append("")

    if uncovered_cites:
        lines.append(f"### Cited keys with no ledger entry ({len(uncovered_cites)})")
        lines.append("These sources are cited in the manuscript but have no evidence-ledger entries:")
        lines.extend(format_truncated(uncovered_cites, 30, lambda k: f"- {k}"))
        lines.append("")

    if errors:
        lines.append(f"### Ledger parse errors ({len(errors)})")
        for err in errors:
            lines.append(f"- {err}")
        lines.append("")

    return "\n".join(lines)


TOOLS = {
    "check_claims": {
        "name": "check_claims",
        "description": (
            "Cross-reference a .tex manuscript against its evidence ledger (JSONL) and .bib file. "
            "Flags: (1) low-confidence inferences needing stronger sourcing or hedging, "
            "(2) stale entries whose source_key is missing from the .bib, "
            "(3) cited sources with no evidence-ledger backing. "
            "Returns a structured report with issues or PASS."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tex_file": {
                    "type": "string",
                    "description": "Path to the .tex manuscript file",
                },
                "ledger_file": {
                    "type": "string",
                    "description": "Path to the evidence-ledger.jsonl file",
                },
                "bib_file": {
                    "type": "string",
                    "description": "Path to the .bib bibliography file (optional; enables stale-entry detection)",
                },
            },
            "required": ["tex_file", "ledger_file"],
        },
        "function": _handle_check_claims,
    },
}
