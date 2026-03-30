"""PDF tools: pdf_metadata, extract_figure.

All implementation is inline — no subprocess calls.
"""

import base64
import io
import json
import math
import os
import re
import sys

from pathlib import Path

from tools._paths import scripts_dir as _scripts_dir


# ── Regex patterns for figure/table detection ────────────────────

_FIG_PATTERN = re.compile(
    r"(?:Fig(?:ure|\.)\s*\d+|FIGURE\s+\d+)", re.IGNORECASE
)
_TABLE_PATTERN = re.compile(
    r"(?:Table\s+\d+|TABLE\s+\d+)", re.IGNORECASE
)
_HEADING_PATTERNS = [
    re.compile(r"^\d+\.?\s+[A-Z][A-Za-z\s:,\-]+$", re.MULTILINE),      # "1. Introduction"
    re.compile(r"^[IVX]+\.\s+[A-Z][A-Za-z\s:,\-]+$", re.MULTILINE),    # "IV. Results"
    re.compile(r"^[A-Z][A-Z\s:,\-]{4,}$", re.MULTILINE),               # "INTRODUCTION"
]


def get_fast_metadata(pdf_path: str) -> dict:
    """Extract metadata from a PDF without reading full text.

    Returns dict with: page_count, has_toc, toc, figure_count, table_count,
    image_obj_count, image_density, is_scanned, file_size_mb, sections.
    """
    import fitz  # lazy import — PyMuPDF

    doc = fitz.open(pdf_path)
    page_count = len(doc)
    file_size_mb = round(Path(pdf_path).stat().st_size / (1024 * 1024), 2)

    # ToC extraction — works for ~40-60% of arXiv papers
    toc_raw = doc.get_toc()
    has_toc = len(toc_raw) > 0
    toc = []
    for level, title, page_num in toc_raw:
        toc.append({"level": level, "title": title, "page": page_num})

    # Count image objects and detect scanned PDFs
    total_images = 0
    total_text_len = 0
    fig_mentions = set()
    table_mentions = set()

    for page_num in range(page_count):
        page = doc[page_num]
        images = page.get_images(full=True)
        total_images += len(images)

        text = page.get_text("text")
        total_text_len += len(text)

        # Count unique figure/table references by regex
        for m in _FIG_PATTERN.finditer(text):
            num = re.search(r"\d+", m.group())
            if num:
                fig_mentions.add(int(num.group()))

        for m in _TABLE_PATTERN.finditer(text):
            num = re.search(r"\d+", m.group())
            if num:
                table_mentions.add(int(num.group()))

    figure_count = len(fig_mentions)
    table_count = len(table_mentions)
    image_density = round(total_images / max(page_count, 1), 2)

    # Heuristic: scanned PDF has images but very little text
    avg_text_per_page = total_text_len / max(page_count, 1)
    is_scanned = total_images > 0 and avg_text_per_page < 100

    # Section headings from ToC or heuristic
    sections = []
    if has_toc:
        sections = [{"title": t["title"], "page": t["page"]} for t in toc if t["level"] <= 2]
    else:
        sections = get_section_headings(pdf_path, doc=doc)

    doc.close()

    return {
        "file": str(Path(pdf_path).name),
        "page_count": page_count,
        "has_toc": has_toc,
        "toc": toc if has_toc else [],
        "figure_count": figure_count,
        "table_count": table_count,
        "image_obj_count": total_images,
        "image_density": image_density,
        "is_scanned": is_scanned,
        "file_size_mb": file_size_mb,
        "sections": sections,
        "estimated_chunks": estimate_reading_chunks(page_count, image_density),
    }



def extract_page_texts(pdf_path: str, pages: list = None) -> dict:
    """Extract text from PDF pages. Returns {pages: [{page, text}], is_scanned}."""
    import fitz

    doc = fitz.open(pdf_path)
    page_count = len(doc)

    # Detect scanned PDF (same heuristic as get_fast_metadata)
    total_images = 0
    total_text_len = 0
    for p in range(page_count):
        total_images += len(doc[p].get_images(full=True))
        total_text_len += len(doc[p].get_text("text"))
    avg_text_per_page = total_text_len / max(page_count, 1)
    is_scanned = total_images > 0 and avg_text_per_page < 100

    if is_scanned:
        doc.close()
        return {"pages": [], "is_scanned": True}

    if pages is None:
        page_indices = range(page_count)
    else:
        page_indices = [i for i in pages if 0 <= i < page_count]

    result_pages = []
    for i in page_indices:
        result_pages.append({
            "page": i + 1,
            "text": doc[i].get_text("text"),
        })

    doc.close()
    return {"pages": result_pages, "is_scanned": False}


