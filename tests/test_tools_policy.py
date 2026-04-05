from __future__ import annotations

import os
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools import execute_tool


def _set_project_env(monkeypatch, project_root: Path, *, mode: str = "build", build_roots: str = "", plan_roots: str = "") -> None:
    project_dir = project_root / "botference"
    monkeypatch.setenv("BOTFERENCE_ACTIVE_MODE", mode)
    monkeypatch.setenv("BOTFERENCE_PROJECT_ROOT", str(project_root))
    monkeypatch.setenv("BOTFERENCE_PROJECT_DIR_NAME", "botference")
    monkeypatch.setenv("BOTFERENCE_PROJECT_DIR", str(project_dir))
    monkeypatch.setenv("BOTFERENCE_WORK_DIR", str(project_dir))
    monkeypatch.setenv("BOTFERENCE_BUILD_EXTRA_WRITE_ROOTS", build_roots)
    monkeypatch.setenv("BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS", plan_roots)


class TestToolWritePolicy:
    def test_write_file_allows_declared_build_root(self, tmp_path, monkeypatch):
        project_root = tmp_path
        (project_root / "botference" / "wiki").mkdir(parents=True)
        monkeypatch.chdir(project_root)
        _set_project_env(monkeypatch, project_root, mode="build", build_roots="botference/wiki")

        result = execute_tool(
            "write_file",
            {"file_path": "botference/wiki/entry.md", "content": "hello\n"},
        )

        assert result.startswith("Wrote ")
        assert (project_root / "botference" / "wiki" / "entry.md").read_text() == "hello\n"

    def test_write_file_blocks_outside_declared_build_roots(self, tmp_path, monkeypatch):
        project_root = tmp_path
        (project_root / "botference").mkdir(parents=True)
        monkeypatch.chdir(project_root)
        _set_project_env(monkeypatch, project_root, mode="build", build_roots="botference/wiki")

        result = execute_tool(
            "write_file",
            {"file_path": "notes.md", "content": "should fail\n"},
        )

        assert "blocked by project policy" in result
        assert "notes.md" in result
        assert not (project_root / "notes.md").exists()

    def test_write_file_allows_default_build_directory(self, tmp_path, monkeypatch):
        project_root = tmp_path
        (project_root / "botference" / "build").mkdir(parents=True)
        monkeypatch.chdir(project_root)
        _set_project_env(monkeypatch, project_root, mode="build", build_roots="botference/build")

        result = execute_tool(
            "write_file",
            {"file_path": "botference/build/output.txt", "content": "artifact\n"},
        )

        assert result.startswith("Wrote ")
        assert (project_root / "botference" / "build" / "output.txt").read_text() == "artifact\n"

    def test_write_file_allows_any_plan_work_file(self, tmp_path, monkeypatch):
        project_root = tmp_path
        (project_root / "botference" / "exports").mkdir(parents=True)
        monkeypatch.chdir(project_root)
        _set_project_env(monkeypatch, project_root, mode="plan")

        result = execute_tool(
            "write_file",
            {"file_path": "botference/exports/caucus.md", "content": "saved\n"},
        )

        assert result.startswith("Wrote ")
        assert (project_root / "botference" / "exports" / "caucus.md").read_text() == "saved\n"

    def test_write_file_blocks_nested_git_even_inside_allowed_root(self, tmp_path, monkeypatch):
        project_root = tmp_path
        (project_root / "botference" / "wiki" / ".git").mkdir(parents=True)
        monkeypatch.chdir(project_root)
        _set_project_env(monkeypatch, project_root, mode="build", build_roots="botference")

        result = execute_tool(
            "write_file",
            {"file_path": "botference/wiki/.git/config", "content": "bad\n"},
        )

        assert "blocked by project policy" in result
        assert not (project_root / "botference" / "wiki" / ".git" / "config").exists()
