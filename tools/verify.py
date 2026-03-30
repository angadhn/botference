"""verify_cited_claims — does the cited PDF actually support the claim?

Ledger-first: trusts deep-reader's existing verification; only extracts PDF
text for claims lacking ledger backing or with low confidence.
"""

import json
import os
import re
from pathlib import Path

from tools._helpers import parse_jsonl, format_truncated
from tools._citation import _build_doi_bib_index, manifest_check
from tools.pdf import extract_page_texts

# Stopwords for term scoring (common English words to ignore)
_STOPWORDS = frozenset(
    "a an the is are was were be been being have has had do does did "
    "will would shall should may might can could of in to for on with "
    "at by from as into through during before after above below between "
    "and or but not no nor so yet both either neither each every all "
    "any few more most other some such than too very also just about "
    "over only then them they their there these those this that it its "
    "he she we you his her our your".split()
)

# Number extraction regex
_NUM_RE = re.compile(r"\d+\.?\d*\s*%?")

# PDF text cache (keyed by absolute path)
_pdf_text_cache = {}


def _section_matches(section, filter_val):
    """Match section exactly or as dot-separated prefix."""
    return section == filter_val or section.startswith(filter_val + ".")


def _handle_verify_cited_claims(inp):
    tracker_file = inp["tracker_file"]
    ledger_file = inp["ledger_file"]
    bib_file = inp.get("bib_file", "")
    papers_dir = inp.get("papers_dir", "papers/")
    section_filter = inp.get("section_filter")
    output_dir = inp.get("output_dir")
    auto_download = inp.get("auto_download", False)

    # Parse tracker
    entries = parse_jsonl(tracker_file, on_error="skip")
    if not entries:
        return f"No tracker entries found at {tracker_file}"

    # Section filter
    if section_filter:
        entries = [e for e in entries if _section_matches(e.get("section", ""), section_filter)]
    if not entries:
        return f"No tracker entries match section_filter='{section_filter}'"

    # Build DOI→bib index
    if bib_file:
        try:
            doi_bib = _build_doi_bib_index(bib_file)
        except ImportError:
            return (f"ERROR: bibtexparser is not installed — cannot build DOI→source_key "
                    f"index from {bib_file}. Ledger lookups will fail silently without it. "
                    f"Run: pip install 'bibtexparser<2'")
        except FileNotFoundError as e:
            return f"ERROR: {e} — cannot build DOI→source_key index."
    else:
        doi_bib = {}

    # Parse ledger, index by source_key
    ledger_entries = parse_jsonl(ledger_file, on_error="skip")
    ledger_by_key = {}
    for le in ledger_entries:
        sk = le.get("source_key", "")
        if sk:
            ledger_by_key.setdefault(sk, []).append(le)

    # Process each tracker entry
    verdicts = []
    for entry in entries:
        doi = entry.get("doi", "")
        section = entry.get("section", "")
        claim = entry.get("claim", "")
        role = entry.get("role", "")

        # Resolve source_key from DOI→bib index
        bib_info = doi_bib.get(doi.lower().strip(), {})
        source_key = bib_info.get("source_key", "")

        verdict = {
            "doi": doi,
            "section": section,
            "claim": claim,
            "role": role,
            "source_key": source_key,
            "support_label": None,
            "support_source": None,
            "support_summary": "",
            "support_quote": None,
            "support_page": None,
            "score": None,
            "notes": "",
        }

        # Try ledger verdict
        ledger_match = _resolve_from_ledger(source_key, claim, ledger_by_key)
        if ledger_match:
            verdict.update(ledger_match)
            verdicts.append(verdict)
            continue

        # Fall through to PDF
        pdf_result = _resolve_from_pdf(source_key, doi, claim, papers_dir, auto_download)
        verdict.update(pdf_result)
        verdicts.append(verdict)

    # Write JSONL output
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        jsonl_path = os.path.join(output_dir, "verify_report.jsonl")
        with open(jsonl_path, "w", encoding="utf-8") as f:
            for v in verdicts:
                f.write(json.dumps(v) + "\n")

    # Build markdown report
    return _build_report(verdicts)


