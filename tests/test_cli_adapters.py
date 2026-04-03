"""
Fixture-driven tests for cli_adapters.py parsing and session logic.

Uses spike-output/*.jsonl samples as fixtures (captured in Task 0).
Tests the deterministic parsing layer only — no real CLI subprocesses.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

# Add .botference to path so we can import cli_adapters
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from cli_adapters import (
    AdapterResponse,
    ClaudeAdapter,
    CodexAdapter,
    ToolSummary,
    _read_jsonl_lines,
    _truncate,
    _CONTEXT_WINDOWS,
    claude_plan_settings_for_work_dir,
    plan_allowed_tools_for_work_dir,
)

SPIKE_DIR = Path(__file__).resolve().parent / "fixtures"


# ── Helpers ──────────────────────────────────────────────────


class _MockReader:
    """Minimal async reader that serves pre-loaded data via read().

    Avoids asyncio.StreamReader's 64KB line limit which breaks on
    Claude JSONL fixtures with large tool results.
    """

    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0

    async def read(self, n: int = -1) -> bytes:
        if self._pos >= len(self._data):
            return b""
        if n < 0:
            chunk = self._data[self._pos:]
            self._pos = len(self._data)
        else:
            chunk = self._data[self._pos:self._pos + n]
            self._pos += len(chunk)
        return chunk


def _make_reader(data: str) -> _MockReader:
    """Create a mock async reader pre-loaded with data."""
    return _MockReader(data.encode("utf-8"))


def _load_fixture(name: str) -> str:
    return (SPIKE_DIR / name).read_text()


async def _collect_events(data: str):
    """Parse JSONL data through _read_jsonl_lines, return (events, raw_lines)."""
    raw_lines = []
    reader = _make_reader(data)
    events = []
    async for event in _read_jsonl_lines(reader, raw_lines):
        events.append(event)
    return events, raw_lines


# ── _read_jsonl_lines tests ──────────────────────────────────


class TestReadJsonlLines:
    def test_parses_valid_jsonl(self):
        data = '{"type":"a"}\n{"type":"b"}\n'
        events, raw = asyncio.run(_collect_events(data))
        assert len(events) == 2
        assert events[0]["type"] == "a"
        assert events[1]["type"] == "b"

    def test_skips_blank_lines(self):
        data = '{"type":"a"}\n\n\n{"type":"b"}\n'
        events, raw = asyncio.run(_collect_events(data))
        assert len(events) == 2

    def test_non_json_lines_in_raw_but_not_events(self):
        data = 'WARNING: something\n{"type":"ok"}\ngarbage\n'
        events, raw = asyncio.run(_collect_events(data))
        assert len(events) == 1
        assert events[0]["type"] == "ok"
        # raw_lines captures everything including non-JSON
        assert len(raw) == 3
        assert raw[0] == "WARNING: something"
        assert raw[2] == "garbage"

    def test_empty_stream(self):
        events, raw = asyncio.run(_collect_events(""))
        assert events == []
        assert raw == []


# ── _truncate tests ──────────────────────────────────────────


class TestTruncate:
    def test_short_string_unchanged(self):
        assert _truncate("abc", 10) == "abc"

    def test_exact_limit_unchanged(self):
        assert _truncate("abcde", 5) == "abcde"

    def test_long_string_truncated(self):
        assert _truncate("abcdef", 3) == "abc..."


# ── ToolSummary tests ────────────────────────────────────────


class TestToolSummary:
    def test_requires_id_name_input(self):
        ts = ToolSummary(id="t1", name="Glob", input_preview="**/*.py")
        assert ts.id == "t1"
        assert ts.output_preview == ""

    def test_output_preview_default_empty(self):
        ts = ToolSummary(id="t1", name="Read", input_preview="foo.py")
        assert ts.output_preview == ""


# ── Claude fixture parsing ───────────────────────────────────


class TestClaudeFixtureParsing:
    """Parse spike-output/codex-*.jsonl through the Codex parsing logic,
    and claude-*.jsonl through Claude parsing logic."""

    def test_claude_first_msg_result(self):
        """claude-first-msg.jsonl should produce a result event with text and tokens."""
        data = _load_fixture("claude-first-msg.jsonl")
        events, raw = asyncio.run(_collect_events(data))
        result_events = [e for e in events if e.get("type") == "result"]
        assert len(result_events) >= 1
        result = result_events[0]
        assert result.get("result"), "Result text should be non-empty"
        usage = result.get("usage", {})
        assert usage.get("output_tokens", 0) > 0

    def test_claude_tooluse_has_tool_events(self):
        """claude-tooluse-msg.jsonl should contain tool_use and tool_result."""
        data = _load_fixture("claude-tooluse-msg.jsonl")
        events, _ = asyncio.run(_collect_events(data))
        tool_uses = [
            e for e in events
            if e.get("type") == "assistant"
            and any(b.get("type") == "tool_use"
                    for b in e.get("message", {}).get("content", []))
        ]
        tool_results = [
            e for e in events
            if e.get("type") == "user"
            and any(b.get("type") == "tool_result"
                    for b in e.get("message", {}).get("content", []))
        ]
        assert len(tool_uses) >= 1, "Expected at least one tool_use event"
        assert len(tool_results) >= 1, "Expected at least one tool_result event"

    def test_claude_resume_has_cache_read(self):
        """Resume call should show cache_read_input_tokens > 0."""
        data = _load_fixture("claude-resume-msg.jsonl")
        events, _ = asyncio.run(_collect_events(data))
        result_events = [e for e in events if e.get("type") == "result"]
        assert len(result_events) >= 1
        usage = result_events[0].get("usage", {})
        # On resume, prior context is cached
        cache_read = usage.get("cache_read_input_tokens", 0)
        cache_create = usage.get("cache_creation_input_tokens", 0)
        assert cache_read > 0 or cache_create > 0, \
            "Resume should have non-zero cache tokens"


# ── Codex fixture parsing ────────────────────────────────────


class TestCodexFixtureParsing:
    def test_codex_first_msg(self):
        data = _load_fixture("codex-first-msg.jsonl")
        events, _ = asyncio.run(_collect_events(data))
        thread_events = [e for e in events if e.get("type") == "thread.started"]
        assert len(thread_events) == 1
        assert thread_events[0]["thread_id"]

        msg_events = [
            e for e in events
            if e.get("type") == "item.completed"
            and e.get("item", {}).get("type") == "agent_message"
        ]
        assert len(msg_events) >= 1
        assert msg_events[0]["item"]["text"]

    def test_codex_tooluse(self):
        data = _load_fixture("codex-tooluse-msg.jsonl")
        events, _ = asyncio.run(_collect_events(data))
        cmd_events = [
            e for e in events
            if e.get("type") == "item.completed"
            and e.get("item", {}).get("type") == "command_execution"
        ]
        assert len(cmd_events) >= 1
        # Each should have an id
        for ce in cmd_events:
            assert ce["item"].get("id"), "command_execution should have item.id"

    def test_codex_resume_has_tokens(self):
        data = _load_fixture("codex-resume-msg.jsonl")
        events, _ = asyncio.run(_collect_events(data))
        turn_events = [e for e in events if e.get("type") == "turn.completed"]
        assert len(turn_events) >= 1
        usage = turn_events[0].get("usage", {})
        assert usage.get("input_tokens", 0) > 0


# ── Codex dedup by item.id ───────────────────────────────────


class TestCodexDedup:
    def test_dedup_merges_started_and_completed_by_id(self):
        """item.started + item.completed for same id -> one ToolSummary."""
        summaries = [
            ToolSummary(id="item_1", name="head -n 1 foo.md", input_preview="(running)"),
            ToolSummary(id="item_1", name="head -n 1 foo.md", input_preview="",
                        output_preview="# Title"),
        ]
        # Replicate dedup logic from CodexAdapter._run
        seen = {}
        deduped = []
        for ts in summaries:
            if ts.id and ts.id in seen:
                existing = seen[ts.id]
                existing.output_preview = ts.output_preview or existing.output_preview
                if ts.input_preview != "(running)":
                    existing.input_preview = ts.input_preview
            else:
                if ts.id:
                    seen[ts.id] = ts
                deduped.append(ts)

        assert len(deduped) == 1
        assert deduped[0].output_preview == "# Title"
        assert deduped[0].input_preview == ""  # overwritten from completed

    def test_different_ids_not_collapsed(self):
        """Two commands with same text but different ids stay separate."""
        summaries = [
            ToolSummary(id="item_1", name="ls -la", input_preview=""),
            ToolSummary(id="item_2", name="ls -la", input_preview=""),
        ]
        seen = {}
        deduped = []
        for ts in summaries:
            if ts.id and ts.id in seen:
                existing = seen[ts.id]
                existing.output_preview = ts.output_preview or existing.output_preview
            else:
                if ts.id:
                    seen[ts.id] = ts
                deduped.append(ts)

        assert len(deduped) == 2


# ── Session isolation ────────────────────────────────────────


class TestCodexSessionIsolation:
    def test_resume_derives_last_turn_usage_from_cumulative_totals(self):
        """Codex exec JSON usage is cumulative; adapter should derive a per-turn delta."""

        async def _test():
            adapter = CodexAdapter(model="gpt-5.4")

            first_proc = AsyncMock()
            first_proc.returncode = 0
            first_proc.stdout = _make_reader(
                '{"type":"thread.started","thread_id":"t1"}\n'
                '{"type":"turn.started"}\n'
                '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"OK"}}\n'
                '{"type":"turn.completed","usage":{"input_tokens":12715,"cached_input_tokens":0,"output_tokens":33}}\n'
            )
            first_proc.stderr = _make_reader("")
            first_proc.wait = AsyncMock(return_value=0)
            first_proc.kill = MagicMock()

            second_proc = AsyncMock()
            second_proc.returncode = 0
            second_proc.stdout = _make_reader(
                '{"type":"thread.started","thread_id":"t1"}\n'
                '{"type":"turn.started"}\n'
                '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"No active work in progress."}}\n'
                '{"type":"turn.completed","usage":{"input_tokens":25470,"cached_input_tokens":12672,"output_tokens":97}}\n'
            )
            second_proc.stderr = _make_reader("")
            second_proc.wait = AsyncMock(return_value=0)
            second_proc.kill = MagicMock()

            with patch(
                "asyncio.create_subprocess_exec",
                side_effect=[first_proc, second_proc],
            ):
                first = await adapter.send("Reply with exactly OK")
                second = await adapter.resume("/status")

            assert first.input_tokens == 12715
            assert first.turn_input_tokens == 12715
            assert first.turn_cached_input_tokens == 0
            assert first.turn_output_tokens == 33
            assert first.context_tokens_reliable is False

            assert second.input_tokens == 25470  # cumulative
            assert second.turn_input_tokens == 12755
            assert second.turn_cached_input_tokens == 12672
            assert second.turn_output_tokens == 64
            assert second.context_tokens_reliable is True

        asyncio.run(_test())



# ── Context percent ──────────────────────────────────────────


class TestContextPercent:
    def test_claude_context_percent_normalized(self):
        """Haiku: 200k window, threshold=0.45, limit=90k.
        occupancy_tokens=27000, text="" → 27000 / 90k * 100 = 30%."""
        adapter = ClaudeAdapter(model="claude-haiku-4-5")
        resp = AdapterResponse(
            text="",
            occupancy_tokens=27_000,
            context_window=200_000,
        )
        pct = adapter.context_percent(resp)
        assert pct == pytest.approx(30.0)

    def test_claude_context_percent_zero_tokens(self):
        adapter = ClaudeAdapter(model="claude-haiku-4-5")
        resp = AdapterResponse(
            text="",
            input_tokens=0,
            output_tokens=0,
            tool_result_tokens_estimate=0,
            context_window=200_000,
        )
        pct = adapter.context_percent(resp)
        assert pct == pytest.approx(0.0)

    def test_codex_context_percent(self):
        """gpt-5.4: 272k window, threshold=0.45, limit=122400.
        61200 / 122400 * 100 = 50%."""
        adapter = CodexAdapter(model="gpt-5.4")
        resp = AdapterResponse(
            text="",
            input_tokens=120_000,
            turn_input_tokens=61_200,
            output_tokens=0,
            tool_result_tokens_estimate=0,
            context_window=272_000,
        )
        pct = adapter.context_percent(resp)
        assert pct == pytest.approx(50.0)

    def test_codex_context_percent_zero(self):
        adapter = CodexAdapter(model="gpt-5.4")
        resp = AdapterResponse(text="", context_window=272_000)
        assert adapter.context_percent(resp) == 0.0

    def test_codex_context_percent_uses_last_turn_input_only(self):
        """Codex context_percent should use last-turn input only.

        Fixture: first turn cumulative input_tokens=100000, output_tokens=22400,
        aggregated_output=9600 chars → tool_result_tokens_estimate=2400.
        Since this is the first turn, there is no trusted baseline yet.
        output_tokens and tool-result estimates must not force a fake
        context percentage from the raw cumulative total."""

        async def _test():
            adapter = CodexAdapter(model="gpt-5.4")

            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            fixture_data = _load_fixture("codex-context-percent.jsonl")
            mock_proc.stdout = _make_reader(fixture_data)
            mock_proc.stderr = _make_reader("")
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            assert resp.tool_result_tokens_estimate == 2400
            assert resp.turn_input_tokens == 100000
            assert resp.context_tokens_reliable is False
            assert adapter.context_percent(resp) == 0.0

        asyncio.run(_test())

    def test_claude_context_percent_ignores_tool_result_tokens(self):
        """Claude context_percent uses occupancy_tokens; tool_result_tokens_estimate is ignored.

        occupancy_tokens=180_000, tool_result_tokens_estimate=20_000, text="".
        Expected: 180_000 / (1M * 0.20) * 100 = 90.0 (not 100.0)."""
        adapter = ClaudeAdapter(model="claude-opus-4-6")
        resp = AdapterResponse(
            text="",
            occupancy_tokens=180_000,
            input_tokens=180_000,
            output_tokens=15_000,
            tool_result_tokens_estimate=20_000,
            context_window=1_000_000,
        )
        assert adapter.context_percent(resp) == pytest.approx(90.0)

    def test_claude_context_percent_uses_occupancy_from_fixture(self):
        """Claude context_percent uses occupancy_tokens from assistant event usage.

        Fixture claude-first-msg.jsonl assistant events have:
          input_tokens=9, cache_creation_input_tokens=55680,
          cache_read_input_tokens=0.
        occupancy_tokens = 9 + 55680 + 0 = 55689.
        resp.text = "hello world" (11 chars → 2 tokens at //4).
        Projected = 55689 + 2 = 55691.
        pct = 55691 / (200000 * 0.45) * 100 ≈ 61.88%."""

        async def _test():
            adapter = ClaudeAdapter(model="claude-haiku-4-5")

            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            fixture_data = _load_fixture("claude-first-msg.jsonl")
            mock_proc.stdout = _make_reader(fixture_data)
            mock_proc.stderr = _make_reader("")
            mock_proc.stdin = AsyncMock()
            mock_proc.stdin.write = MagicMock()
            mock_proc.stdin.drain = AsyncMock()
            mock_proc.stdin.close = MagicMock()
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            assert resp.input_tokens == 9
            assert resp.cache_creation_tokens == 55680
            assert resp.cache_read_tokens == 0
            assert resp.occupancy_tokens == 55689
            projected = 55689 + len(resp.text) // 4
            expected = (projected / (200000 * 0.45)) * 100
            assert adapter.context_percent(resp) == pytest.approx(expected)

        asyncio.run(_test())

    def test_claude_send_captures_occupancy_from_last_assistant_event(self):
        """occupancy_tokens must reflect the LAST assistant event's usage snapshot,
        not the cumulative result event.

        Stream: two assistant events with growing usage snapshots, then a
        cumulative result event with much larger totals.
        Expected: resp.occupancy_tokens == 104965 (from last assistant event:
        input_tokens=1 + cache_creation=114 + cache_read=104850)."""

        async def _test():
            adapter = ClaudeAdapter(model="claude-sonnet-4-6")

            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            # Simulate a multi-turn tool loop:
            # assistant(1) -> tool_use -> tool_result -> assistant(2) -> result
            jsonl = "\n".join([
                # First assistant event with early usage snapshot
                json.dumps({
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "tool_use", "id": "t1",
                                     "name": "Read", "input": {}}],
                        "usage": {
                            "input_tokens": 1,
                            "cache_creation_input_tokens": 50,
                            "cache_read_input_tokens": 10000,
                        },
                    },
                }),
                # Tool result
                json.dumps({
                    "type": "user",
                    "message": {"role": "user", "content": [{
                        "type": "tool_result",
                        "tool_use_id": "t1",
                        "content": "file contents here",
                    }]},
                }),
                # Last assistant event -- THIS is the occupancy signal
                json.dumps({
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "Done."}],
                        "usage": {
                            "input_tokens": 1,
                            "cache_creation_input_tokens": 114,
                            "cache_read_input_tokens": 104850,
                        },
                    },
                }),
                # Cumulative result event -- NOT the occupancy signal
                json.dumps({
                    "type": "result",
                    "result": "Done.",
                    "usage": {
                        "input_tokens": 7939,
                        "output_tokens": 500,
                        "cache_creation_input_tokens": 91065,
                        "cache_read_input_tokens": 1281129,
                    },
                    "modelUsage": {
                        "claude-sonnet-4-6": {"contextWindow": 1000000},
                    },
                }),
            ]) + "\n"

            mock_proc.stdout = _make_reader(jsonl)
            mock_proc.stderr = _make_reader("")
            mock_proc.stdin = AsyncMock()
            mock_proc.stdin.write = MagicMock()
            mock_proc.stdin.drain = AsyncMock()
            mock_proc.stdin.close = MagicMock()
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            # occupancy_tokens = last assistant usage snapshot footprint
            # 1 + 114 + 104850 = 104965
            assert resp.occupancy_tokens == 104965

        asyncio.run(_test())


    def test_claude_context_percent_uses_occupancy_snapshot_and_visible_text(self):
        """Claude context_percent must use occupancy_tokens (not cumulative result fields)
        and project visible text, ignoring output_tokens and tool_result_tokens_estimate.

        Given: occupancy_tokens=105000, text="x"*2000 (500 tokens at //4),
               input_tokens=7939, cache_creation_tokens=91065,
               cache_read_tokens=1281129, tool_result_tokens_estimate=50000,
               context_window=1000000.
        Expected: base=105000, projected=105000+500=105500,
                  pct = 105500 / (1M * 0.20) * 100 = 52.75%
        Bug (before fix): uses cumulative result fields → ~715%."""
        adapter = ClaudeAdapter(model="claude-opus-4-6")
        resp = AdapterResponse(
            text="x" * 2000,
            occupancy_tokens=105_000,
            input_tokens=7_939,
            cache_creation_tokens=91_065,
            cache_read_tokens=1_281_129,
            tool_result_tokens_estimate=50_000,
            context_window=1_000_000,
        )
        pct = adapter.context_percent(resp)
        assert pct == pytest.approx(52.75)

# ── AdapterResponse construction ─────────────────────────────


class TestAdapterResponse:
    def test_defaults(self):
        r = AdapterResponse(text="hello")
        assert r.tool_summaries == []
        assert r.raw_output == ""
        assert r.exit_code == 0
        assert r.session_id == ""

    def test_all_fields(self):
        r = AdapterResponse(
            text="response",
            tool_summaries=[ToolSummary(id="t1", name="Read", input_preview="f.py")],
            raw_output="raw",
            exit_code=0,
            input_tokens=100,
            output_tokens=50,
            cache_read_tokens=30,
            cache_creation_tokens=20,
            context_window=200_000,
            session_id="sid",
        )
        assert r.input_tokens == 100
        assert len(r.tool_summaries) == 1


# ── Command construction ─────────────────────────────────────


class TestCommandConstruction:
    def test_claude_send_cmd(self):
        c = ClaudeAdapter(model="claude-haiku-4-5", tools=["Read", "Grep"])
        c.session_id = "test-sid"
        cmd = c._build_cmd(resume=False)
        assert cmd[:2] == ["claude", "-p"]
        assert "--session-id" in cmd
        assert "test-sid" in cmd
        assert "--verbose" in cmd
        assert "--output-format" in cmd
        idx = cmd.index("--tools")
        assert cmd[idx + 1] == "Read,Grep"

    def test_claude_resume_cmd(self):
        c = ClaudeAdapter(model="claude-haiku-4-5")
        c.session_id = "test-sid"
        cmd = c._build_cmd(resume=True)
        assert "--resume" in cmd
        assert "--session-id" not in cmd

    def test_claude_settings_include_work_dir_and_project_context(self):
        c = ClaudeAdapter(
            model="claude-haiku-4-5",
            cwd="/repo/botference",
            add_dirs=["/repo"],
            settings=claude_plan_settings_for_work_dir("/repo", "/repo/botference"),
        )
        c.session_id = "test-sid"
        cmd = c._build_cmd(resume=False)
        assert "--settings" in cmd
        assert "--add-dir" in cmd
        assert cmd[cmd.index("--add-dir") + 1] == "/repo"
        settings = json.loads(cmd[cmd.index("--settings") + 1])
        assert settings["permissions"]["defaultMode"] == "dontAsk"
        assert "Bash" in settings["permissions"]["allow"]
        assert "Edit(//repo/botference/**)" in settings["permissions"]["allow"]
        assert settings["sandbox"]["enabled"] is True
        assert settings["sandbox"]["allowUnsandboxedCommands"] is False

    def test_codex_send_cmd(self):
        x = CodexAdapter(model="gpt-5.4")
        cmd = x._build_send_cmd("hello")
        assert cmd[:2] == ["codex", "exec"]
        assert "--sandbox" in cmd
        assert "--json" in cmd
        assert "--skip-git-repo-check" in cmd
        assert cmd[-1] == "hello"

    def test_codex_resume_cmd(self):
        x = CodexAdapter()
        x.thread_id = "tid-abc"
        cmd = x._build_resume_cmd("follow up")
        assert cmd[2] == "resume"
        assert cmd[3] == "tid-abc"
        assert cmd[-1] == "follow up"

    def test_codex_send_cmd_includes_cd_when_configured(self):
        x = CodexAdapter(model="gpt-5.4", cwd="/repo/botference")
        cmd = x._build_send_cmd("hello")
        assert "--cd" in cmd
        assert cmd[cmd.index("--cd") + 1] == "/repo/botference"

    def test_codex_resume_cmd_includes_cd_when_configured(self):
        x = CodexAdapter(cwd="/repo/botference")
        x.thread_id = "tid-abc"
        cmd = x._build_resume_cmd("follow up")
        assert "--cd" in cmd
        assert cmd[cmd.index("--cd") + 1] == "/repo/botference"

    def test_plan_allowed_tools_cover_work_tree(self):
        allowed = plan_allowed_tools_for_work_dir(
            "/repo",
            "/repo/botference",
        )
        assert "Bash" in allowed
        assert "Edit(/botference/*)" in allowed
        assert "Edit(/botference/**)" in allowed
        assert "Write(/botference/*)" in allowed
        assert "MultiEdit(/botference/**)" in allowed

    def test_plan_allowed_tools_keep_root_fallback_narrow(self):
        allowed = plan_allowed_tools_for_work_dir(
            "/repo",
            "/repo",
        )
        assert "Edit(/implementation-plan.md)" in allowed
        assert "Write(/inbox.md)" in allowed
        assert "Edit(/repo/**)" not in allowed

    def test_claude_plan_settings_keep_root_fallback_narrow(self):
        settings = claude_plan_settings_for_work_dir("/repo", "/repo")
        allow = settings["permissions"]["allow"]
        assert settings["permissions"]["defaultMode"] == "dontAsk"
        assert "Bash" not in allow
        assert "Edit(//repo/implementation-plan.md)" in allow
        assert "Edit(//repo/inbox.md)" in allow

# ── Error paths ──────────────────────────────────────────────


class TestErrorPaths:
    def test_claude_resume_without_session_raises(self):
        c = ClaudeAdapter()
        with pytest.raises(RuntimeError, match="No session"):
            asyncio.run(c.resume("msg"))

    def test_codex_resume_without_thread_raises(self):
        x = CodexAdapter()
        with pytest.raises(RuntimeError, match="No thread"):
            asyncio.run(x.resume("msg"))

    def test_claude_cli_not_found(self):
        async def _test():
            c = ClaudeAdapter()
            with patch(
                "asyncio.create_subprocess_exec",
                side_effect=FileNotFoundError,
            ):
                resp = await c.send("test")
            assert resp.exit_code == 127
            assert "not found" in resp.text

        asyncio.run(_test())

    def test_codex_cli_not_found(self):
        async def _test():
            x = CodexAdapter()
            with patch(
                "asyncio.create_subprocess_exec",
                side_effect=FileNotFoundError,
            ):
                resp = await x.send("test")
            assert resp.exit_code == 127
            assert "not found" in resp.text

        asyncio.run(_test())


# ── Raw output captures stderr ───────────────────────────────


class TestRawOutputCapture:
    def test_stderr_appears_in_raw_output(self):
        async def _test():
            adapter = CodexAdapter()

            mock_proc = AsyncMock()
            mock_proc.returncode = 0
            jsonl = (
                '{"type":"thread.started","thread_id":"t1"}\n'
                '{"type":"turn.started"}\n'
                '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"ok"}}\n'
                '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}\n'
            )
            mock_proc.stdout = _make_reader(jsonl)
            mock_proc.stderr = _make_reader("warning: something went wrong\n")
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            assert "[stderr]" in resp.raw_output
            assert "something went wrong" in resp.raw_output

        asyncio.run(_test())

    def test_non_json_stdout_in_raw_output(self):
        """Non-JSON stdout lines should appear in raw_output for debugging."""
        async def _test():
            adapter = CodexAdapter()

            mock_proc = AsyncMock()
            mock_proc.returncode = 0
            # Mix of JSON and non-JSON stdout
            stdout = (
                'Loading configuration...\n'
                '{"type":"thread.started","thread_id":"t1"}\n'
                '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"ok"}}\n'
                '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}\n'
            )
            mock_proc.stdout = _make_reader(stdout)
            mock_proc.stderr = _make_reader("")
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            assert "Loading configuration..." in resp.raw_output

        asyncio.run(_test())


# ── Tool result token estimation ────────────────────────────


class TestToolResultTokenEstimate:
    """Task 1: tool_result_tokens_estimate on AdapterResponse."""

    def test_claude_tool_result_estimate(self):
        """Claude adapter should estimate tokens from tool_result content blocks."""

        async def _test():
            adapter = ClaudeAdapter(model="claude-sonnet-4-6")

            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            # Known tool_result content — 400 chars ≈ 100 tokens at //4
            tool_result_content = "x" * 400

            jsonl = "\n".join([
                json.dumps({
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [{
                        "type": "tool_use",
                        "id": "toolu_01",
                        "name": "Read",
                        "input": {"file_path": "foo.py"},
                    }]},
                }),
                json.dumps({
                    "type": "user",
                    "message": {"role": "user", "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_01",
                        "content": tool_result_content,
                    }]},
                }),
                json.dumps({
                    "type": "result",
                    "result": "Done.",
                    "usage": {
                        "input_tokens": 5000,
                        "output_tokens": 200,
                    },
                    "modelUsage": {
                        "claude-sonnet-4-6": {"contextWindow": 1_000_000},
                    },
                }),
            ]) + "\n"

            mock_proc.stdout = _make_reader(jsonl)
            mock_proc.stderr = _make_reader("")
            mock_proc.stdin = AsyncMock()
            mock_proc.stdin.write = MagicMock()
            mock_proc.stdin.drain = AsyncMock()
            mock_proc.stdin.close = MagicMock()
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            assert resp.tool_result_tokens_estimate > 0
            # 400 chars // 4 = 100 tokens
            assert resp.tool_result_tokens_estimate == 100

        asyncio.run(_test())

    def test_claude_multiple_tool_results_accumulate(self):
        """Multiple tool_result blocks should sum their estimates."""

        async def _test():
            adapter = ClaudeAdapter(model="claude-sonnet-4-6")

            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            content_a = "a" * 200  # 50 tokens
            content_b = "b" * 800  # 200 tokens

            jsonl = "\n".join([
                json.dumps({
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [
                        {"type": "tool_use", "id": "t1", "name": "Read", "input": {}},
                        {"type": "tool_use", "id": "t2", "name": "Grep", "input": {}},
                    ]},
                }),
                json.dumps({
                    "type": "user",
                    "message": {"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": "t1", "content": content_a},
                        {"type": "tool_result", "tool_use_id": "t2", "content": content_b},
                    ]},
                }),
                json.dumps({
                    "type": "result",
                    "result": "Done.",
                    "usage": {"input_tokens": 5000, "output_tokens": 200},
                }),
            ]) + "\n"

            mock_proc.stdout = _make_reader(jsonl)
            mock_proc.stderr = _make_reader("")
            mock_proc.stdin = AsyncMock()
            mock_proc.stdin.write = MagicMock()
            mock_proc.stdin.drain = AsyncMock()
            mock_proc.stdin.close = MagicMock()
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            # 50 + 200 = 250
            assert resp.tool_result_tokens_estimate == 250

        asyncio.run(_test())

    def test_claude_edit_tool_result_uses_structured_diff_blocks(self):
        """Claude Edit tool uses the invocation payload to build a diff block."""

        async def _test():
            adapter = ClaudeAdapter(model="claude-sonnet-4-6")

            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            jsonl = "\n".join([
                json.dumps({
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [{
                        "type": "tool_use",
                        "id": "toolu_edit",
                        "name": "Edit",
                        "input": {
                            "file_path": "src/app.py",
                            "old_string": "old_name = 1\n",
                            "new_string": "new_name = 1\n",
                        },
                    }]},
                }),
                json.dumps({
                    "type": "user",
                    "message": {"role": "user", "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_edit",
                        "content": "Updated src/app.py successfully.",
                    }]},
                }),
                json.dumps({
                    "type": "result",
                    "result": "Done.",
                    "usage": {"input_tokens": 5000, "output_tokens": 200},
                }),
            ]) + "\n"

            mock_proc.stdout = _make_reader(jsonl)
            mock_proc.stderr = _make_reader("")
            mock_proc.stdin = AsyncMock()
            mock_proc.stdin.write = MagicMock()
            mock_proc.stdin.drain = AsyncMock()
            mock_proc.stdin.close = MagicMock()
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            assert len(resp.tool_summaries) == 1
            assert any(
                block["type"] == "diff"
                for block in resp.tool_summaries[0].output_blocks
            )

        asyncio.run(_test())

    def test_claude_write_tool_result_uses_structured_code_blocks(self):
        """Claude Write tool uses the invocation payload to build a code block."""

        async def _test():
            adapter = ClaudeAdapter(model="claude-sonnet-4-6")

            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            jsonl = "\n".join([
                json.dumps({
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [{
                        "type": "tool_use",
                        "id": "toolu_write",
                        "name": "Write",
                        "input": {
                            "file_path": "src/app.py",
                            "content": "def parse_input(raw: str):\n    return raw\n",
                        },
                    }]},
                }),
                json.dumps({
                    "type": "user",
                    "message": {"role": "user", "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_write",
                        "content": "Wrote src/app.py successfully.",
                    }]},
                }),
                json.dumps({
                    "type": "result",
                    "result": "Done.",
                    "usage": {"input_tokens": 5000, "output_tokens": 200},
                }),
            ]) + "\n"

            mock_proc.stdout = _make_reader(jsonl)
            mock_proc.stderr = _make_reader("")
            mock_proc.stdin = AsyncMock()
            mock_proc.stdin.write = MagicMock()
            mock_proc.stdin.drain = AsyncMock()
            mock_proc.stdin.close = MagicMock()
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            assert len(resp.tool_summaries) == 1
            assert any(
                block["type"] == "code"
                for block in resp.tool_summaries[0].output_blocks
            )

        asyncio.run(_test())

    def test_codex_tool_result_estimate(self):
        """Codex adapter should estimate tokens from command_execution aggregated_output."""

        async def _test():
            adapter = CodexAdapter(model="gpt-5.4")

            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            output_text = "y" * 600  # 150 tokens

            jsonl = "\n".join([
                json.dumps({"type": "thread.started", "thread_id": "t1"}),
                json.dumps({"type": "turn.started"}),
                json.dumps({
                    "type": "item.completed",
                    "item": {
                        "id": "item_1",
                        "type": "command_execution",
                        "command": "cat foo.py",
                        "aggregated_output": output_text,
                        "exit_code": 0,
                        "status": "completed",
                    },
                }),
                json.dumps({
                    "type": "turn.completed",
                    "usage": {
                        "input_tokens": 5000,
                        "cached_input_tokens": 0,
                        "output_tokens": 200,
                    },
                }),
            ]) + "\n"

            mock_proc.stdout = _make_reader(jsonl)
            mock_proc.stderr = _make_reader("")
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            assert resp.tool_result_tokens_estimate > 0
            # 600 chars // 4 = 150 tokens
            assert resp.tool_result_tokens_estimate == 150

        asyncio.run(_test())

    def test_no_tools_zero_estimate(self):
        """Response without tool usage should have zero estimate."""
        resp = AdapterResponse(text="hello")
        assert resp.tool_result_tokens_estimate == 0

    def test_codex_diff_output_populates_structured_blocks(self):
        """Diff-like command output should keep structured blocks for the UI."""

        async def _test():
            adapter = CodexAdapter(model="gpt-5.4")

            mock_proc = AsyncMock()
            mock_proc.returncode = 0

            diff_output = "@@ -1,1 +1,1 @@\n-old_name = 1\n+new_name = 1"

            jsonl = "\n".join([
                json.dumps({"type": "thread.started", "thread_id": "t1"}),
                json.dumps({
                    "type": "item.completed",
                    "item": {
                        "id": "item_1",
                        "type": "command_execution",
                        "command": "git diff -- src/app.py",
                        "aggregated_output": diff_output,
                        "exit_code": 0,
                        "status": "completed",
                    },
                }),
                json.dumps({
                    "type": "turn.completed",
                    "usage": {
                        "input_tokens": 5000,
                        "cached_input_tokens": 0,
                        "output_tokens": 200,
                    },
                }),
            ]) + "\n"

            mock_proc.stdout = _make_reader(jsonl)
            mock_proc.stderr = _make_reader("")
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                resp = await adapter.send("test")

            assert len(resp.tool_summaries) == 1
            assert any(
                block["type"] == "diff"
                for block in resp.tool_summaries[0].output_blocks
            )

        asyncio.run(_test())


# ── Normalized context percent (Task 2) ─────────────────────


class TestNormalizedContextPercent:
    """Task 2: context_percent returns % of yield limit, not % of raw window.

    Claude formula: occupancy_tokens + text//4, divided by (window * threshold) * 100.
    Codex formula: turn_input_tokens / (window * threshold) * 100.
    Threshold is 0.20 for window >= 1M, 0.45 for window < 1M.
    100% means "yield now".
    """

    def test_claude_100pct_means_yield(self):
        """Claude: occupancy_tokens=200000 → 200000 / (1M * 0.20) * 100 = 100.0 → yield now."""
        adapter = ClaudeAdapter(model="claude-opus-4-6")
        resp = AdapterResponse(
            text="",
            occupancy_tokens=200_000,
            context_window=1_000_000,
        )
        pct = adapter.context_percent(resp)
        assert pct == pytest.approx(100.0)

    def test_codex_100pct_means_yield(self):
        """Codex 100% from last-turn input only: 122.4k / (272k * 0.45) = 100.0."""
        adapter = CodexAdapter(model="gpt-5.4")
        resp = AdapterResponse(
            text="",
            input_tokens=180_000,
            turn_input_tokens=122_400,
            output_tokens=20_000,
            tool_result_tokens_estimate=2_400,
            context_window=272_000,
        )
        pct = adapter.context_percent(resp)
        assert pct == pytest.approx(100.0)

    def test_small_window_uses_45pct_threshold(self):
        """context_window < 1M → threshold=0.45: 45k / (200k * 0.45) = 50%."""
        adapter = ClaudeAdapter(model="claude-haiku-4-5")
        resp = AdapterResponse(
            text="",
            occupancy_tokens=45_000,
            context_window=200_000,
        )
        pct = adapter.context_percent(resp)
        assert pct == pytest.approx(50.0)

    def test_should_stop_uses_percent_of_limit(self):
        """should_stop_for_context(180k, 15k, opus, 5k) → True (same 100% case)."""
        from botference_agent import should_stop_for_context
        assert should_stop_for_context(180_000, 15_000, "claude-opus-4-6", 5_000) is True

    def test_tool_heavy_turn_does_not_inflate_claude_percent(self):
        """Claude: tool_result_tokens_estimate does NOT inflate context_percent.

        Two responses with occupancy_tokens=100k, context_window=1M:
        - no tools:   100000 / (1M * 0.20) * 100 = 50.0%
        - with tools:  100000 / (1M * 0.20) * 100 = 50.0% (same)
        Under old semantics tool_result would have inflated to 75%."""
        adapter = ClaudeAdapter(model="claude-opus-4-6")
        resp_no_tools = AdapterResponse(
            text="",
            occupancy_tokens=100_000,
            context_window=1_000_000,
        )
        resp_with_tools = AdapterResponse(
            text="",
            occupancy_tokens=100_000,
            tool_result_tokens_estimate=50_000,
            context_window=1_000_000,
        )
        pct_no_tools = adapter.context_percent(resp_no_tools)
        pct_with_tools = adapter.context_percent(resp_with_tools)

        assert pct_no_tools == pytest.approx(50.0)
        assert pct_with_tools == pytest.approx(50.0)


# ── context_tokens (raw display value) ───────────────────────


class TestContextTokens:
    """context_tokens() returns the raw token count for display,
    independent of the yield-threshold percentage."""

    def test_claude_uses_occupancy_tokens(self):
        adapter = ClaudeAdapter(model="claude-opus-4-6")
        resp = AdapterResponse(
            text="",
            occupancy_tokens=105_000,
            input_tokens=7_939,
            cache_creation_tokens=91_065,
            cache_read_tokens=1_281_129,
            context_window=1_000_000,
        )
        assert adapter.context_tokens(resp) == 105_000

    def test_claude_fallback_includes_cache_read(self):
        """When occupancy_tokens is 0, fallback sums all input components."""
        adapter = ClaudeAdapter(model="claude-opus-4-6")
        resp = AdapterResponse(
            text="",
            occupancy_tokens=0,
            input_tokens=5_000,
            cache_creation_tokens=10_000,
            cache_read_tokens=85_000,
            context_window=1_000_000,
        )
        # 5000 + 10000 + 85000 = 100000
        assert adapter.context_tokens(resp) == 100_000

    def test_codex_uses_turn_input_tokens(self):
        adapter = CodexAdapter(model="gpt-5.4")
        resp = AdapterResponse(
            text="",
            input_tokens=25_470,
            turn_input_tokens=12_755,
            output_tokens=97,
            context_window=272_000,
        )
        assert adapter.context_tokens(resp) == 12_755

    def test_codex_fallback_to_input_tokens(self):
        """Without a prior baseline, Codex context display is unavailable."""
        adapter = CodexAdapter(model="gpt-5.4")
        resp = AdapterResponse(
            text="",
            input_tokens=12_715,
            turn_input_tokens=0,
            context_tokens_reliable=False,
            output_tokens=33,
            context_window=272_000,
        )
        assert adapter.context_tokens(resp) is None


class TestCodexStdinDevnull:
    """Codex subprocess must use stdin=DEVNULL to prevent Ink bridge deadlock.

    Without this, codex exec inherits a pipe stdin from the Ink bridge
    and blocks waiting for EOF, causing a 300s timeout.
    """

    def test_codex_send_uses_devnull_stdin(self):
        async def _test():
            adapter = CodexAdapter()

            mock_proc = AsyncMock()
            mock_proc.returncode = 0
            jsonl = (
                '{"type":"thread.started","thread_id":"t1"}\n'
                '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"ok"}}\n'
                '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}\n'
            )
            mock_proc.stdout = _make_reader(jsonl)
            mock_proc.stderr = _make_reader("")
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.kill = MagicMock()

            with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
                await adapter.send("test prompt")

            _args, kwargs = mock_exec.call_args
            assert kwargs.get("stdin") == asyncio.subprocess.DEVNULL, (
                "Codex must use stdin=DEVNULL to prevent Ink bridge deadlock"
            )

        asyncio.run(_test())
