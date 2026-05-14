"""Deterministic browser-based visual checks for generated HTML artifacts."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any


_DEFAULT_VIEWPORTS = [
    {"name": "desktop", "width": 1440, "height": 900},
    {"name": "tablet", "width": 900, "height": 1200},
    {"name": "mobile", "width": 390, "height": 844},
]


_CHECK_SCRIPT = r"""
() => {
  const issueLimit = 80;
  const issues = [];
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const root = document.documentElement;
  const body = document.body;

  function textOf(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function selectorFor(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let part = current.tagName.toLowerCase();
      if (current.classList && current.classList.length) {
        part += "." + Array.from(current.classList).slice(0, 2).join(".");
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
      if (parts.length >= 5) break;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  function addIssue(kind, severity, el, details) {
    if (issues.length >= issueLimit) return;
    const rect = el ? el.getBoundingClientRect() : null;
    issues.push({
      kind,
      severity,
      selector: el ? selectorFor(el) : "document",
      text: el ? textOf(el).slice(0, 140) : "",
      rect: rect ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      } : null,
      details,
    });
  }

  if (root.scrollWidth > viewport.width + 2) {
    issues.push({
      kind: "page-horizontal-overflow",
      severity: "error",
      selector: "document",
      text: "",
      rect: null,
      details: `document scrollWidth ${root.scrollWidth}px exceeds viewport ${viewport.width}px`,
    });
  }

  const all = Array.from(document.querySelectorAll("body *"));
  const visible = all.filter((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0.01 &&
      rect.width > 1 &&
      rect.height > 1
    );
  });

  for (const el of visible) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.left < -2 || rect.right > viewport.width + 2) {
      addIssue(
        "element-horizontal-overflow",
        "error",
        el,
        `left=${Math.round(rect.left)}, right=${Math.round(rect.right)}, viewport=${viewport.width}`,
      );
    }
    const clipsX = /hidden|clip/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2;
    const clipsY = /hidden|clip/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2;
    if (clipsX || clipsY) {
      addIssue(
        clipsX ? "text-or-content-clipped-x" : "text-or-content-clipped-y",
        "error",
        el,
        `scroll=${el.scrollWidth}x${el.scrollHeight}, client=${el.clientWidth}x${el.clientHeight}, overflow=${style.overflowX}/${style.overflowY}`,
      );
    }
  }

  const textNodes = visible.filter((el) => {
    const text = textOf(el);
    if (!text) return false;
    if (el.matches("script, style, noscript")) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width > viewport.width * 0.95 && rect.height > viewport.height * 0.45) return false;
    const childText = Array.from(el.children).some((child) => textOf(child));
    return !childText || el.matches("svg text, svg tspan");
  }).slice(0, 450);

  for (let i = 0; i < textNodes.length; i += 1) {
    const a = textNodes[i];
    const ar = a.getBoundingClientRect();
    if (ar.bottom < 0 || ar.top > viewport.height) continue;
    for (let j = i + 1; j < textNodes.length; j += 1) {
      const b = textNodes[j];
      if (a.contains(b) || b.contains(a)) continue;
      const br = b.getBoundingClientRect();
      if (br.bottom < 0 || br.top > viewport.height) continue;
      const xOverlap = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
      const yOverlap = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
      if (xOverlap <= 3 || yOverlap <= 3) continue;
      const overlapArea = xOverlap * yOverlap;
      const minArea = Math.min(ar.width * ar.height, br.width * br.height);
      if (minArea > 0 && overlapArea / minArea > 0.18) {
        addIssue(
          "text-overlap",
          "error",
          a,
          `overlaps ${selectorFor(b)}; ${JSON.stringify(textOf(a).slice(0, 60))} vs ${JSON.stringify(textOf(b).slice(0, 60))}`,
        );
      }
    }
  }

  return {
    viewport,
    title: document.title,
    bodyTextLength: textOf(body).length,
    page: {
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
    },
    issues,
  };
}
"""


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return slug[:80] or "visual-check"


def _default_output_dir(html_file: Path) -> Path:
    work_dir = Path(os.environ.get("BOTFERENCE_WORK_DIR", os.getcwd())).resolve()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return work_dir / "visual-checks" / f"{_safe_slug(html_file.stem)}-{stamp}"


def _normalize_viewports(raw: Any) -> list[dict[str, int | str]]:
    if not raw:
        return list(_DEFAULT_VIEWPORTS)
    viewports = []
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        width = int(item.get("width", 0))
        height = int(item.get("height", 0))
        if width <= 0 or height <= 0:
            continue
        name = _safe_slug(str(item.get("name") or f"{width}x{height}" or idx))
        viewports.append({"name": name, "width": width, "height": height})
    return viewports or list(_DEFAULT_VIEWPORTS)


def _load_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None
    return sync_playwright


def _missing_playwright_report(html_file: Path, output_dir: Path) -> dict[str, Any]:
    return {
        "pass": False,
        "html_file": str(html_file),
        "output_dir": str(output_dir),
        "issues": [{
            "kind": "playwright-missing",
            "severity": "error",
            "details": (
                "Python Playwright is not installed. Install once with "
                "`python3 -m pip install playwright` and `python3 -m playwright install chromium`."
            ),
        }],
        "screenshots": [],
    }


def run_visual_check_html(inp: dict[str, Any]) -> dict[str, Any]:
    raw_html = inp.get("html_file") or inp.get("file_path") or inp.get("path")
    if not isinstance(raw_html, str) or not raw_html.strip():
        return {
            "pass": False,
            "issues": [{"kind": "missing-html-file", "severity": "error", "details": "html_file is required"}],
        }

    html_file = Path(raw_html).expanduser()
    if not html_file.is_absolute():
        html_file = Path.cwd() / html_file
    html_file = html_file.resolve()
    if not html_file.exists():
        return {
            "pass": False,
            "html_file": str(html_file),
            "issues": [{"kind": "html-file-not-found", "severity": "error", "details": str(html_file)}],
        }

    output_dir = Path(inp.get("output_dir") or _default_output_dir(html_file)).expanduser()
    if not output_dir.is_absolute():
        output_dir = Path.cwd() / output_dir
    output_dir = output_dir.resolve()
    viewports = _normalize_viewports(inp.get("viewports"))

    sync_playwright = _load_playwright()
    if sync_playwright is None:
        return _missing_playwright_report(html_file, output_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    screenshots: list[str] = []
    viewport_results: list[dict[str, Any]] = []
    all_issues: list[dict[str, Any]] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for viewport in viewports:
                page = browser.new_page(viewport={
                    "width": int(viewport["width"]),
                    "height": int(viewport["height"]),
                })
                console_errors: list[str] = []
                page_errors: list[str] = []
                page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
                page.on("pageerror", lambda exc: page_errors.append(str(exc)))
                page.goto(html_file.as_uri(), wait_until="networkidle")
                page.wait_for_timeout(int(inp.get("settle_ms", 250)))
                screenshot_path = output_dir / f"{viewport['name']}.png"
                page.screenshot(path=str(screenshot_path), full_page=True)
                screenshots.append(str(screenshot_path))
                result = page.evaluate(_CHECK_SCRIPT)
                result["name"] = viewport["name"]
                result["screenshot"] = str(screenshot_path)
                for message in console_errors[:20]:
                    result["issues"].append({
                        "kind": "console-error",
                        "severity": "error",
                        "selector": "console",
                        "text": "",
                        "rect": None,
                        "details": message,
                    })
                for message in page_errors[:20]:
                    result["issues"].append({
                        "kind": "page-error",
                        "severity": "error",
                        "selector": "page",
                        "text": "",
                        "rect": None,
                        "details": message,
                    })
                viewport_results.append(result)
                for issue in result["issues"]:
                    issue = dict(issue)
                    issue["viewport"] = viewport["name"]
                    all_issues.append(issue)
                page.close()
        finally:
            browser.close()

    max_issues = int(inp.get("max_issues", 60))
    report = {
        "pass": len(all_issues) == 0,
        "html_file": str(html_file),
        "output_dir": str(output_dir),
        "screenshots": screenshots,
        "issue_count": len(all_issues),
        "issues": all_issues[:max_issues],
        "viewports": viewport_results,
    }
    (output_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def _handle_visual_check_html(inp):
    report = run_visual_check_html(inp)
    return json.dumps(report, indent=2)


TOOLS = {
    "visual_check_html": {
        "name": "visual_check_html",
        "description": (
            "Render a generated HTML page in Chromium at desktop/tablet/mobile "
            "viewports, save screenshots, and report deterministic layout issues "
            "such as overflow, clipped text, overlapping labels, console errors, "
            "and page errors."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "html_file": {"type": "string", "description": "Path to the generated HTML file."},
                "output_dir": {"type": "string", "description": "Optional directory for screenshots and report.json."},
                "viewports": {
                    "type": "array",
                    "description": "Optional viewport list: [{name,width,height}].",
                    "items": {"type": "object"},
                },
                "settle_ms": {"type": "integer", "description": "Milliseconds to wait after network idle."},
                "max_issues": {"type": "integer", "description": "Maximum issues to include in stdout."},
            },
            "required": ["html_file"],
        },
        "function": _handle_visual_check_html,
    },
}
