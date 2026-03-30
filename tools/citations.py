"""Citation lookup, verification, and manifest handlers."""

import os
from pathlib import Path

from tools._helpers import format_truncated


def _handle_citation_lint(inp):
    """Run citation lint directly (no subprocess)."""
    from tools._citation import lint_bib_files

    report_path = os.path.join(inp["bib_dir"], "citation_verification_report.md")
    lint_bib_files(inp["bib_dir"], report_path)

    summary_lines = []
    counts = {"VERIFIED": 0, "LIKELY": 0, "SUSPICIOUS": 0, "UNVERIFIED": 0}
    flagged = []
    try:
        with open(report_path) as handle:
            for line in handle:
                line_s = line.strip()
                for status in counts:
                    if status in line_s:
                        counts[status] += line_s.count(status)
                if "SUSPICIOUS" in line_s or "UNVERIFIED" in line_s:
                    flagged.append(line_s)
    except FileNotFoundError:
        return "(citation_lint produced no report file)"

    summary_lines.append("Citation lint summary:")
    for status, count in counts.items():
        summary_lines.append(f"  {status}: {count}")
    if flagged:
        summary_lines.append("")
        summary_lines.append("Flagged entries:")
        summary_lines.extend(format_truncated(flagged, 20, lambda e: f"  {e}"))
    summary_lines.append(f"\nFull report: {report_path}")
    return "\n".join(summary_lines)


def _handle_citation_lookup(inp):
    """Look up papers directly (no subprocess)."""
    import json as _json
    from tools._citation import lookup_paper

    if inp.get("input_file"):
        output_file = inp.get("output_file", "corpus/batch_results.jsonl")
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        titles = Path(inp["input_file"]).read_text(encoding="utf-8").strip().splitlines()
        found = 0
        with open(output_file, "w", encoding="utf-8") as out:
            for title in titles:
                title = title.strip()
                if not title:
                    continue
                result = lookup_paper(title)
                if result:
                    found += 1
                    out.write(_json.dumps(result) + "\n")
        return f"Batch lookup: {found}/{len(titles)} titles found. Results: {output_file}"

    result = lookup_paper(inp["title"], inp.get("authors", ""))
    if result:
        return _json.dumps(result, indent=2)
    return "(no results found)"


def _handle_citation_verify(inp):
    """Verify a DOI directly (no subprocess)."""
    import json as _json
    from tools._citation import verify_doi

    result = verify_doi(inp["doi"])
    if result:
        return _json.dumps(result, indent=2)
    return f"(DOI {inp['doi']} could not be verified)"


def _handle_citation_verify_all(inp):
    """Batch-verify .bib file directly (no subprocess)."""
    from tools._citation import batch_verify_bib

    data = batch_verify_bib(inp["bib_file"])
    if "error" in data:
        return f"Error: {data['error']}"

    lines = ["## citation_verify_all report", ""]
    lines.append(f"Total entries: {data.get('total', '?')}")
    lines.append(f"DOI verified: {data.get('verified', '?')}")
    lines.append(f"DOI failed: {data.get('failed', '?')}")
    lines.append(f"No DOI: {data.get('no_doi', '?')}")
    lines.append("")

    issue_count = data.get("failed", 0) + data.get("no_doi", 0) + len(data.get("warnings", []))
    if issue_count == 0:
        lines.append("**PASS** — all DOIs verified successfully.")
        return "\n".join(lines)

    lines.append(f"**{issue_count} issue(s) found:**")
    lines.append("")

    failed = data.get("failed_entries", [])
    if failed:
        lines.append(f"### Failed DOI verification ({len(failed)})")
        lines.extend(format_truncated(
            failed, 20,
            lambda e: f"- [{e.get('key', '?')}] doi:{e.get('doi', '?')} — {e.get('title', '?')[:100]}",
        ))
        lines.append("")

    no_doi = data.get("no_doi_entries", [])
    if no_doi:
        lines.append(f"### Entries without DOI ({len(no_doi)})")
        lines.extend(format_truncated(
            no_doi, 20,
            lambda e: f"- [{e.get('key', '?')}] {e.get('title', '?')[:100]}",
        ))
        lines.append("")

    warnings = data.get("warnings", [])
    if warnings:
        lines.append(f"### DOI/title mismatches ({len(warnings)})")
        lines.extend(format_truncated(
            warnings, 20,
            lambda e: f"- [{e.get('key', '?')}] doi:{e.get('doi', '?')} — {e.get('warning', '?')}",
        ))
        lines.append("")

    return "\n".join(lines)