def _resolve_from_ledger(source_key, claim, ledger_by_key):
    """Apply ledger verdict rules. Returns dict update or None for fall-through."""
    if not source_key or source_key not in ledger_by_key:
        return None

    ledger_list = ledger_by_key[source_key]
    # Find best matching ledger entry (by claim substring overlap)
    best = None
    best_overlap = 0
    for le in ledger_list:
        le_claim = le.get("claim", "")
        claim_words = set(claim.lower().split())
        le_words = set(le_claim.lower().split())
        overlap = len(claim_words & le_words) / max(len(claim_words), 1)
        if overlap > best_overlap:
            best_overlap = overlap
            best = le

    if not best or best_overlap < 0.3:
        return None

    confidence = best.get("confidence", "").lower()
    extraction_type = best.get("extraction_type", "").lower()
    support_quote = best.get("support_quote")

    if confidence == "high" and extraction_type == "direct_quote" and support_quote:
        return {"support_label": "DIRECT_SUPPORT", "support_source": "ledger",
                "support_summary": f"Ledger: direct quote from {source_key}",
                "support_quote": support_quote,
                "support_page": best.get("source_section")}
    elif confidence == "high" and extraction_type == "direct_quote":
        return {"support_label": "LEDGER_DIRECT", "support_source": "ledger",
                "support_summary": f"Ledger: direct quote (no verbatim quote stored) from {source_key}",
                "support_page": best.get("source_section")}
    elif confidence == "high" and extraction_type == "paraphrase":
        return {"support_label": "PARTIAL_SUPPORT", "support_source": "ledger",
                "support_summary": f"Ledger: paraphrase from {source_key}",
                "support_page": best.get("source_section")}
    elif confidence == "medium":
        return {"support_label": "PARTIAL_SUPPORT", "support_source": "ledger",
                "support_summary": f"Ledger: medium confidence from {source_key}",
                "support_page": best.get("source_section")}
    return None


def _resolve_from_pdf(source_key, doi, claim, papers_dir, auto_download):
    """Resolve a claim from the PDF. Returns dict update."""
    # Find PDF file
    pdf_path = _find_pdf(source_key, doi, papers_dir)

    if not pdf_path:
        if auto_download:
            try:
                from tools.download import _handle_citation_download
                _handle_citation_download({"doi": doi, "papers_dir": papers_dir})
                pdf_path = _find_pdf(source_key, doi, papers_dir)
            except Exception:
                pass

    if not pdf_path:
        return {"support_label": "PDF_MISSING", "support_source": "pdf",
                "notes": f"No PDF found for {source_key or doi}"}

    # Extract text (with caching)
    abs_path = str(Path(pdf_path).resolve())
    if abs_path in _pdf_text_cache:
        text_result = _pdf_text_cache[abs_path]
    else:
        text_result = extract_page_texts(pdf_path)
        _pdf_text_cache[abs_path] = text_result

    if text_result["is_scanned"]:
        return {"support_label": "TEXT_UNAVAILABLE", "support_source": "pdf",
                "notes": "Scanned PDF — no extractable text"}

    if not text_result["pages"]:
        return {"support_label": "TEXT_UNAVAILABLE", "support_source": "pdf",
                "notes": "No text extracted from PDF"}

    # Score pages
    return _score_claim_against_pages(claim, text_result["pages"])


def _find_pdf(source_key, doi, papers_dir):
    """Find a PDF by source_key prefix or manifest lookup."""
    pdir = Path(papers_dir)
    if not pdir.exists():
        return None

    # Scan for files starting with source_key
    if source_key:
        for f in pdir.iterdir():
            if f.suffix.lower() == ".pdf" and f.name.startswith(source_key):
                return str(f)

    # Try manifest
    if doi:
        result = manifest_check(doi, str(pdir))
        if result.get("status") == "SKIP" and result.get("file"):
            candidate = pdir / result["file"]
            if candidate.exists():
                return str(candidate)

    return None


def _tokenize_claim(claim):
    """Tokenize claim: lowercase, remove stopwords, keep 3+ char tokens."""
    words = re.findall(r"[a-zA-Z0-9%]+", claim.lower())
    return [w for w in words if len(w) >= 3 and w not in _STOPWORDS]


def _extract_numbers(text):
    """Extract numeric values (with optional %) from text."""
    return set(_NUM_RE.findall(text))


