"""LaTeX tools: compile_latex and build_cited_tracker_from_tex."""

import json
import os
import re
import subprocess
from pathlib import Path

from tools._helpers import parse_jsonl
from tools.check_language import extract_body, strip_latex_commands

_CITE_RE = re.compile(r"\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]+)\}")
_SECTION_CMD_RE = re.compile(r"\\(?:sub)*section\*?\{[^}]*\}")
_FIGUREISH_ENV_RE = re.compile(
    r"\\begin\{(figure|table|equation|align|tabular|longtable)\*?\}.*?\\end\{\1\*?\}",
    re.DOTALL,
)
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n{2,}")
_NUMERIC_PREFIX_RE = re.compile(r"^0*([0-9]+)")


def _strip_latex_comments(text: str) -> str:
    """Remove unescaped LaTeX comments while preserving line breaks."""
    cleaned = []
    for line in text.splitlines():
        cleaned.append(re.sub(r"(?<!\\)%.*$", "", line))
    return "\n".join(cleaned)


def _load_bib_key_index(bib_file: str) -> dict[str, dict]:
    """Build a BibTeX key -> metadata index with DOI values."""
    try:
        import bibtexparser
    except ImportError as exc:
        raise ImportError("bibtexparser is required to build cited tracker rows") from exc

    bib_path = Path(bib_file)
    if not bib_path.exists():
        raise FileNotFoundError(f"BibTeX file not found: {bib_file}")

    with open(bib_path, "r", encoding="utf-8") as handle:
        db = bibtexparser.load(handle)

    result = {}
    for entry in db.entries:
        key = entry.get("ID", "").strip()
        if not key:
            continue
        result[key] = {
            "doi": entry.get("doi", "").strip(),
            "title": entry.get("title", "").strip("{}"),
        }
    return result


def _derive_section_id(tex_file: str, section_override: str = "") -> str:
    """Derive tracker section id from override, numeric prefix, or filename stem."""
    if section_override:
        return section_override
    stem = Path(tex_file).stem
    match = _NUMERIC_PREFIX_RE.match(stem)
    if match:
        return match.group(1)
    return stem


def _normalize_claim_text(text: str) -> str:
    """Remove citation markup and normalize a claim sentence for tracker output."""
    text = _CITE_RE.sub("", text)
    text = strip_latex_commands(text)
    text = text.replace("~", " ")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return text.strip(" -\n\t")


def _extract_claim_chunks(tex_file: str) -> list[tuple[str, list[str]]]:
    """Return citation-bearing sentence chunks as (claim_text, cite_keys)."""
    raw = Path(tex_file).read_text(encoding="utf-8")
    body = extract_body(_strip_latex_comments(raw))
    body = _FIGUREISH_ENV_RE.sub("\n\n", body)
    body = _SECTION_CMD_RE.sub("\n\n", body)
    body = body.replace("~", " ")

    chunks = []
    for candidate in _SENTENCE_SPLIT_RE.split(body):
        if not _CITE_RE.search(candidate):
            continue
        keys = []
        for match in _CITE_RE.finditer(candidate):
            keys.extend([key.strip() for key in match.group(1).split(",") if key.strip()])
        claim = _normalize_claim_text(candidate)
        if claim and keys:
            chunks.append((claim, keys))
    return chunks


def _handle_build_cited_tracker_from_tex(inp: dict) -> dict:
    """Extract citation-bearing claim rows from a .tex file into cited_tracker.jsonl."""
    tex_file = inp["tex_file"]
    bib_file = inp["bib_file"]
    output_file = inp.get("output_file", "references/cited_tracker.jsonl")
    section_override = inp.get("section_override", "")
    replace_section = inp.get("replace_section", True)

    tex_path = Path(tex_file)
    if not tex_path.exists():
        return {"success": False, "output_file": output_file, "error": f"TeX file not found: {tex_file}"}

    try:
        bib_index = _load_bib_key_index(bib_file)
    except (ImportError, FileNotFoundError) as exc:
        return {"success": False, "output_file": output_file, "error": str(exc)}

    section_id = _derive_section_id(tex_file, section_override)
    extracted = _extract_claim_chunks(tex_file)

    skipped_missing_bib = set()
    skipped_missing_doi = set()
    rows = []
    seen = set()

    for claim, keys in extracted:
        for key in keys:
            bib_entry = bib_index.get(key)
            if not bib_entry:
                skipped_missing_bib.add(key)
                continue
            doi = bib_entry.get("doi", "").strip()
            if not doi:
                skipped_missing_doi.add(key)
                continue
            dedupe_key = (doi.lower(), section_id, claim)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            rows.append({
                "doi": doi,
                "section": section_id,
                "role": "support",
                "claim": claim,
            })

    out_path = Path(output_file)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    existing = parse_jsonl(str(out_path), on_error="skip") if out_path.exists() else []
    if replace_section:
        existing = [entry for entry in existing if entry.get("section") != section_id]

    merged = existing + rows
    with open(out_path, "w", encoding="utf-8") as handle:
        for entry in merged:
            handle.write(json.dumps(entry) + "\n")

    return {
        "success": True,
        "output_file": str(out_path),
        "section": section_id,
        "rows_written": len(rows),
        "tracker_size": len(merged),
        "skipped_missing_bib_keys": sorted(skipped_missing_bib),
        "skipped_missing_doi_keys": sorted(skipped_missing_doi),
    }


