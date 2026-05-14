from __future__ import annotations

import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools import execute_tool
from tools.visual import _normalize_viewports, run_visual_check_html


class TestVisualCheckHtml:
    def test_normalizes_invalid_viewports_to_defaults(self):
        viewports = _normalize_viewports([{"width": 0, "height": 10}, "bad"])
        assert [item["name"] for item in viewports] == ["desktop", "tablet", "mobile"]

    def test_missing_playwright_is_explicit(self, tmp_path, monkeypatch):
        html = tmp_path / "plot.html"
        html.write_text("<!doctype html><title>Plot</title><h1>Hello</h1>", encoding="utf-8")
        monkeypatch.setenv("BOTFERENCE_WORK_DIR", str(tmp_path / "botference"))
        monkeypatch.setattr("tools.visual._load_playwright", lambda: None)

        report = run_visual_check_html({"html_file": str(html)})

        assert report["pass"] is False
        assert report["issues"][0]["kind"] == "playwright-missing"
        assert str(tmp_path / "botference" / "visual-checks") in report["output_dir"]

    def test_tool_dispatch_exposes_visual_check(self, tmp_path, monkeypatch):
        html = tmp_path / "plot.html"
        html.write_text("<!doctype html><title>Plot</title><h1>Hello</h1>", encoding="utf-8")
        monkeypatch.setattr("tools.visual._load_playwright", lambda: None)

        raw = execute_tool("visual_check_html", {"html_file": str(html)})
        report = json.loads(raw)

        assert report["issues"][0]["kind"] == "playwright-missing"