def _score_claim_against_pages(claim, pages):
    """Score claim against all pages using term co-occurrence + number anchoring."""
    claim_tokens = _tokenize_claim(claim)
    if not claim_tokens:
        return {"support_label": "NO_SUPPORT", "support_source": "pdf",
                "score": 0, "notes": "No scorable terms in claim"}

    claim_numbers = _extract_numbers(claim)

    best_score = 0.0
    best_page = None
    best_text = ""
    best_numbers_match = False
    best_numbers_contradict = False

    for page_info in pages:
        page_text = page_info["text"]
        page_num = page_info["page"]
        text_lower = page_text.lower()

        # Term hits: fraction of claim tokens found in page
        hits = sum(1 for t in claim_tokens if t in text_lower)
        term_score = hits / len(claim_tokens)

        if term_score < 0.3:
            continue

        # Number anchoring
        page_numbers = _extract_numbers(page_text)
        numbers_match = bool(claim_numbers and claim_numbers & page_numbers)
        numbers_contradict = False

        if claim_numbers and not numbers_match and page_numbers:
            # Check if the page contains the same topic terms but different numbers
            # This indicates a potential contradiction
            claim_nums_clean = {n.strip().rstrip("%") for n in claim_numbers}
            page_nums_clean = {n.strip().rstrip("%") for n in page_numbers}
            if claim_nums_clean != page_nums_clean and term_score >= 0.4:
                # Page discusses same topic (high term overlap) but with different numbers
                numbers_contradict = True

        if term_score > best_score:
            best_score = term_score
            best_page = page_num
            best_text = page_text
            best_numbers_match = numbers_match
            best_numbers_contradict = numbers_contradict

    if best_page is None:
        return {"support_label": "NO_SUPPORT", "support_source": "pdf",
                "score": 0, "notes": "No page matched claim terms above threshold"}

    # Build support quote (first ~200 chars of best page)
    quote = best_text.strip()[:200]

    if best_numbers_contradict:
        return {"support_label": "CONTRADICTED", "support_source": "pdf",
                "support_page": best_page, "support_quote": quote,
                "score": round(best_score, 3),
                "notes": "Topic terms match but numbers differ"}

    if best_numbers_match and best_score >= 0.5:
        return {"support_label": "DIRECT_SUPPORT", "support_source": "pdf",
                "support_page": best_page, "support_quote": quote,
                "score": round(best_score, 3)}

    return {"support_label": "PARTIAL_SUPPORT", "support_source": "pdf",
            "support_page": best_page, "support_quote": quote,
            "score": round(best_score, 3)}


def _build_report(verdicts):
    """Build a markdown summary report."""
    lines = ["## verify_cited_claims report", ""]

    counts = {}
    for v in verdicts:
        label = v.get("support_label", "UNKNOWN")
        counts[label] = counts.get(label, 0) + 1

    lines.append(f"Total claims checked: {len(verdicts)}")
    for label in ["DIRECT_SUPPORT", "LEDGER_DIRECT", "PARTIAL_SUPPORT",
                   "NO_SUPPORT", "CONTRADICTED", "PDF_MISSING", "TEXT_UNAVAILABLE"]:
        if label in counts:
            lines.append(f"  {label}: {counts[label]}")
    lines.append("")

    issues = [v for v in verdicts if v["support_label"] in
              ("CONTRADICTED", "NO_SUPPORT", "PDF_MISSING", "TEXT_UNAVAILABLE")]
    if not issues:
        lines.append("**PASS** — all claims have ledger or PDF support.")
        return "\n".join(lines)

    lines.append(f"**{len(issues)} issue(s) found:**")
    lines.append("")

    for label in ["CONTRADICTED", "NO_SUPPORT", "PDF_MISSING", "TEXT_UNAVAILABLE"]:
        group = [v for v in issues if v["support_label"] == label]
        if group:
            lines.append(f"### {label} ({len(group)})")
            for v in group:
                lines.append(f"- [{v['source_key'] or v['doi']}] §{v['section']}: {v['claim'][:120]}")
                if v.get("notes"):
                    lines.append(f"  Note: {v['notes']}")
            lines.append("")

    return "\n".join(lines)


TOOLS = {
    "verify_cited_claims": {
        "name": "verify_cited_claims",
        "description": (
            "Verify whether cited papers actually support the claims made about them. "
            "Checks the evidence ledger first (trusting deep-reader verification), "
            "then falls back to PDF text extraction for uncovered or low-confidence claims. "
            "Produces a JSONL report and markdown summary."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tracker_file": {"type": "string", "description": "Path to cited_tracker.jsonl"},
                "ledger_file": {"type": "string", "description": "Path to evidence-ledger.jsonl"},
                "bib_file": {"type": "string", "description": "Path to .bib file for DOI→source_key mapping"},
                "papers_dir": {"type": "string", "description": "Directory containing PDF papers (default: papers/)"},
                "section_filter": {"type": "string", "description": "Filter to specific section prefix (e.g. '2' for §2.x)"},
                "output_dir": {"type": "string", "description": "Directory for JSONL report output"},
                "auto_download": {"type": "boolean", "description": "Auto-download missing PDFs (default: false)"},
            },
            "required": ["tracker_file", "ledger_file", "bib_file"],
        },
        "function": _handle_verify_cited_claims,
    },
}
