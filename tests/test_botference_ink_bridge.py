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
from ui_types import ProjectPanelState  # noqa: E402
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


class TestFreshCrashArtifacts:
    def test_reports_fresh_artifacts_once(self, tmp_path):
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        crash_dir = tmp_path / ".botference"
        crash_dir.mkdir()
        ink_crash = crash_dir / "ink-crash.log"
        ink_crash.write_text('{"kind":"uncaughtException"}\n')
        reports = crash_dir / "crash-reports"
        reports.mkdir()
        (reports / "report.20260708.json").write_text("{}")

        fresh = binkb._fresh_crash_artifacts(c.paths)
        assert str(ink_crash) in fresh
        assert any("report.20260708.json" in p for p in fresh)

        # Marker recorded — a second launch stays quiet.
        assert binkb._fresh_crash_artifacts(c.paths) == []

    def test_new_crash_after_marker_is_reported_again(self, tmp_path):
        import os
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        crash_dir = tmp_path / ".botference"
        crash_dir.mkdir()
        ink_crash = crash_dir / "ink-crash.log"
        ink_crash.write_text("first\n")
        assert binkb._fresh_crash_artifacts(c.paths) != []
        assert binkb._fresh_crash_artifacts(c.paths) == []

        # A later crash bumps the mtime past the marker.
        future = time.time() + 60
        os.utime(ink_crash, (future, future))
        assert binkb._fresh_crash_artifacts(c.paths) == [str(ink_crash)]

    def test_quiet_when_no_artifacts(self, tmp_path):
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        assert binkb._fresh_crash_artifacts(c.paths) == []


