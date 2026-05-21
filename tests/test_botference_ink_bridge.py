"""
Startup-ordering tests for core/botference_ink_bridge.py.

The Ink TUI must become usable BEFORE project_panel_snapshot finishes —
launch is decoupled from session-corpus scanning by sending an empty
placeholder projects state plus `ready`, then hydrating asynchronously.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

import botference_ink_bridge as binkb  # noqa: E402
from botference import Botference  # noqa: E402
from botference_ui import ProjectPanelState  # noqa: E402
from paths import BotferencePaths  # noqa: E402

# Re-use the controller scaffolding from the main test module.
from test_botference import MockAdapter, _make_botference, _ok  # noqa: E402


class _RecordingBridge:
    """Test double for InkBridge — records every call for assertions."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    def set_status(self, status: Any) -> None:
        self.calls.append(("set_status", status))

    def set_projects(self, state: ProjectPanelState) -> None:
        self.calls.append(("set_projects", state))

    def add_room_entry(self, *a: Any, **kw: Any) -> None:
        self.calls.append(("add_room_entry", a))

    def add_caucus_entry(self, *a: Any, **kw: Any) -> None:
        self.calls.append(("add_caucus_entry", a))


@pytest.mark.asyncio
class TestInkBridgeStartup:
    async def test_ready_emitted_before_project_snapshot_completes(
        self, tmp_path, monkeypatch
    ):
        # Launch must paint the UI and emit ready BEFORE the (potentially
        # slow) project_panel_snapshot finishes.
        emitted: list[dict] = []
        monkeypatch.setattr(
            binkb, "emit", lambda obj: emitted.append(dict(obj))
        )

        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        # Seed one inbox session so the post-hydration snapshot has real
        # data — proves the second set_projects carries the actual state.
        (c.paths.session_dir / "alpha.json").write_text(json.dumps({
            "session_id": "alpha",
            "transcript": [{"speaker": "user", "text": "hi"}],
            "updated_at": "2026-05-02T00:00:00Z",
        }), encoding="utf-8")

        release = asyncio.Event()
        real_snapshot = c.project_panel_snapshot

        def slow_snapshot():
            # Block in the worker thread until the test releases us.
            # Bounded so a regression can't hang the test indefinitely.
            deadline = time.time() + 2.0
            while not release.is_set() and time.time() < deadline:
                time.sleep(0.005)
            return real_snapshot()

        c.project_panel_snapshot = slow_snapshot

        bridge = _RecordingBridge()
        task = await binkb._send_initial_state_and_schedule_hydration(
            bridge, c, c.paths
        )

        # `ready` and the placeholder projects message both fired
        # synchronously — before the slow snapshot finished.
        kinds = [e.get("type") for e in emitted]
        assert "completion_context" in kinds
        assert "ready" in kinds
        first_projects = next(
            call for call in bridge.calls if call[0] == "set_projects"
        )
        assert first_projects[1].projects == ()
        assert first_projects[1].active_project_id == c.active_project_id
        assert first_projects[1].inbox_session_count == 0
        assert not task.done(), (
            "hydration must not be complete before snapshot is released"
        )

        release.set()
        await asyncio.wait_for(task, timeout=2.0)

        # Second set_projects landed with the real hydrated snapshot.
        project_calls = [c2 for c2 in bridge.calls if c2[0] == "set_projects"]
        assert len(project_calls) == 2
        hydrated = project_calls[1][1]
        assert hydrated.inbox_session_count == 1

    async def test_bridge_hydration_failure_logs_crash_and_does_not_raise(
        self, tmp_path, monkeypatch
    ):
        # A snapshot exception must be funneled to the crash log; the
        # bridge stays alive on the placeholder panel.
        monkeypatch.setattr(binkb, "emit", lambda obj: None)
        c, _, _, _ = _make_botference(tmp_path=tmp_path)

        def boom():
            raise RuntimeError("snapshot kaboom")

        c.project_panel_snapshot = boom

        bridge = _RecordingBridge()
        task = await binkb._send_initial_state_and_schedule_hydration(
            bridge, c, c.paths
        )
        await asyncio.wait_for(task, timeout=2.0)

        assert task.exception() is None, (
            "hydration failure must not propagate out of the task"
        )

        crash_log = c.paths.session_crash_log
        assert crash_log.exists()
        content = crash_log.read_text(encoding="utf-8")
        assert "snapshot kaboom" in content
        assert "hydrate_project_panel" in content

        # The placeholder set_projects ran once; no second update after
        # the failure.
        project_calls = [c2 for c2 in bridge.calls if c2[0] == "set_projects"]
        assert len(project_calls) == 1
        assert project_calls[0][1].projects == ()
