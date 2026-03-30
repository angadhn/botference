"""Journal compliance checks for manuscript sections and bibliography files."""

import re
from pathlib import Path

from tools._helpers import collect_files, parse_pub_reqs
from tools.check_language import extract_body, strip_latex_commands


_JOURNAL_DEFAULTS = {
    "word_limit": 6000,
    "page_limit": 10,
    "words_per_page": 250,
    "required_bib_fields": ["author", "title", "year"],
}


_JOURNAL_PUB_REQ_PATTERNS = {
    "word_limit": r"word[_\s-]*limit\s*[:=]\s*(\d+)",
    "page_limit": r"page[_\s-]*limit\s*[:=]\s*(\d+)",
    "words_per_page": r"words[_\s-]*per[_\s-]*page\s*[:=]\s*(\d+)",
}


def _journal_post_process(reqs, text):
    reqs["required_bib_fields"] = list(_JOURNAL_DEFAULTS["required_bib_fields"])
    if re.search(r"double[_\s-]*column", text, re.IGNORECASE):
        reqs["words_per_page"] = 500


def _journal_parse_pub_reqs(path: str) -> dict:
    """Parse specs/publication-requirements.md for compliance thresholds."""
    return parse_pub_reqs(path, _JOURNAL_PUB_REQ_PATTERNS, _JOURNAL_DEFAULTS, _journal_post_process)


def count_words_tex(filepath: Path) -> tuple:
    """Count words in a .tex file after stripping LaTeX. Returns (word_count, section_name)."""
    content = filepath.read_text(encoding="utf-8")
    body = extract_body(content)
    stripped = strip_latex_commands(body)
    stripped = re.sub(r"\\cite\{[^}]*\}", "", stripped)
    words = stripped.split()
    return len(words), filepath.stem


def check_bib_fields(bib_path: Path, required_fields: list) -> list:
    """Check that each .bib entry has required fields."""
    issues = []
    content = bib_path.read_text(encoding="utf-8")
    entries = re.split(r"(?=@\w+\{)", content)
    for entry in entries:
        entry = entry.strip()
        if not entry or not entry.startswith("@"):
            continue

        entry_type_match = re.match(r"@(\w+)\{([^,]*)", entry)
        if not entry_type_match:
            continue

        entry_type = entry_type_match.group(1).lower()
        cite_key = entry_type_match.group(2).strip()
        if entry_type in ("comment", "preamble", "string"):
            continue

        entry_lower = entry.lower()
        missing = []
        for field in required_fields:
            if not re.search(rf"\b{field}\s*=", entry_lower):
                missing.append(field)
        if missing:
            issues.append({"cite_key": cite_key, "file": str(bib_path), "missing_fields": missing})
    return issues


def collect_bib_files(paths: list) -> list:
    """Find .bib files in references/ or alongside .tex files."""
    bib_files = []
    checked = set()
    for path_str in paths:
        path = Path(path_str)
        search_dir = path if path.is_dir() else path.parent
        if search_dir not in checked:
            checked.add(search_dir)
            bib_files.extend(sorted(search_dir.glob("*.bib")))

    ref_dir = Path("references")
    if ref_dir.exists() and ref_dir not in checked:
        bib_files.extend(sorted(ref_dir.glob("*.bib")))
    return bib_files


def _handle_check_journal(inp):
    """Run journal compliance checks directly (no subprocess)."""
    reqs = dict(_JOURNAL_DEFAULTS)
    reqs["required_bib_fields"] = list(_JOURNAL_DEFAULTS["required_bib_fields"])
    if inp.get("pub_reqs") and Path(inp["pub_reqs"]).exists():
        reqs = _journal_parse_pub_reqs(inp["pub_reqs"])

    tex_files = collect_files([inp["sections_dir"]], {".tex"})
    if not tex_files:
        return "No .tex files found."

    section_counts = []
    total_words = 0
    for tex_file in tex_files:
        word_count, name = count_words_tex(tex_file)
        section_counts.append({"file": str(tex_file), "section": name, "word_count": word_count})
        total_words += word_count

    page_estimate = round(total_words / reqs["words_per_page"], 1)

    bib_files = collect_bib_files([inp["sections_dir"]])
    bib_issues = []
    for bib_file in bib_files:
        bib_issues.extend(check_bib_fields(bib_file, reqs["required_bib_fields"]))

    issues = []
    if total_words > reqs["word_limit"]:
        issues.append(
            f"Total word count {total_words} exceeds limit of {reqs['word_limit']} "
            f"(over by {total_words - reqs['word_limit']})"
        )
    if page_estimate > reqs["page_limit"]:
        issues.append(f"Estimated {page_estimate} pages exceeds limit of {reqs['page_limit']}")
    if bib_issues:
        issues.append(f"{len(bib_issues)} bibliography entries missing required fields")

    all_pass = len(issues) == 0

    lines = [f"\n{'='*50}", "Journal Compliance Check", f"{'='*50}", "\nWord Counts by Section:"]
    for section_count in section_counts:
        lines.append(f"  {section_count['section']}: {section_count['word_count']} words")

    total_line = f"\n  Total: {total_words} / {reqs['word_limit']} words"
    if total_words > reqs["word_limit"]:
        total_line += f"  [OVER by {total_words - reqs['word_limit']}]"
    else:
        total_line += f"  [OK — {reqs['word_limit'] - total_words} remaining]"
    lines.append(total_line)

    page_line = (
        f"\nPage Estimate: {page_estimate} / {reqs['page_limit']} pages "
        f"({reqs['words_per_page']} words/page)"
    )
    if page_estimate > reqs["page_limit"]:
        page_line += "  [OVER]"
    else:
        page_line += "  [OK]"
    lines.append(page_line)

    if bib_issues:
        lines.append("\nBibliography Issues:")
        for bib_issue in bib_issues:
            lines.append(
                f"  {bib_issue['cite_key']} ({bib_issue['file']}): "
                f"missing {', '.join(bib_issue['missing_fields'])}"
            )
    elif bib_files:
        lines.append(f"\nBibliography: {len(bib_files)} file(s) checked, all entries OK")
    else:
        lines.append("\nBibliography: No .bib files found")

    lines.append(f"\n{'='*50}")
    lines.append("PASS" if all_pass else "FAIL")
    return "\n".join(lines)


TOOLS = {
    "check_journal": {
        "name": "check_journal",
        "description": (
            "Check manuscript sections against publication requirements: "
            "word count per section, total word count vs limit, page estimate, "
            "required .bib fields. Returns PASS/FAIL with details."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sections_dir": {"type": "string", "description": "Path to sections directory (e.g. 'sections/')"},
                "pub_reqs": {"type": "string", "description": "Path to publication-requirements.md (optional)"},
            },
            "required": ["sections_dir"],
        },
        "function": _handle_check_journal,
    },
}