def get_section_headings(pdf_path: str, doc=None) -> list:
    """Detect section headings from first 3 pages when ToC is absent.

    Uses regex heuristics — not an LLM call. Returns list of
    {"title": str, "page": int} dicts.
    """
    import fitz  # lazy import — PyMuPDF

    close_doc = False
    if doc is None:
        doc = fitz.open(pdf_path)
        close_doc = True

    headings = []
    pages_to_scan = min(3, len(doc))

    for page_num in range(pages_to_scan):
        text = doc[page_num].get_text("text")
        for pattern in _HEADING_PATTERNS:
            for m in pattern.finditer(text):
                candidate = m.group().strip()
                if len(candidate) < 4 or candidate.isdigit():
                    continue
                if "\n" in candidate:
                    continue
                if len(candidate) > 80:
                    continue
                if candidate.upper() in ("ABSTRACT", "KEYWORDS", "REFERENCES"):
                    continue
                headings.append({"title": candidate, "page": page_num + 1})

    if close_doc:
        doc.close()

    # Deduplicate by title
    seen = set()
    unique = []
    for h in headings:
        key = h["title"].lower().strip()
        if key not in seen:
            seen.add(key)
            unique.append(h)

    return unique


def estimate_reading_chunks(pages: int, image_density: float) -> int:
    """Estimate number of 5-page reading chunks, adjusted for image density."""
    base = math.ceil(pages / 5)
    if image_density > 2.0:
        return math.ceil(base * 1.2)
    return base


def parse_page_range(page_str: str, total_pages: int) -> list:
    """Parse page range string like '1-5' or '3' or '1,3,5' into 0-indexed page numbers."""
    pages = []
    for part in page_str.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            start = max(1, int(start))
            end = min(total_pages, int(end))
            pages.extend(range(start - 1, end))
        else:
            page_num = int(part) - 1
            if 0 <= page_num < total_pages:
                pages.append(page_num)
    return sorted(set(pages))


def list_images(pdf_path: str) -> str:
    """List all images in a PDF without extracting. Returns report text."""
    import fitz  # lazy import — PyMuPDF

    buf = io.StringIO()
    doc = fitz.open(pdf_path)
    buf.write(f"\nImages in: {pdf_path}\n")
    buf.write(f"Total pages: {len(doc)}\n")
    buf.write(f"{'='*60}\n")

    total_images = 0
    for page_num in range(len(doc)):
        page = doc[page_num]
        images = page.get_images(full=True)
        if images:
            buf.write(f"\nPage {page_num + 1}: {len(images)} image(s)\n")
            for i, img in enumerate(images):
                xref = img[0]
                base_image = doc.extract_image(xref)
                buf.write(f"  [{i+1}] {base_image['width']}x{base_image['height']} "
                          f"({base_image['ext']}, {len(base_image['image'])//1024}KB)\n")
            total_images += len(images)

    buf.write(f"\n{'='*60}\n")
    buf.write(f"Total: {total_images} images across {len(doc)} pages\n")
    doc.close()
    return buf.getvalue()


def extract_images(pdf_path: str, output_dir: str, pages: list = None,
                   min_width: int = 100, min_height: int = 100) -> str:
    """Extract images from a PDF to the output directory. Returns report text."""
    import fitz  # lazy import — PyMuPDF

    buf = io.StringIO()
    doc = fitz.open(pdf_path)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    pdf_stem = Path(pdf_path).stem
    prefix = pdf_stem.replace(" ", "_")[:40]

    if pages is None:
        pages = list(range(len(doc)))

    extracted = 0
    skipped = 0

    for page_num in pages:
        if page_num >= len(doc):
            buf.write(f"  Warning: Page {page_num + 1} doesn't exist (PDF has {len(doc)} pages)\n")
            continue

        page = doc[page_num]
        images = page.get_images(full=True)

        for i, img in enumerate(images):
            xref = img[0]
            base_image = doc.extract_image(xref)
            width = base_image["width"]
            height = base_image["height"]

            if width < min_width or height < min_height:
                skipped += 1
                continue

            ext = base_image["ext"]
            image_bytes = base_image["image"]

            filename = f"{prefix}_p{page_num+1}_img{i+1}.{ext}"
            filepath = output_path / filename

            with open(filepath, "wb") as f:
                f.write(image_bytes)

            buf.write(f"  Extracted: {filename} ({width}x{height}, {len(image_bytes)//1024}KB)\n")
            extracted += 1

    doc.close()
    buf.write(f"\nDone: {extracted} images extracted, {skipped} small images skipped\n")
    buf.write(f"Output: {output_path}\n")
    return buf.getvalue()