def _handle_compile_latex(inp: dict) -> dict:
    """Run pdflatex + bibtex + pdflatex x2, return success/errors."""
    tex_file = inp.get("file", "main.tex")

    if not os.path.isfile(tex_file):
        return {"success": False, "pdf_path": None, "errors": [f"File not found: {tex_file}"], "warnings": []}

    if not tex_file.endswith(".tex"):
        return {"success": False, "pdf_path": None, "errors": [f"Not a .tex file: {tex_file}"], "warnings": []}

    basename = os.path.splitext(tex_file)[0]
    pdf_path = f"{basename}.pdf"
    timeout = 60

    errors = []
    warnings = []

    steps = [
        ["pdflatex", "-interaction=nonstopmode", tex_file],
        ["bibtex", basename],
        ["pdflatex", "-interaction=nonstopmode", tex_file],
        ["pdflatex", "-interaction=nonstopmode", tex_file],
    ]

    for cmd in steps:
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            output = result.stdout + result.stderr

            # Parse LaTeX error lines (start with "! ")
            for line in output.splitlines():
                stripped = line.strip()
                if stripped.startswith("! "):
                    errors.append(stripped)
                elif "Warning:" in stripped:
                    warnings.append(stripped)

            # bibtex returns non-zero for warnings too; only treat as fatal
            # if pdflatex fails (bibtex warnings are captured above)
            if result.returncode != 0 and cmd[0] == "pdflatex":
                break

        except subprocess.TimeoutExpired:
            errors.append(f"Timeout ({timeout}s) running: {' '.join(cmd)}")
            break
        except FileNotFoundError:
            errors.append(f"Command not found: {cmd[0]}. Is TeX Live / MiKTeX installed?")
            break

    # Deduplicate
    errors = list(dict.fromkeys(errors))
    warnings = list(dict.fromkeys(warnings))

    success = os.path.isfile(pdf_path) and len(errors) == 0
    return {
        "success": success,
        "pdf_path": pdf_path if os.path.isfile(pdf_path) else None,
        "errors": errors,
        "warnings": warnings[:20],  # cap warnings to avoid flooding
    }


TOOLS = {
    "compile_latex": {
        "name": "compile_latex",
        "description": "Compile a LaTeX document (pdflatex + bibtex + pdflatex x2). Returns success status, PDF path, errors, and warnings.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": "Path to the .tex file to compile (default: main.tex)",
                },
            },
        },
        "function": _handle_compile_latex,
    },
    "build_cited_tracker_from_tex": {
        "name": "build_cited_tracker_from_tex",
        "description": (
            "Extract citation-bearing claim sentences from a .tex file and write "
            "references/cited_tracker.jsonl rows using DOI data from a .bib file."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tex_file": {
                    "type": "string",
                    "description": "Path to the .tex file to scan for cited claims",
                },
                "bib_file": {
                    "type": "string",
                    "description": "Path to the .bib file used to resolve cite keys to DOI",
                },
                "output_file": {
                    "type": "string",
                    "description": "Tracker output path (default: references/cited_tracker.jsonl)",
                },
                "section_override": {
                    "type": "string",
                    "description": "Optional explicit section id to use instead of filename-derived section",
                },
                "replace_section": {
                    "type": "boolean",
                    "description": "Replace existing tracker rows for the derived section (default: true)",
                },
            },
            "required": ["tex_file", "bib_file"],
        },
        "function": _handle_build_cited_tracker_from_tex,
    },
}