def _handle_citation_manifest(inp):
    """Check or update paper manifest directly (no subprocess)."""
    import json as _json
    from tools._citation import manifest_add, manifest_check

    if inp.get("file"):
        result = manifest_add(
            doi=inp.get("doi", ""),
            file=inp["file"],
            scout=inp.get("scout", ""),
            title=inp.get("title", ""),
            papers_dir=inp.get("papers_dir", "papers/"),
            ntrs_id=inp.get("ntrs_id"),
        )
        return _json.dumps(result, indent=2)

    result = manifest_check(
        doi=inp.get("doi", ""),
        papers_dir=inp.get("papers_dir", "papers/"),
        title=inp.get("title", ""),
    )
    return _json.dumps(result, indent=2)


TOOLS = {
    "citation_lint": {
        "name": "citation_lint",
        "description": (
            "Lint .bib files against Semantic Scholar/CrossRef/OpenAlex to verify "
            "citation metadata. Returns verification report with unverified entries."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "bib_dir": {"type": "string", "description": "Path to bib directory (e.g. 'references/')"},
            },
            "required": ["bib_dir"],
        },
        "function": _handle_citation_lint,
    },
    "citation_lookup": {
        "name": "citation_lookup",
        "description": (
            "Look up papers by title via Semantic Scholar/CrossRef/OpenAlex. "
            "Single mode: provide title (and optional authors) to find one paper. "
            "Batch mode: provide input_file (one title per line) to look up many papers at once."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Paper title to look up (single mode)"},
                "authors": {"type": "string", "description": "Author names, comma-separated (optional, improves matching)"},
                "input_file": {"type": "string", "description": "Path to file with one title per line (batch mode)"},
                "output_file": {"type": "string", "description": "Output JSONL path for batch results (default: corpus/batch_results.jsonl)"},
            },
            "required": [],
        },
        "function": _handle_citation_lookup,
    },
    "citation_verify": {
        "name": "citation_verify",
        "description": (
            "Verify a DOI against Semantic Scholar/CrossRef/OpenAlex. "
            "Returns verified metadata (title, authors, year, venue) with match confidence."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "doi": {"type": "string", "description": "DOI to verify (e.g. '10.1016/j.jcp.2024.01.001')"},
            },
            "required": ["doi"],
        },
        "function": _handle_citation_verify,
    },
    "citation_verify_all": {
        "name": "citation_verify_all",
        "description": (
            "Batch-verify every entry in a .bib file by resolving DOIs via CrossRef. "
            "Reports: verified DOIs, failed DOIs, entries without DOI, and DOI/title mismatches. "
            "Use this after bibliography updates to ensure all citations resolve."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "bib_file": {"type": "string", "description": "Path to the .bib file to verify"},
            },
            "required": ["bib_file"],
        },
        "function": _handle_citation_verify_all,
    },
    "citation_manifest": {
        "name": "citation_manifest",
        "description": (
            "Check or update the paper download manifest. "
            "Check mode (no 'file'): see if a paper is already downloaded by DOI or title. "
            "Add mode (with 'file'): register a newly downloaded PDF in the manifest."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "doi": {"type": "string", "description": "DOI of the paper"},
                "title": {"type": "string", "description": "Paper title (for fuzzy matching in check mode)"},
                "file": {"type": "string", "description": "PDF filename to add (triggers add mode, e.g. 'Author2024_Title.pdf')"},
                "scout": {"type": "string", "description": "Which agent downloaded it (add mode)"},
                "papers_dir": {"type": "string", "description": "Papers directory (default: 'papers/')"},
                "ntrs_id": {"type": "string", "description": "NTRS ID if applicable (add mode)"},
            },
            "required": [],
        },
        "function": _handle_citation_manifest,
    },
}
