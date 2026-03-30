"""Download tools: citation_download.

Fetches PDFs by DOI from open-access sources (Unpaywall) with optional SciHub
fallback. Saves to papers/ and registers in the manifest via tools._citation.

Legal note: Unpaywall is always legal (indexes OA copies). SciHub is opt-in
only — set SCIHUB_MIRROR env var to enable. This file should be gitignored.
"""

import json
import os
import re
import time
import urllib.error
import urllib.request

from tools._citation import manifest_add
from tools._paths import scripts_dir as _scripts_dir


_UNPAYWALL_EMAIL = "botference-agent@example.com"  # Unpaywall requires an email
_DEFAULT_PAPERS_DIR = "papers"
_DOWNLOAD_TIMEOUT = 60


def _sanitize_filename(s: str) -> str:
    """Remove non-alphanumeric chars except spaces/hyphens, collapse."""
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"\s+", "_", s.strip())
    return s[:60]  # cap length


def _build_filename(author: str, year: str, title: str) -> str:
    """Build Author2024_ShortTitle.pdf filename."""
    author_part = _sanitize_filename(author.split(",")[0].split()[-1]) if author else "Unknown"
    year_part = str(year) if year else "XXXX"
    title_words = title.split()[:4] if title else ["Untitled"]
    title_part = _sanitize_filename(" ".join(title_words))
    return f"{author_part}{year_part}_{title_part}.pdf"


def _fetch_url(url: str, dest: str) -> bool:
    """Download a URL to dest. Returns True on success."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "botference-agent/1.0"})
        with urllib.request.urlopen(req, timeout=_DOWNLOAD_TIMEOUT) as resp:
            data = resp.read()
            if len(data) < 1000:
                return False  # too small to be a real PDF
            if not data[:5].startswith(b"%PDF"):
                return False  # not a PDF
            with open(dest, "wb") as f:
                f.write(data)
            return True
    except Exception:
        return False


def _try_unpaywall(doi: str) :
    """Query Unpaywall for an open-access PDF URL. Returns URL or None."""
    encoded_doi = urllib.request.quote(doi, safe="")
    url = f"https://api.unpaywall.org/v2/{encoded_doi}?email={_UNPAYWALL_EMAIL}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "botference-agent/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        # Try best_oa_location first
        best = data.get("best_oa_location")
        if best:
            pdf_url = best.get("url_for_pdf") or best.get("url")
            if pdf_url:
                return pdf_url
        # Try all oa_locations
        for loc in data.get("oa_locations", []):
            pdf_url = loc.get("url_for_pdf") or loc.get("url")
            if pdf_url:
                return pdf_url
    except Exception:
        pass
    return None


def _try_scihub(doi: str, mirror: str) :
    """Try SciHub mirror. Returns PDF URL or None."""
    url = f"{mirror.rstrip('/')}/{doi}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "botference-agent/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        # SciHub embeds PDF in an iframe or direct link
        # Pattern: src="//some.domain/path.pdf" or onclick="location.href='...pdf'"
        match = re.search(r'(?:src|href)\s*=\s*["\'](?:https?:)?(//[^"\']+\.pdf[^"\']*)', html)
        if match:
            pdf_url = match.group(1)
            if pdf_url.startswith("//"):
                pdf_url = "https:" + pdf_url
            return pdf_url
    except Exception:
        pass
    return None


def _register_manifest(doi: str, filename: str, papers_dir: str, title: str = "") -> str:
    """Register downloaded PDF in the manifest via tools._citation."""
    result = manifest_add(
        doi=doi,
        file=filename,
        scout="scout",
        title=title,
        papers_dir=papers_dir,
    )
    return result.get("message", json.dumps(result))


def _handle_citation_download(inp):
    doi = inp["doi"]
    papers_dir = inp.get("papers_dir", _DEFAULT_PAPERS_DIR)
    author = inp.get("author", "")
    title = inp.get("title", "")
    year = inp.get("year", "")

    os.makedirs(papers_dir, exist_ok=True)

    filename = _build_filename(author, year, title)
    dest = os.path.join(papers_dir, filename)

    # Already downloaded?
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return json.dumps({
            "status": "already_exists",
            "file": filename,
            "path": dest,
            "message": f"PDF already exists at {dest}"
        })

    sources_tried = []

    # 1. Unpaywall (legal, open-access)
    unpaywall_url = _try_unpaywall(doi)
    if unpaywall_url:
        sources_tried.append(f"unpaywall: {unpaywall_url}")
        if _fetch_url(unpaywall_url, dest):
            manifest_msg = _register_manifest(doi, filename, papers_dir, title)
            return json.dumps({
                "status": "downloaded",
                "source": "unpaywall",
                "file": filename,
                "path": dest,
                "size_bytes": os.path.getsize(dest),
                "manifest": manifest_msg,
            })

    # 2. SciHub (opt-in via env var)
    scihub_mirror = os.environ.get("SCIHUB_MIRROR", "")
    if scihub_mirror:
        pdf_url = _try_scihub(doi, scihub_mirror)
        if pdf_url:
            sources_tried.append(f"scihub: {pdf_url}")
            if _fetch_url(pdf_url, dest):
                manifest_msg = _register_manifest(doi, filename, papers_dir, title)
                return json.dumps({
                    "status": "downloaded",
                    "source": "scihub",
                    "file": filename,
                    "path": dest,
                    "size_bytes": os.path.getsize(dest),
                    "manifest": manifest_msg,
                })
        else:
            sources_tried.append("scihub: no PDF URL found in page")
    else:
        sources_tried.append("scihub: skipped (SCIHUB_MIRROR not set)")

    # Clean up partial downloads
    if os.path.exists(dest):
        os.remove(dest)

    return json.dumps({
        "status": "not_found",
        "doi": doi,
        "sources_tried": sources_tried,
        "message": "Could not download PDF from any source. Paper may not be open-access."
    })


TOOLS = {
    "citation_download": {
        "name": "citation_download",
        "description": (
            "Download a paper's PDF by DOI. Tries Unpaywall (open-access) first, "
            "then SciHub if SCIHUB_MIRROR env var is set. Saves to papers/ directory "
            "and registers in the manifest. Returns JSON with status, source, and path."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "doi": {
                    "type": "string",
                    "description": "DOI of the paper (e.g. '10.1016/j.jcp.2024.01.001')",
                },
                "author": {
                    "type": "string",
                    "description": "First author name (for filename, e.g. 'Smith, J.')",
                },
                "title": {
                    "type": "string",
                    "description": "Paper title (for filename and manifest)",
                },
                "year": {
                    "type": "string",
                    "description": "Publication year (for filename, e.g. '2024')",
                },
                "papers_dir": {
                    "type": "string",
                    "description": "Directory to save PDFs (default: 'papers/')",
                },
            },
            "required": ["doi"],
        },
        "function": _handle_citation_download,
    },
}
