"""Tests for core/paths.py — BotferencePaths resolution."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from paths import BotferencePaths


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Remove botference env vars so tests use overrides / filesystem detection."""
    for var in ("BOTFERENCE_WORK_DIR", "BOTFERENCE_BUILD_DIR",
                "BOTFERENCE_HOME", "BOTFERENCE_PROJECT_ROOT"):
        monkeypatch.delenv(var, raising=False)


class TestBotferencePathsResolve:
    def test_resolve_with_work_dir(self, tmp_path):
        """work/ subdir detected → work_dir points there."""
        (tmp_path / "work").mkdir()
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.work_dir == tmp_path / "work"
        assert p.work_prefix == "work/"

    def test_resolve_legacy_layout(self, tmp_path):
        """No work/ subdir → work_dir falls back to project root."""
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.work_dir == tmp_path
        assert p.work_prefix == ""

    def test_resolve_with_build_dir(self, tmp_path):
        """build/ subdir detected → build_dir points there."""
        (tmp_path / "build").mkdir()
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.build_dir == tmp_path / "build"

    def test_resolve_legacy_build(self, tmp_path):
        """No build/ subdir → build_dir falls back to project root."""
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.build_dir == tmp_path

    def test_env_vars_take_precedence(self, tmp_path, monkeypatch):
        """Env vars override filesystem detection."""
        work = tmp_path / "custom_work"
        work.mkdir()
        build = tmp_path / "custom_build"
        build.mkdir()
        monkeypatch.setenv("BOTFERENCE_WORK_DIR", str(work))
        monkeypatch.setenv("BOTFERENCE_BUILD_DIR", str(build))
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.work_dir == work
        assert p.build_dir == build

    def test_overrides_beat_env_vars(self, tmp_path, monkeypatch):
        """Explicit overrides beat env vars."""
        monkeypatch.setenv("BOTFERENCE_WORK_DIR", "/should/be/ignored")
        override_work = tmp_path / "override"
        override_work.mkdir()
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
            work_dir=override_work,
        )
        assert p.work_dir == override_work


class TestHandoffPaths:
    def test_handoff_live_files(self, tmp_path):
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.handoff_live_file("claude") == tmp_path / "handoff-claude.md"
        assert p.handoff_live_file("codex") == tmp_path / "handoff-codex.md"

    def test_handoff_live_files_with_work_dir(self, tmp_path):
        (tmp_path / "work").mkdir()
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.handoff_live_file("claude") == tmp_path / "work" / "handoff-claude.md"

    def test_handoff_history_dir(self, tmp_path):
        (tmp_path / "work").mkdir()
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.handoff_history_dir == tmp_path / "work" / "handoffs"

    def test_handoff_model_history_dir(self, tmp_path):
        (tmp_path / "work").mkdir()
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.handoff_model_history_dir("claude") == tmp_path / "work" / "handoffs" / "claude"

    def test_handoff_template(self, tmp_path):
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.handoff_template == tmp_path / "templates" / "handoff.md"

    def test_relay_prompt(self, tmp_path):
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.relay_prompt == tmp_path / "prompts" / "relay.md"


class TestWorkPrefix:
    def test_work_prefix_with_work_dir(self, tmp_path):
        (tmp_path / "work").mkdir()
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.work_prefix == "work/"

    def test_work_prefix_legacy(self, tmp_path):
        p = BotferencePaths.resolve(
            botference_home=tmp_path, project_root=tmp_path,
        )
        assert p.work_prefix == ""
