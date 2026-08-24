"""
paths.py — Centralized path resolution for botference Python code.

Mirrors the shell path model in lib/config.sh:
- BOTFERENCE_HOME: framework install dir (specs, prompts, templates)
- BOTFERENCE_PROJECT_ROOT: project dir
- BOTFERENCE_PROJECT_DIR: project-local botference state dir when present
- BOTFERENCE_WORK_DIR: working files
- BOTFERENCE_BUILD_DIR: build artifacts
- BOTFERENCE_ARCHIVE_DIR: archived thread state

Env vars take precedence when set (the shell's init_botference_paths exports
them before Python runs). Otherwise falls back to directory detection.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path


_UNSAFE_COMPONENT = re.compile(r"[^A-Za-z0-9._-]+")


def sanitize_component(value: str) -> str:
    """Reduce an arbitrary id to one safe path component.

    Session ids are UUIDs today, but they arrive from a JSON payload that a
    previous process wrote, so they are not trusted to be free of separators.
    """
    cleaned = _UNSAFE_COMPONENT.sub("-", str(value).strip()).strip("-.")
    return cleaned[:120] or "unknown-session"


@dataclass(frozen=True)
class BotferencePaths:
    """Resolved path set for a botference session."""

    botference_home: Path
    project_root: Path
    project_dir: Path
    work_dir: Path
    build_dir: Path
    archive_dir: Path

    # -- Per-session scratch --

    def session_scratch_dir(self, session_id: str = "") -> Path:
        """Scratch root for ONE chat: work/scratch/<session_id>/.

        Several controller processes share one work dir (the Ink TUI, one
        web-council bridge per open chat, and — since 2026-08-24 — a pool of
        plugin bridge children). Everything under here belongs to a single
        chat, so two of them writing at the same moment cannot overwrite each
        other. An empty session id degrades to the old root-scoped layout.
        """
        if not str(session_id).strip():
            return self.work_dir
        return self.work_dir / "scratch" / sanitize_component(session_id)

    def scratch_file(
        self, name: str, session_id: str = "", *, scope: str = "",
    ) -> Path:
        """A named scratch file for one chat, optionally under a scope slug.

        `scope` separates the same filename in two planning scopes (a project
        vs. Inbox) within one chat, which can switch scopes with /project.
        """
        base = self.session_scratch_dir(session_id)
        if session_id and scope:
            base = base / sanitize_component(scope)
        return base / name

    # -- Relay handoff paths --

    def handoff_live_file(self, model: str, session_id: str = "") -> Path:
        """Live handoff file for a model.

        Session-keyed (`work/scratch/<sid>/handoff-claude.md`) when a session
        id is supplied; otherwise the legacy `work/handoff-claude.md`, which
        is still read as a fallback so a chat resumed across the upgrade
        keeps the handoff its previous process left behind.
        """
        return self.session_scratch_dir(session_id) / f"handoff-{model}.md"

    def handoff_live_candidates(
        self, model: str, session_id: str = "",
    ) -> list[Path]:
        """Read order for a live handoff: session-keyed first, legacy second."""
        paths = [self.handoff_live_file(model, session_id)]
        legacy = self.handoff_live_file(model)
        if legacy not in paths:
            paths.append(legacy)
        return paths

    @property
    def handoff_history_dir(self) -> Path:
        """Timestamped handoff copies: work/handoffs/"""
        return self.work_dir / "handoffs"

    def handoff_model_history_dir(self, model: str) -> Path:
        """Per-model history: work/handoffs/claude/"""
        return self.handoff_history_dir / model

    @property
    def session_dir(self) -> Path:
        """Crash-safe plan session snapshots: work/sessions/"""
        return self.work_dir / "sessions"

    def session_state_file(self, session_id: str) -> Path:
        """Snapshot file for a plan session."""
        return self.session_dir / f"{session_id}.json"

    @property
    def archived_session_dir(self) -> Path:
        """Archived chat snapshots: archive/sessions/

        Archiving a chat moves its JSON here — out of the active listing,
        still on disk, and reversible by moving it back.
        """
        return self.archive_dir / "sessions"

    def archived_session_state_file(self, session_id: str) -> Path:
        """Archived snapshot file for a plan session."""
        return self.archived_session_dir / f"{session_id}.json"

    @property
    def session_crash_log(self) -> Path:
        """Crash log for plan sessions."""
        return self.session_dir / "crash.log"

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
        """Relative prefix for work dir ('botference/', 'work/', or '')."""
        if self.work_dir != self.project_root:
            return os.path.relpath(self.work_dir, self.project_root) + "/"
        return ""

    @classmethod
    def resolve(cls, **overrides: Path | str) -> BotferencePaths:
        """Build paths from env vars with filesystem fallback.

        Optional keyword overrides (mainly for testing):
            botference_home, project_root, project_dir, work_dir, build_dir, archive_dir
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

        project_dir_val = overrides.get("project_dir")
        if project_dir_val:
            project_dir = Path(project_dir_val)
        elif os.environ.get("BOTFERENCE_PROJECT_DIR"):
            project_dir = Path(os.environ["BOTFERENCE_PROJECT_DIR"])
        elif (project_root / "botference").is_dir():
            project_dir = project_root / "botference"
        else:
            project_dir = project_root

        work_dir_val = overrides.get("work_dir")
        if work_dir_val:
            work_dir = Path(work_dir_val)
        elif os.environ.get("BOTFERENCE_WORK_DIR"):
            work_dir = Path(os.environ["BOTFERENCE_WORK_DIR"])
        elif project_dir != project_root:
            work_dir = project_dir
        elif (project_root / "project.json").is_file():
            # cwd IS a botference state dir (someone launched from inside
            # it). Use it directly — the legacy `work/` fallback below would
            # silently start a second session store at <state>/work/sessions.
            work_dir = project_root
        elif (project_root / "work").is_dir():
            work_dir = project_root / "work"
        else:
            work_dir = project_root

        build_dir_val = overrides.get("build_dir")
        if build_dir_val:
            build_dir = Path(build_dir_val)
        elif os.environ.get("BOTFERENCE_BUILD_DIR"):
            build_dir = Path(os.environ["BOTFERENCE_BUILD_DIR"])
        elif project_dir != project_root:
            build_dir = project_dir / "build"
        elif (project_root / "build").is_dir():
            build_dir = project_root / "build"
        else:
            build_dir = project_root

        archive_dir_val = overrides.get("archive_dir")
        if archive_dir_val:
            archive_dir = Path(archive_dir_val)
        elif os.environ.get("BOTFERENCE_ARCHIVE_DIR"):
            archive_dir = Path(os.environ["BOTFERENCE_ARCHIVE_DIR"])
        elif project_dir != project_root:
            archive_dir = project_dir / "archive"
        else:
            archive_dir = project_root / "archive"

        return cls(
            botference_home=botference_home,
            project_root=project_root,
            project_dir=project_dir,
            work_dir=work_dir,
            build_dir=build_dir,
            archive_dir=archive_dir,
        )
