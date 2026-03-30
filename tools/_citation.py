"""Shared citation verification functions.

Retrieval-first citation verification: queries Semantic Scholar -> CrossRef ->
OpenAlex -> NASA TRS to get VERIFIED metadata.  Never generates citation
metadata from memory — always from structured API data.

Internal module (no TOOLS dict).  Used by tools/checks.py and tools/download.py.

Dependencies: bibtexparser <2 (pip install 'bibtexparser<2') — only for lint/batch-verify.
All APIs used are free and require no authentication.
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

from tools._helpers import parse_jsonl

# ── Matching ─────────────────────────────────────────────────────


def _score_candidate(query_title: str, candidate_title: str,
                     query_authors: str = "", candidate_authors: str = "") -> dict:
    """Score a candidate match. Returns separate title and author scores."""
    title_sim = SequenceMatcher(None, query_title.lower(), candidate_title.lower()).ratio()
    author_sim = 0.0
    if query_authors and candidate_authors:
        author_sim = SequenceMatcher(None, query_authors.lower(), candidate_authors.lower()).ratio()
    blend = title_sim if not query_authors else 0.7 * title_sim + 0.3 * author_sim
    return {"title_similarity": round(title_sim, 3),
            "author_similarity": round(author_sim, 3),
            "blended": round(blend, 3)}


def _classify(title_sim: float, author_sim: float, has_authors: bool, doi_verified: bool) -> tuple:
    """Classify a match based on independent title AND author thresholds.
    Returns (status, warnings)."""
    warnings = []

    if doi_verified:
        if title_sim < 0.8:
            warnings.append(f"DOI verified but title similarity low ({title_sim:.2f}) — possible metadata variant")
        if has_authors and author_sim < 0.5:
            warnings.append(f"DOI verified but author mismatch ({author_sim:.2f}) — check author list")
        return ("VERIFIED", warnings)

    if title_sim >= 0.9 and (author_sim >= 0.7 or not has_authors):
        return ("VERIFIED", warnings)
    if title_sim >= 0.9 and has_authors and author_sim < 0.7:
        warnings.append(f"Title matches but authors differ ({author_sim:.2f}) — may be wrong paper or wrong author list")
        return ("SUSPICIOUS", warnings)
    if title_sim >= 0.8 and (author_sim >= 0.5 or not has_authors):
        return ("LIKELY", warnings)
    if title_sim >= 0.8 and has_authors and author_sim < 0.5:
        warnings.append(f"Title close but authors do not match ({author_sim:.2f})")
        return ("SUSPICIOUS", warnings)
    if title_sim >= 0.65:
        if has_authors and author_sim < 0.5:
            warnings.append(f"Weak title match ({title_sim:.2f}) AND author mismatch ({author_sim:.2f})")
        return ("SUSPICIOUS", warnings)

    return ("UNVERIFIED", warnings)


# ── API Clients ──────────────────────────────────────────────────


def _get_json(url: str, headers: dict = None, retries: int = 3):
    """Fetch JSON from a URL with exponential backoff. Returns None on failure."""
    req = urllib.request.Request(url, headers=headers or {})
    req.add_header("User-Agent", "citation-tools/1.0 (survey-paper)")
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited ({e.code}), retrying in {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            return None
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            return None
    return None


def _query_api(title, authors, url, extract_items, extract_title,
               extract_authors, build_result):
    """Generic API query with best-candidate scoring.

    Returns the best-matching result dict (with title/author similarity added)
    if title_similarity >= 0.65, else None.
    """
    data = _get_json(url)
    items = extract_items(data)
    if not items:
        return None
    best = None
    best_scores = None
    best_blend = 0.0
    for item in items:
        scores = _score_candidate(title, extract_title(item), authors, extract_authors(item))
        if scores["blended"] > best_blend:
            best_blend = scores["blended"]
            best_scores = scores
            best = item
    if best and best_scores and best_scores["title_similarity"] >= 0.65:
        result = build_result(best)
        result["title_similarity"] = best_scores["title_similarity"]
        result["author_similarity"] = best_scores["author_similarity"]
        return result
    return None


def query_semantic_scholar(title: str, authors: str = ""):
    """Search Semantic Scholar for a paper by title."""
    query = urllib.parse.quote(title)
    return _query_api(
        title, authors,
        url=f"https://api.semanticscholar.org/graph/v1/paper/search?query={query}&limit=5&fields=title,authors,year,externalIds,venue,citationCount",
        extract_items=lambda d: (d or {}).get("data"),
        extract_title=lambda p: p.get("title") or "",
        extract_authors=lambda p: ", ".join(a.get("name", "") for a in (p.get("authors") or [])),
        build_result=lambda p: {
            "source": "semantic_scholar",
            "title": p.get("title"),
            "authors": [a.get("name", "") for a in (p.get("authors") or [])],
            "year": p.get("year"),
            "doi": (p.get("externalIds") or {}).get("DOI"),
            "venue": p.get("venue"),
            "citation_count": p.get("citationCount"),
        },
    )


def query_crossref(title: str, authors: str = ""):
    """Search CrossRef for a paper by title."""
    query = urllib.parse.quote(title)
    return _query_api(
        title, authors,
        url=f"https://api.crossref.org/works?query.title={query}&rows=5&select=DOI,title,author,published-print,container-title,type,volume,page,issue",
        extract_items=lambda d: (d or {}).get("message", {}).get("items"),
        extract_title=lambda item: (item.get("title") or [""])[0],
        extract_authors=lambda item: ", ".join(
            f"{a.get('family', '')} {a.get('given', '')}".strip()
            for a in (item.get("author") or [])
        ),
        build_result=lambda item: {
            "source": "crossref",
            "title": (item.get("title") or [""])[0],
            "authors": [
                f"{a.get('given', '')} {a.get('family', '')}".strip()
                for a in (item.get("author") or [])
            ],
            "year": (item.get("published-print", {}).get("date-parts", [[None]])[0] or [None])[0],
            "doi": item.get("DOI"),
            "venue": (item.get("container-title") or [""])[0],
            "volume": item.get("volume"),
            "pages": item.get("page"),
            "issue": item.get("issue"),
        },
    )


def _build_openalex_result(work):
    doi_url = work.get("doi") or ""
    doi = doi_url.replace("https://doi.org/", "") if doi_url else None
    venue = ""
    loc = work.get("primary_location") or {}
    if loc.get("source"):
        venue = loc["source"].get("display_name", "")
    return {
        "source": "openalex",
        "title": work.get("title"),
        "authors": [
            a.get("author", {}).get("display_name", "")
            for a in (work.get("authorships") or [])
        ],
        "year": work.get("publication_year"),
        "doi": doi,
        "venue": venue,
        "citation_count": work.get("cited_by_count"),
    }


def query_openalex(title: str, authors: str = ""):
    """Search OpenAlex for a paper by title."""
    query = urllib.parse.quote(title)
    return _query_api(
        title, authors,
        url=f"https://api.openalex.org/works?search={query}&per_page=5&select=id,doi,title,authorships,publication_year,primary_location,cited_by_count",
        extract_items=lambda d: (d or {}).get("results"),
        extract_title=lambda w: w.get("title") or "",
        extract_authors=lambda w: ", ".join(
            (a.get("author", {}).get("display_name", ""))
            for a in (w.get("authorships") or [])
        ),
        build_result=_build_openalex_result,
    )


def query_ntrs(title: str, authors: str = ""):
    """Search NASA Technical Reports Server for a paper by title."""
    query = urllib.parse.quote(title)
    return _query_api(
        title, authors,
        url=f"https://ntrs.nasa.gov/api/citations?title={query}",
        extract_items=lambda d: (d or {}).get("results"),
        extract_title=lambda item: item.get("title", ""),
        extract_authors=lambda item: ", ".join(
            a.get("name", "").strip()
            for a in (item.get("authorAffiliations") or [])
        ),
        build_result=lambda item: {
            "source": "ntrs",
            "title": item.get("title", ""),
            "authors": [
                a.get("name", "")
                for a in (item.get("authorAffiliations") or [])
            ],
            "year": (
                item.get("publicationDate", "")[:4]
                if item.get("publicationDate")
                else None
            ),
            "doi": item.get("doi"),
            "venue": (
                item.get("subjectCategories", [None])[0]
                if item.get("subjectCategories")
                else None
            ),
            "ntrs_id": item.get("id"),
        },
    )


def verify_doi(doi: str):
    """Verify a DOI resolves via CrossRef and return metadata."""
    url = f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='')}"
    data = _get_json(url)
    if not data or not data.get("message"):
        return None
    item = data["message"]
    pub_date = item.get("published-print", item.get("published-online", {}))
    date_parts = pub_date.get("date-parts", [[None]]) if pub_date else [[None]]
    year = date_parts[0][0] if date_parts and date_parts[0] else None
    return {
        "source": "crossref_doi",
        "doi": item.get("DOI"),
        "title": (item.get("title") or [""])[0],
        "authors": [
            f"{a.get('given', '')} {a.get('family', '')}".strip()
            for a in (item.get("author") or [])
        ],
        "year": year,
        "venue": (item.get("container-title") or [""])[0],
        "volume": item.get("volume"),
        "pages": item.get("page"),
        "issue": item.get("issue"),
        "type": item.get("type"),
        "verified": True,
    }


# ── Lookup (cascading API search) ───────────────────────────────


def lookup_paper(title: str, authors: str = "") -> dict:
    """Try Semantic Scholar -> CrossRef -> OpenAlex -> NTRS. Return best result."""
    for fn, name in [
        (query_semantic_scholar, "semantic_scholar"),
        (query_crossref, "crossref"),
        (query_openalex, "openalex"),
        (query_ntrs, "ntrs"),
    ]:
        result = fn(title, authors)
        if result:
            doi_verified = False
            if result.get("doi"):
                doi_meta = verify_doi(result["doi"])
                if doi_meta and doi_meta.get("verified"):
                    doi_verified = True
                    result["title"] = doi_meta["title"] or result["title"]
                    result["authors"] = doi_meta["authors"] or result["authors"]
                    result["year"] = doi_meta.get("year") or result.get("year")
                    result["venue"] = doi_meta.get("venue") or result.get("venue")
                    result["doi_verified"] = True
                    doi_title = doi_meta["title"] or ""
                    doi_authors_str = ", ".join(doi_meta.get("authors") or [])
                    rescored = _score_candidate(title, doi_title, authors, doi_authors_str)
                    result["title_similarity"] = rescored["title_similarity"]
                    result["author_similarity"] = rescored["author_similarity"]

            has_authors = bool(authors)
            status, warnings = _classify(
                result.get("title_similarity", 0),
                result.get("author_similarity", 0),
                has_authors,
                doi_verified,
            )
            result["status"] = status
            result["verified"] = status == "VERIFIED"
            if warnings:
                result["warnings"] = warnings
            return result
        time.sleep(0.5)
    return {
        "source": "none",
        "title": title,
        "authors": authors.split(", ") if authors else [],
        "verified": False,
        "status": "UNVERIFIED",
        "title_similarity": 0.0,
        "author_similarity": 0.0,
        "note": "Not found in Semantic Scholar, CrossRef, OpenAlex, or NTRS",
    }


# ── Lint (BibTeX verification) ──────────────────────────────────


def _score_entry(bib_entry: dict, api_result: dict) -> dict:
    """Score a bib entry against API result."""
    bib_title = bib_entry.get("title", "").strip("{}").lower()
    api_title = (api_result.get("title") or "").lower()
    title_sim = SequenceMatcher(None, bib_title, api_title).ratio() if bib_title and api_title else 0.0

    bib_authors = bib_entry.get("author", "").lower()
    api_authors = ", ".join(api_result.get("authors") or []).lower()
    author_sim = SequenceMatcher(None, bib_authors, api_authors).ratio() if bib_authors and api_authors else 0.0
    has_authors = bool(bib_authors and api_authors)

    bib_year = bib_entry.get("year", "")
    api_year = str(api_result.get("year") or "")
    year_match = bool(bib_year and api_year and bib_year == api_year)

    bib_doi = bib_entry.get("doi", "").lower().strip()
    api_doi = (api_result.get("doi") or "").lower().strip()
    doi_match = bool(bib_doi and api_doi and bib_doi == api_doi)

    bib_volume = bib_entry.get("volume", "").strip()
    api_volume = str(api_result.get("volume") or "").strip()
    volume_match = bool(bib_volume and api_volume and bib_volume == api_volume)

    bib_pages = bib_entry.get("pages", "").strip().replace("--", "-")
    api_pages = (api_result.get("pages") or "").strip().replace("--", "-")
    pages_match = bool(bib_pages and api_pages and bib_pages == api_pages)

    status, warnings = _classify(title_sim, author_sim, has_authors, doi_match)

    if not year_match and bib_year and api_year:
        warnings.append(f"Year mismatch: bib={bib_year} vs API={api_year}")
        if status == "VERIFIED" and not doi_match:
            status = "LIKELY"

    if not volume_match and bib_volume and api_volume:
        warnings.append(f"Volume mismatch: bib={bib_volume} vs API={api_volume}")
        if status == "VERIFIED" and not doi_match:
            status = "LIKELY"

    if not pages_match and bib_pages and api_pages:
        warnings.append(f"Pages mismatch: bib={bib_pages} vs API={api_pages}")
        if status == "VERIFIED" and not doi_match:
            status = "LIKELY"

    return {
        "title_similarity": round(title_sim, 3),
        "author_similarity": round(author_sim, 3),
        "year_match": year_match,
        "volume_match": volume_match,
        "pages_match": pages_match,
        "doi_match": doi_match,
        "status": status,
        "warnings": warnings,
    }


def lint_bib_files(bib_dir: str, output_path: str) -> dict:
    """Parse .bib files, verify each entry, produce verification_report.md."""
    try:
        import bibtexparser
    except ImportError:
        return {"error": "bibtexparser not installed. Run: pip install 'bibtexparser<2'"}

    bib_path = Path(bib_dir)
    if not bib_path.exists():
        return {"error": f"Directory not found: {bib_dir}"}

    bib_files = list(bib_path.glob("*.bib"))
    if not bib_files:
        # Also check if bib_dir itself is a file
        if bib_path.is_file() and bib_path.suffix == ".bib":
            bib_files = [bib_path]
        else:
            return {"error": f"No .bib files found in {bib_dir}"}

    entries = []
    for bf in bib_files:
        with open(bf, "r", encoding="utf-8") as f:
            db = bibtexparser.load(f)
            for e in db.entries:
                e["_source_file"] = str(bf)
                entries.append(e)

    results = []
    counts = {"VERIFIED": 0, "LIKELY": 0, "SUSPICIOUS": 0, "UNVERIFIED": 0}

    for i, entry in enumerate(entries):
        title = entry.get("title", "").strip("{}")
        authors = entry.get("author", "")
        doi = entry.get("doi", "")
        key = entry.get("ID", f"entry_{i}")

        api_result = None
        if doi:
            api_result = verify_doi(doi)
            time.sleep(1.0)

        if not api_result or not api_result.get("verified"):
            api_result = lookup_paper(title, authors)
            time.sleep(1.0)

        if api_result and api_result.get("source") != "none":
            entry_score = _score_entry(entry, api_result)
        else:
            entry_score = {"title_similarity": 0.0, "author_similarity": 0.0,
                           "year_match": False, "doi_match": False,
                           "status": "UNVERIFIED", "warnings": ["No API match found"]}

        status = entry_score["status"]
        counts[status] = counts.get(status, 0) + 1

        results.append({
            "key": key,
            "title": title,
            "status": status,
            "title_similarity": entry_score["title_similarity"],
            "author_similarity": entry_score["author_similarity"],
            "year_match": entry_score["year_match"],
            "doi_match": entry_score["doi_match"],
            "warnings": entry_score.get("warnings", []),
            "api_source": api_result.get("source", "none") if api_result else "none",
            "api_title": api_result.get("title") if api_result else None,
            "api_authors": ", ".join(api_result.get("authors") or []) if api_result else None,
            "api_doi": api_result.get("doi") if api_result else None,
            "source_file": entry.get("_source_file"),
        })

        if (i + 1) % 10 == 0:
            print(f"  Verified {i + 1}/{len(entries)} entries...", file=sys.stderr)

    # Generate report
    total = len(entries)
    report_lines = [
        "# Citation Verification Report",
        "",
        f"**Total entries:** {total}",
        f"**Verified:** {counts['VERIFIED']} ({100*counts['VERIFIED']//max(total,1)}%)",
        f"**Likely:** {counts['LIKELY']} ({100*counts['LIKELY']//max(total,1)}%)",
        f"**Suspicious:** {counts['SUSPICIOUS']} ({100*counts['SUSPICIOUS']//max(total,1)}%)",
        f"**Unverified:** {counts['UNVERIFIED']} ({100*counts['UNVERIFIED']//max(total,1)}%)",
        "",
    ]

    flagged = [r for r in results if r["status"] in ("SUSPICIOUS", "UNVERIFIED")]
    if flagged:
        report_lines.append("## Flagged Entries")
        report_lines.append("")
        for r in flagged:
            report_lines.append(f"### [{r['status']}] {r['key']}")
            report_lines.append(f"- **Bib title:** {r['title']}")
            report_lines.append(f"- **API match:** {r['api_title'] or 'No match found'}")
            report_lines.append(f"- **API authors:** {r['api_authors'] or 'N/A'}")
            report_lines.append(f"- **API DOI:** {r['api_doi'] or 'N/A'}")
            report_lines.append(f"- **Title similarity:** {r['title_similarity']}")
            report_lines.append(f"- **Author similarity:** {r['author_similarity']}")
            if r["warnings"]:
                for w in r["warnings"]:
                    report_lines.append(f"- **Warning: {w}**")
            report_lines.append(f"- **Source file:** {r['source_file']}")
            report_lines.append("")

    report_lines.append("## All Entries")
    report_lines.append("")
    report_lines.append("| Key | Status | Title Sim | Author Sim | DOI Match | API Source |")
    report_lines.append("|-----|--------|-----------|------------|-----------|------------|")
    for r in results:
        doi_mark = "Y" if r["doi_match"] else "N"
        report_lines.append(
            f"| {r['key']} | {r['status']} | {r['title_similarity']} | {r['author_similarity']} | {doi_mark} | {r['api_source']} |"
        )

    report = "\n".join(report_lines)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)

    # Print summary
    print(f"\nCitation Lint Results:", file=sys.stderr)
    print(f"  VERIFIED:   {counts['VERIFIED']}/{total}", file=sys.stderr)
    print(f"  LIKELY:     {counts['LIKELY']}/{total}", file=sys.stderr)
    print(f"  SUSPICIOUS: {counts['SUSPICIOUS']}/{total}", file=sys.stderr)
    print(f"  UNVERIFIED: {counts['UNVERIFIED']}/{total}", file=sys.stderr)

    # Exit with error if any UNVERIFIED
    if counts["UNVERIFIED"] > 0:
        print(f"\nFAIL: {counts['UNVERIFIED']} unverified entries. See {output_path}", file=sys.stderr)

    return {
        "total": total,
        "verified": counts["VERIFIED"],
        "likely": counts["LIKELY"],
        "suspicious": counts["SUSPICIOUS"],
        "unverified": counts["UNVERIFIED"],
        "report_path": output_path,
        "pass": counts["UNVERIFIED"] == 0,
    }


# ── PDF Manifest ─────────────────────────────────────────────────


def _manifest_path(papers_dir: str) -> Path:
    return Path(papers_dir) / "manifest.jsonl"


def manifest_check(doi: str, papers_dir: str, title: str = "") -> dict:
    """Check if a paper (by DOI or title) is already in the manifest."""
    mpath = _manifest_path(papers_dir)
    if not mpath.exists():
        return {"status": "OK", "message": "Not yet downloaded (no manifest)"}
    doi_lower = doi.lower().strip() if doi else ""
    title_lower = title.lower().strip() if title else ""
    for entry in parse_jsonl(str(mpath), on_error="skip"):
        entry_doi = (entry.get("doi") or "").lower().strip()
        entry_title = (entry.get("title") or "").lower().strip()
        if doi_lower and entry_doi and doi_lower == entry_doi:
            return {"status": "SKIP", "message": f"Already downloaded as {entry.get('file')}", "file": entry.get("file")}
        if title_lower and entry_title and SequenceMatcher(None, title_lower, entry_title).ratio() >= 0.9:
            return {"status": "SKIP", "message": f"Already downloaded as {entry.get('file')} (title match)", "file": entry.get("file")}
    return {"status": "OK", "message": "Not yet downloaded"}


def manifest_add(doi: str, file: str, scout: str, title: str, papers_dir: str, ntrs_id: str = None) -> dict:
    """Append a new entry to the PDF manifest."""
    mpath = _manifest_path(papers_dir)
    mpath.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "doi": doi,
        "file": file,
        "scout": scout,
        "title": title,
    }
    if ntrs_id:
        entry["ntrs_id"] = ntrs_id
    with open(mpath, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    return {"status": "OK", "message": f"Added {file} to manifest"}


# ── DOI-to-bib bridge ───────────────────────────────────────────


def _build_doi_bib_index(bib_path: str) -> dict:
    """Build a DOI → {source_key, title} index from a .bib file.

    Raises ImportError if bibtexparser is not installed.
    Raises FileNotFoundError if the .bib file does not exist.
    """
    import bibtexparser
    bib_file = Path(bib_path)
    if not bib_file.exists():
        raise FileNotFoundError(f"BibTeX file not found: {bib_path}")
    with open(bib_file, "r", encoding="utf-8") as f:
        db = bibtexparser.load(f)
    result = {}
    for entry in db.entries:
        doi = entry.get("doi", "").strip()
        if doi:
            result[doi.lower().strip()] = {
                "source_key": entry.get("ID", ""),
                "title": entry.get("title", "").strip("{}"),
            }
    return result


# ── Cited tracker ────────────────────────────────────────────────


def cited_check(doi: str, tracker_path: str = "references/cited_tracker.jsonl") -> dict:
    """Check if a DOI already appears in cited_tracker.jsonl."""
    if not Path(tracker_path).exists():
        return {"status": "NOT_CITED", "note": f"Tracker file not found: {tracker_path}"}
    for entry in parse_jsonl(tracker_path, on_error="skip"):
        if entry.get("doi", "").lower() == doi.lower():
            result = {"status": "CITED"}
            if "section" in entry:
                result["section"] = entry["section"]
            if "role" in entry:
                result["role"] = entry["role"]
            return result
    return {"status": "NOT_CITED"}


# ── Batch DOI Verify ─────────────────────────────────────────────


def batch_verify_bib(bib_file: str) -> dict:
    """Verify every DOI in a .bib file via CrossRef. Returns summary dict."""
    try:
        import bibtexparser
    except ImportError:
        return {"error": "bibtexparser not installed. Run: pip install 'bibtexparser<2'"}

    bib_path = Path(bib_file)
    if not bib_path.exists():
        return {"error": f"File not found: {bib_file}"}

    with open(bib_path, "r", encoding="utf-8") as f:
        db = bibtexparser.load(f)

    entries = db.entries
    if not entries:
        return {"error": f"No entries found in {bib_file}"}

    verified = []
    failed = []
    no_doi = []

    for i, entry in enumerate(entries):
        key = entry.get("ID", f"entry_{i}")
        doi = entry.get("doi", "").strip()
        bib_title = entry.get("title", "").strip("{}")

        if not doi:
            no_doi.append({"key": key, "title": bib_title})
            continue

        result = verify_doi(doi)
        if result and result.get("verified"):
            # Check title similarity to catch DOI/entry mismatches
            api_title = result.get("title", "")
            sim = SequenceMatcher(None, bib_title.lower(), api_title.lower()).ratio()
            verified.append({
                "key": key,
                "doi": doi,
                "title_similarity": round(sim, 3),
                "api_title": api_title,
            })
            if sim < 0.7:
                verified[-1]["warning"] = "DOI resolves but title mismatch — possible wrong DOI"
        else:
            failed.append({"key": key, "doi": doi, "title": bib_title})

        # Rate-limit: 1 req/sec to be polite to CrossRef
        if i < len(entries) - 1:
            time.sleep(1.0)

        if (i + 1) % 10 == 0:
            print(f"  Verified {i + 1}/{len(entries)} entries...", file=sys.stderr)

    return {
        "total": len(entries),
        "verified": len(verified),
        "failed": len(failed),
        "no_doi": len(no_doi),
        "failed_entries": failed,
        "no_doi_entries": no_doi,
        "warnings": [v for v in verified if "warning" in v],
    }