def extract_page_as_image(pdf_path: str, page_num: int, output_path: str, dpi: int = 200) -> str:
    """Render a full PDF page as a high-res image. Returns report text."""
    import fitz  # lazy import — PyMuPDF

    doc = fitz.open(pdf_path)
    if page_num < 1 or page_num > len(doc):
        doc.close()
        return f"Error: Page {page_num} doesn't exist (PDF has {len(doc)} pages)"

    page = doc[page_num - 1]
    zoom = dpi / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    pix.save(str(output))
    result = f"  Rendered page {page_num} at {dpi}dpi: {output} ({pix.width}x{pix.height})"
    doc.close()
    return result


def _handle_view_pdf_page(inp):
    """Render a PDF page as an image and return as content blocks."""
    import fitz

    pdf_path = inp["pdf_path"]
    page = inp["page"]
    doc = fitz.open(pdf_path)
    if page < 1 or page > len(doc):
        doc.close()
        return f"Error: Page {page} doesn't exist (PDF has {len(doc)} pages)"

    # Render at 150 DPI, cap longest side at 1600px
    dpi = 150
    zoom = dpi / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = doc[page - 1].get_pixmap(matrix=mat)

    if max(pix.width, pix.height) > 1600:
        scale = 1600 / max(pix.width, pix.height)
        mat = fitz.Matrix(zoom * scale, zoom * scale)
        pix = doc[page - 1].get_pixmap(matrix=mat)

    png_bytes = pix.tobytes("png")
    doc.close()
    b64 = base64.b64encode(png_bytes).decode("ascii")

    return [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
        {"type": "text", "text": f"Page {page} of {Path(pdf_path).name} ({pix.width}x{pix.height}, {len(png_bytes)//1024}KB)"},
    ]


def _handle_pdf_metadata(inp):
    meta = get_fast_metadata(inp["pdf_path"])
    return json.dumps(meta, indent=2)


def _handle_extract_figure(inp):
    pdf_path = inp["pdf_path"]
    if inp.get("list_only"):
        return list_images(pdf_path)
    elif inp.get("render_page"):
        import fitz  # lazy import — PyMuPDF
        output_dir = inp.get("output_dir", "figures/")
        dpi = inp.get("dpi", 200)
        pdf_stem = Path(pdf_path).stem.replace(" ", "_")[:40]
        output_file = str(Path(output_dir) / f"{pdf_stem}_p{inp['render_page']}.png")
        return extract_page_as_image(pdf_path, inp["render_page"], output_file, dpi)
    else:
        pages = None
        if inp.get("pages"):
            import fitz  # lazy import — PyMuPDF
            doc = fitz.open(pdf_path)
            total = len(doc)
            doc.close()
            pages = parse_page_range(inp["pages"], total)
        return extract_images(pdf_path, inp.get("output_dir", "figures/"), pages)


TOOLS = {
    "pdf_metadata": {
        "name": "pdf_metadata",
        "description": (
            "Extract metadata from a PDF: page count, table of contents, figure/table counts, "
            "section headings, image density, scanned-PDF detection, and estimated reading chunks. "
            "Returns JSON. Use before reading a paper to plan reading budget."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pdf_path": {"type": "string", "description": "Path to the PDF file"},
            },
            "required": ["pdf_path"],
        },
        "function": _handle_pdf_metadata,
    },
    "extract_figure": {
        "name": "extract_figure",
        "description": (
            "Extract figures from a PDF file. Can list images without extracting, "
            "extract embedded images from specific pages, or render a full page as a high-res PNG."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pdf_path": {"type": "string", "description": "Path to the PDF file"},
                "output_dir": {"type": "string", "description": "Output directory for extracted images (default: 'figures/')"},
                "pages": {"type": "string", "description": "Page range to extract from (e.g. '1-5', '3', '1,3,5')"},
                "list_only": {"type": "boolean", "description": "List images without extracting (default false)"},
                "render_page": {"type": "integer", "description": "Render a specific page number as a full PNG image"},
                "dpi": {"type": "integer", "description": "DPI for page rendering (default: 200)"},
            },
            "required": ["pdf_path"],
        },
        "function": _handle_extract_figure,
    },
    "view_pdf_page": {
        "name": "view_pdf_page",
        "description": (
            "Render a PDF page as a PNG image and return it as visual content. "
            "Use this to inspect figures, equations, layouts, and other visual elements. "
            "Returns an image content block that Claude can see directly. "
            "Cost: ~3,400 tokens per page — use for targeted inspection, not bulk reading."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pdf_path": {"type": "string", "description": "Path to the PDF file"},
                "page": {"type": "integer", "description": "Page number to render (1-indexed)"},
            },
            "required": ["pdf_path", "page"],
        },
        "function": _handle_view_pdf_page,
    },
}
