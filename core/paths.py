"""
paths.py — Centralized path resolution for botference Python code.

Mirrors the shell path model in lib/config.sh:
- BOTFERENCE_HOME: framework install dir (specs, prompts, templates)
- BOTFERENCE_PROJECT_ROOT: project dir
- BOTFERENCE_WORK_DIR: working files (work/ if present, else project root)
- BOTFERENCE_BUILD_DIR: build artifacts (build/ if present, else project root)

Env vars take precedence when set (the shell's init_botference_paths exports
them before Python runs). Otherwise falls back to directory detection.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class BotferencePaths:
    """Resolved path set for a botference session."""

    botference_home: Path
    project_root: Path
    work_dir: Path
    build_dir: Path

    # -- Relay handoff paths --

    def handoff_live_file(self, model: str) -> Path:
        """Live handoff file for a model: work/handoff-claude.md etc."""
        return self.work_dir / f"handoff-{model}.md"

    @property
    def handoff_history_dir(self) -> Path:
        """Timestamped handoff copies: work/handoffs/"""
        return self.work_dir / "handoffs"

    def handoff_model_history_dir(self, model: str) -> Path:
        """Per-model history: work/handoffs/claude/"""
        return self.handoff_history_dir / model

    @property
    def handoff_template(self) -> Path:
        """Handoff template: templates/handoff.md"""
        return self.botference_home / "templates" / "handoff.md"

    @property
    def relay_prompt(self) -> Path:
        """Relay generation prompt: prompts/relay.md"""
        return self.botference_home / "prompts" / "relay.md"

    # -- Existing derived paths (for use in controller) --

    @property
    def work_prefix(self) -> str:
        """Relative prefix for work dir ('work/' or '') for allowed_tools."""
        if self.work_dir != self.project_root:
            return os.path.relpath(self.work_dir, self.project_root) + "/"
        return ""

    @classmethod
    def resolve(cls, **overrides: Path | str) -> BotferencePaths:
        """Build paths from env vars with filesystem fallback.

        Optional keyword overrides (mainly for testing):
            botference_home, project_root, work_dir, build_dir
        """
        botference_home = Path(
            overrides.get("botference_home")
            or os.environ.get("BOTFERENCE_HOME")
            or str(Path(__file__).resolve().parent.parent)
        )

        project_root = Path(
            overrides.get("project_root")
            or os.environ.get("BOTFERENCE_PROJECT_ROOT")
            or os.getcwd()
        )

        work_dir_val = overrides.get("work_dir")
        if work_dir_val:
            work_dir = Path(work_dir_val)
        elif os.environ.get("BOTFERENCE_WORK_DIR"):
            work_dir = Path(os.environ["BOTFERENCE_WORK_DIR"])
        elif (project_root / "work").is_dir():
            work_dir = project_root / "work"
        else:
            work_dir = project_root

        build_dir_val = overrides.get("build_dir")
        if build_dir_val:
            build_dir = Path(build_dir_val)
        elif os.environ.get("BOTFERENCE_BUILD_DIR"):
            build_dir = Path(os.environ["BOTFERENCE_BUILD_DIR"])
        elif (project_root / "build").is_dir():
            build_dir = project_root / "build"
        else:
            build_dir = project_root

        return cls(
            botference_home=botference_home,
            project_root=project_root,
            work_dir=work_dir,
            build_dir=build_dir,
        )