@pytest.mark.asyncio
class TestCrashNoticeAtStartup:
    async def test_startup_surfaces_crash_evidence(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(binkb, "emit", lambda obj: None)
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        crash_dir = tmp_path / ".botference"
        crash_dir.mkdir()
        (crash_dir / "ink-crash.log").write_text("boom\n")

        bridge = _RecordingBridge()
        task = await binkb._send_initial_state_and_schedule_hydration(
            bridge, c, c.paths
        )
        await asyncio.wait_for(task, timeout=2.0)

        notices = [
            a[1] for name, a in bridge.calls
            if name == "add_room_entry" and "crashed" in str(a[1])
        ]
        assert notices, "startup must surface fresh crash artifacts"
        assert "ink-crash.log" in notices[0]


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


@pytest.mark.asyncio
class TestInkBridgeInputQueue:
    async def test_inputs_submitted_during_turn_run_in_order(
        self, tmp_path, monkeypatch
    ):
        emitted: list[dict] = []
        monkeypatch.setattr(
            binkb, "emit", lambda obj: emitted.append(dict(obj))
        )
        c, _, _, _ = _make_botference(tmp_path=tmp_path)

        releases = [asyncio.Event(), asyncio.Event()]
        handled: list[tuple[str, list[dict]]] = []

        async def handle_input(text, bridge, attachments=None):
            handled.append((text, list(attachments or [])))
            await releases[len(handled) - 1].wait()

        c.handle_input = handle_input
        bridge = _RecordingBridge()
        queue = binkb.InputTurnQueue(c, bridge, c.paths)

        queue.submit("first", [])
        await asyncio.sleep(0)
        queue.submit("second", [{"id": 1, "path": "/tmp/a.png", "type": "image"}])
        await asyncio.sleep(0)

        assert handled == [("first", [])]
        assert any(e == {"type": "queue", "pending": 1} for e in emitted)
        assert not any(e.get("type") == "ready" for e in emitted)

        releases[0].set()
        deadline = time.time() + 2.0
        while len(handled) < 2 and time.time() < deadline:
            await asyncio.sleep(0.005)
        assert handled == [
            ("first", []),
            ("second", [{"id": 1, "path": "/tmp/a.png", "type": "image"}]),
        ]
        assert not any(e.get("type") == "ready" for e in emitted)

        releases[1].set()
        await asyncio.wait_for(queue.wait_idle(), timeout=2.0)

        assert emitted[-2:] == [
            {"type": "queue", "pending": 0},
            {"type": "ready"},
        ]


@pytest.mark.asyncio
class TestSteeringSubmit:
    async def _running_queue(self, tmp_path, monkeypatch, emitted):
        monkeypatch.setattr(
            binkb, "emit", lambda obj: emitted.append(dict(obj))
        )
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        release = asyncio.Event()
        handled: list[str] = []

        async def handle_input(text, bridge, attachments=None):
            handled.append(text)
            await release.wait()

        c.handle_input = handle_input
        queue = binkb.InputTurnQueue(c, _RecordingBridge(), c.paths)
        return c, queue, release, handled

    async def test_mid_turn_input_steers_instead_of_queueing(
        self, tmp_path, monkeypatch
    ):
        emitted: list[dict] = []
        c, queue, release, handled = await self._running_queue(
            tmp_path, monkeypatch, emitted
        )
        steered: list[str] = []
        c.steer_active = lambda text, ui: (steered.append(text), "claude")[1]

        queue.submit("first", [])
        await asyncio.sleep(0)
        queue.submit("also consider X", [])
        assert steered == ["also consider X"]
        assert not any(
            e == {"type": "queue", "pending": 1} for e in emitted
        ), "steered input must not enter the queue"

        release.set()
        await asyncio.wait_for(queue.wait_idle(), timeout=2.0)
        assert handled == ["first"], "steered input must not run as a turn"

    async def test_steer_decline_falls_back_to_queue(
        self, tmp_path, monkeypatch
    ):
        emitted: list[dict] = []
        c, queue, release, handled = await self._running_queue(
            tmp_path, monkeypatch, emitted
        )
        c.steer_active = lambda text, ui: ""

        queue.submit("first", [])
        await asyncio.sleep(0)
        queue.submit("second", [])
        release.set()
        await asyncio.wait_for(queue.wait_idle(), timeout=2.0)
        assert handled == ["first", "second"]

    async def test_attachments_never_steer(self, tmp_path, monkeypatch):
        emitted: list[dict] = []
        c, queue, release, handled = await self._running_queue(
            tmp_path, monkeypatch, emitted
        )
        c.steer_active = lambda text, ui: (_ for _ in ()).throw(
            AssertionError("attachments must take the queued path")
        )

        queue.submit("first", [])
        await asyncio.sleep(0)
        queue.submit("look at this", [{"id": 1, "path": "/tmp/a.png"}])
        release.set()
        await asyncio.wait_for(queue.wait_idle(), timeout=2.0)
        assert handled == ["first", "look at this"]

    async def test_idle_submit_does_not_attempt_steer(
        self, tmp_path, monkeypatch
    ):
        emitted: list[dict] = []
        c, queue, release, handled = await self._running_queue(
            tmp_path, monkeypatch, emitted
        )
        c.steer_active = lambda text, ui: (_ for _ in ()).throw(
            AssertionError("idle input must not try to steer")
        )
        release.set()
        queue.submit("first", [])
        await asyncio.wait_for(queue.wait_idle(), timeout=2.0)
        assert handled == ["first"]


@pytest.mark.asyncio
class TestNotifyEmission:
    def _setup(self, tmp_path, monkeypatch, emitted):
        monkeypatch.setenv(
            "BOTFERENCE_SETTINGS_FILE", str(tmp_path / "user-settings.json")
        )
        monkeypatch.setattr(
            binkb, "emit", lambda obj: emitted.append(dict(obj))
        )
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        return c

    async def test_notify_emitted_before_ready_after_long_turn(
        self, tmp_path, monkeypatch
    ):
        emitted: list[dict] = []
        c = self._setup(tmp_path, monkeypatch, emitted)
        monkeypatch.setattr(binkb, "_NOTIFY_MIN_TURN_SECONDS", 0.0)

        async def handle_input(text, bridge, attachments=None):
            pass

        c.handle_input = handle_input
        queue = binkb.InputTurnQueue(c, _RecordingBridge(), c.paths)
        queue.submit("hello", [])
        await asyncio.wait_for(queue.wait_idle(), timeout=2.0)

        kinds = [e.get("type") for e in emitted]
        assert "notify" in kinds
        assert kinds.index("notify") < kinds.index("ready")
        notify = next(e for e in emitted if e.get("type") == "notify")
        assert notify["title"] == "botference"
        assert "floor is yours" in notify["body"]

    async def test_no_notify_when_disabled(self, tmp_path, monkeypatch):
        emitted: list[dict] = []
        c = self._setup(tmp_path, monkeypatch, emitted)
        monkeypatch.setattr(binkb, "_NOTIFY_MIN_TURN_SECONDS", 0.0)
        c.notify = False

        async def handle_input(text, bridge, attachments=None):
            pass

        c.handle_input = handle_input
        queue = binkb.InputTurnQueue(c, _RecordingBridge(), c.paths)
        queue.submit("hello", [])
        await asyncio.wait_for(queue.wait_idle(), timeout=2.0)

        assert not any(e.get("type") == "notify" for e in emitted)

    async def test_no_notify_for_short_turns(self, tmp_path, monkeypatch):
        # Default threshold: an instant command never pings.
        emitted: list[dict] = []
        c = self._setup(tmp_path, monkeypatch, emitted)

        async def handle_input(text, bridge, attachments=None):
            pass

        c.handle_input = handle_input
        queue = binkb.InputTurnQueue(c, _RecordingBridge(), c.paths)
        queue.submit("/help", [])
        await asyncio.wait_for(queue.wait_idle(), timeout=2.0)

        assert not any(e.get("type") == "notify" for e in emitted)

    async def test_no_notify_after_interrupt(self, tmp_path, monkeypatch):
        # An interrupt means the user is at the keyboard — stay silent.
        emitted: list[dict] = []
        c = self._setup(tmp_path, monkeypatch, emitted)
        monkeypatch.setattr(binkb, "_NOTIFY_MIN_TURN_SECONDS", 0.0)

        started = asyncio.Event()

        async def handle_input(text, bridge, attachments=None):
            started.set()
            await asyncio.Event().wait()  # blocks until cancelled

        c.handle_input = handle_input
        queue = binkb.InputTurnQueue(c, _RecordingBridge(), c.paths)
        queue.submit("hello", [])
        await asyncio.wait_for(started.wait(), timeout=2.0)
        queue.interrupt()
        await asyncio.wait_for(queue.wait_idle(), timeout=2.0)

        assert not any(e.get("type") == "notify" for e in emitted)
        assert any(e.get("type") == "ready" for e in emitted)

    async def test_permission_request_pings_when_enabled(
        self, tmp_path, monkeypatch
    ):
        from botference import WritePermissionRequest

        emitted: list[dict] = []
        monkeypatch.setattr(
            binkb, "emit", lambda obj: emitted.append(dict(obj))
        )
        bridge = binkb.InkBridge(BotferencePaths.resolve(work_dir=tmp_path))
        bridge.notify_enabled = lambda: True

        request = WritePermissionRequest(
            request_id="r1", model="claude",
            path="src/app.py", reason="edit",
        )
        task = asyncio.create_task(bridge.request_write_permission(request))
        await asyncio.sleep(0)
        bridge.resolve_permission_request(True)
        assert await asyncio.wait_for(task, timeout=2.0) is True

        notify = next(e for e in emitted if e.get("type") == "notify")
        assert "@claude" in notify["body"]
        assert "src/app.py" in notify["body"]

    async def test_permission_request_silent_when_disabled(
        self, tmp_path, monkeypatch
    ):
        from botference import WritePermissionRequest

        emitted: list[dict] = []
        monkeypatch.setattr(
            binkb, "emit", lambda obj: emitted.append(dict(obj))
        )
        bridge = binkb.InkBridge(BotferencePaths.resolve(work_dir=tmp_path))

        request = WritePermissionRequest(
            request_id="r1", model="claude",
            path="src/app.py", reason="edit",
        )
        task = asyncio.create_task(bridge.request_write_permission(request))
        await asyncio.sleep(0)
        bridge.resolve_permission_request(False)
        assert await asyncio.wait_for(task, timeout=2.0) is False

        assert not any(e.get("type") == "notify" for e in emitted)


@pytest.mark.asyncio
class TestStreamCoalescing:
    def _bridge(self, tmp_path, monkeypatch, emitted):
        monkeypatch.setattr(
            binkb, "emit", lambda obj: emitted.append(dict(obj))
        )
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        return binkb.InkBridge(c.paths)

    async def test_text_deltas_coalesce_into_one_emit(
        self, tmp_path, monkeypatch
    ):
        emitted: list[dict] = []
        bridge = self._bridge(tmp_path, monkeypatch, emitted)

        base = {"stream_id": "s1", "pane": "room", "model": "claude"}
        for chunk in ("Hel", "lo ", "world"):
            bridge.stream_event({**base, "kind": "text_delta", "text": chunk})

        # Nothing crosses the boundary until the flush interval elapses.
        assert emitted == []
        await asyncio.sleep(binkb._STREAM_FLUSH_INTERVAL + 0.05)

        deltas = [e for e in emitted if e.get("kind") == "text_delta"]
        assert len(deltas) == 1
        assert deltas[0]["text"] == "Hello world"

    async def test_non_delta_event_flushes_buffer_first(
        self, tmp_path, monkeypatch
    ):
        emitted: list[dict] = []
        bridge = self._bridge(tmp_path, monkeypatch, emitted)

        base = {"stream_id": "s1", "pane": "room", "model": "claude"}
        bridge.stream_event({**base, "kind": "text_delta", "text": "partial"})
        bridge.stream_event({**base, "kind": "done"})

        kinds = [e.get("kind") for e in emitted]
        assert kinds == ["text_delta", "done"]
        assert emitted[0]["text"] == "partial"

    async def test_streams_do_not_mix(self, tmp_path, monkeypatch):
        emitted: list[dict] = []
        bridge = self._bridge(tmp_path, monkeypatch, emitted)

        bridge.stream_event({
            "stream_id": "s1", "pane": "room", "model": "claude",
            "kind": "text_delta", "text": "claude-text",
        })
        bridge.stream_event({
            "stream_id": "s2", "pane": "room", "model": "codex",
            "kind": "text_delta", "text": "codex-text",
        })
        await asyncio.sleep(binkb._STREAM_FLUSH_INTERVAL + 0.05)

        texts = {e["text"] for e in emitted if e.get("kind") == "text_delta"}
        assert texts == {"claude-text", "codex-text"}


class TestDecodeStdinLine:
    def test_valid_object_parses(self):
        msg = binkb.decode_stdin_line('{"type": "input", "text": "hi"}\n')
        assert msg == {"type": "input", "text": "hi"}

    def test_malformed_json_returns_none(self):
        assert binkb.decode_stdin_line("{not json") is None

    def test_non_dict_json_returns_none(self):
        # A bare scalar/array used to raise AttributeError on msg.get(...)
        # in the input loop, killing the bridge process mid-session.
        assert binkb.decode_stdin_line("5") is None
        assert binkb.decode_stdin_line('"input"') is None
        assert binkb.decode_stdin_line("[1, 2]") is None
        assert binkb.decode_stdin_line("null") is None

    def test_blank_line_returns_none(self):
        assert binkb.decode_stdin_line("   \n") is None


class TestStreamLogRotation:
    def _bridge(self, tmp_path, monkeypatch, emitted):
        monkeypatch.setattr(
            binkb, "emit", lambda obj: emitted.append(dict(obj))
        )
        return binkb.InkBridge(BotferencePaths.resolve(work_dir=tmp_path))

    def test_stream_log_rotates_at_size_cap(self, tmp_path, monkeypatch):
        monkeypatch.setattr(binkb, "_STREAM_LOG_MAX_BYTES", 2_000)
        emitted: list[dict] = []
        bridge = self._bridge(tmp_path, monkeypatch, emitted)

        base = {"stream_id": "s1", "pane": "room", "model": "claude"}
        for i in range(50):
            bridge.stream_event({**base, "kind": "done", "n": i, "pad": "x" * 100})

        log_path = bridge.stream_log_path
        rotated = log_path.with_name(log_path.name + ".1")
        assert rotated.exists()
        assert log_path.stat().st_size <= 2_000 + 512
        # The most recent event is always in the live log.
        lines = log_path.read_text(encoding="utf-8").splitlines()
        assert json.loads(lines[-1])["n"] == 49
        # Rotation never splits a line — both generations stay valid JSONL.
        for line in rotated.read_text(encoding="utf-8").splitlines():
            json.loads(line)

    def test_stream_log_counter_resumes_from_existing_file(
        self, tmp_path, monkeypatch
    ):
        emitted: list[dict] = []
        first = self._bridge(tmp_path, monkeypatch, emitted)
        base = {"stream_id": "s1", "pane": "room", "model": "claude"}
        first.stream_event({**base, "kind": "done"})
        size_after_first = first.stream_log_path.stat().st_size

        second = binkb.InkBridge(BotferencePaths.resolve(work_dir=tmp_path))
        # A relaunched bridge picks up the on-disk size, so the rotation
        # threshold applies to the file as a whole, not per-process writes.
        assert second._stream_log_bytes > size_after_first

    def test_stream_log_write_failure_does_not_break_turn(
        self, tmp_path, monkeypatch
    ):
        emitted: list[dict] = []
        bridge = self._bridge(tmp_path, monkeypatch, emitted)
        # Point the log at an unwritable location: stream_event must still
        # emit to the UI instead of raising into the controller turn.
        bridge.stream_log_path = tmp_path / "missing-dir" / "x" / "log.jsonl"
        bridge.stream_event({
            "stream_id": "s1", "pane": "room", "model": "claude",
            "kind": "done",
        })
        assert any(e.get("kind") == "done" for e in emitted)
