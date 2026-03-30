"""Figure compliance checks for raster and vector assets."""

import re
from pathlib import Path

from tools._helpers import collect_files, parse_pub_reqs


_FIGURE_DEFAULTS = {
    "min_dpi": 300,
    "max_width_px": 2400,
    "max_height_px": 3600,
    "max_file_size_mb": 10,
}


_FIGURE_PUB_REQ_PATTERNS = {
    "min_dpi": r"(?:min[_\s-]*)?dpi\s*[:=]\s*(\d+)",
    "max_width_px": r"max[_\s-]*width[_\s-]*(?:px|pixels?)?\s*[:=]\s*(\d+)",
    "max_height_px": r"max[_\s-]*height[_\s-]*(?:px|pixels?)?\s*[:=]\s*(\d+)",
    "max_file_size_mb": r"max[_\s-]*(?:file[_\s-]*)?size[_\s-]*(?:mb)?\s*[:=]\s*(\d+(?:\.\d+)?)",
}


def _figure_parse_pub_reqs(path: str) -> dict:
    """Parse specs/publication-requirements.md for figure thresholds."""
    return parse_pub_reqs(path, _FIGURE_PUB_REQ_PATTERNS, _FIGURE_DEFAULTS)


def check_raster(filepath: Path, reqs: dict) -> dict:
    """Check a raster image (PNG, TIFF, JPEG). PIL imported lazily."""
    from PIL import Image

    result = {"file": str(filepath), "format": filepath.suffix.upper().lstrip(".")}
    issues = []

    image = Image.open(filepath)
    width, height = image.size
    result["width_px"] = width
    result["height_px"] = height
    result["color_mode"] = image.mode
    result["file_size_mb"] = round(filepath.stat().st_size / (1024 * 1024), 2)

    dpi_info = image.info.get("dpi", (None, None))
    if dpi_info and dpi_info[0]:
        dpi = int(round(dpi_info[0]))
    else:
        dpi = None
    result["dpi"] = dpi

    if dpi is not None and dpi < reqs["min_dpi"]:
        issues.append(f"DPI {dpi} < minimum {reqs['min_dpi']}")
    elif dpi is None:
        issues.append(f"No DPI metadata found (expect >= {reqs['min_dpi']})")

    if width > reqs["max_width_px"]:
        issues.append(f"Width {width}px > maximum {reqs['max_width_px']}px")
    if height > reqs["max_height_px"]:
        issues.append(f"Height {height}px > maximum {reqs['max_height_px']}px")
    if result["file_size_mb"] > reqs["max_file_size_mb"]:
        issues.append(f"File size {result['file_size_mb']}MB > maximum {reqs['max_file_size_mb']}MB")

    result["issues"] = issues
    result["pass"] = len(issues) == 0
    return result


def check_pdf_figure(filepath: Path, reqs: dict) -> dict:
    """Check a PDF figure (vector format). fitz imported lazily."""
    try:
        import fitz
    except ImportError:
        return {
            "file": str(filepath),
            "format": "PDF",
            "issues": ["PyMuPDF not installed — cannot check PDF figures"],
            "pass": False,
        }

    result = {"file": str(filepath), "format": "PDF (vector)"}
    issues = []

    doc = fitz.open(str(filepath))
    result["pages"] = len(doc)
    result["file_size_mb"] = round(filepath.stat().st_size / (1024 * 1024), 2)

    if len(doc) > 0:
        page = doc[0]
        rect = page.rect
        result["width_pt"] = round(rect.width, 1)
        result["height_pt"] = round(rect.height, 1)
        result["width_in"] = round(rect.width / 72, 2)
        result["height_in"] = round(rect.height / 72, 2)

    if result["file_size_mb"] > reqs["max_file_size_mb"]:
        issues.append(f"File size {result['file_size_mb']}MB > maximum {reqs['max_file_size_mb']}MB")
    if len(doc) > 1:
        issues.append(f"PDF has {len(doc)} pages (expected single-page figure)")

    doc.close()
    result["issues"] = issues
    result["pass"] = len(issues) == 0
    return result


_FIGURE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tiff", ".tif", ".pdf"}


def _handle_check_figure(inp):
    """Run figure compliance checks directly (no subprocess)."""
    import json as _json

    reqs = dict(_FIGURE_DEFAULTS)
    if inp.get("pub_reqs") and Path(inp["pub_reqs"]).exists():
        reqs = _figure_parse_pub_reqs(inp["pub_reqs"])

    figures = collect_files([inp["figures_dir"]], _FIGURE_EXTENSIONS)
    if not figures:
        return "No figure files found."

    results = []
    for figure in figures:
        if figure.suffix.lower() == ".pdf":
            results.append(check_pdf_figure(figure, reqs))
        else:
            results.append(check_raster(figure, reqs))

    all_pass = all(result["pass"] for result in results)
    return _json.dumps({"results": results, "pass": all_pass}, indent=2)


TOOLS = {
    "check_figure": {
        "name": "check_figure",
        "description": (
            "Check figure files for publication readiness: DPI, pixel dimensions, "
            "color mode, file size, format. Returns PASS/FAIL per figure."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "figures_dir": {"type": "string", "description": "Path to figures directory (e.g. 'figures/')"},
                "pub_reqs": {"type": "string", "description": "Path to publication-requirements.md (optional)"},
            },
            "required": ["figures_dir"],
        },
        "function": _handle_check_figure,
    },
}
