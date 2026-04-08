"""
Tests for botference.py — controller logic for botference mode.

Tests the deterministic parsing, routing, transcript management,
caucus footer parsing, and Botference.handle_input dispatch with
mock adapters and UI.
"""

from __future__ import annotations

import json
import sys
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from cli_adapters import AdapterResponse, ToolSummary
from botference import (
    AutoRouter,
    CaucusFooter,
    Botference,
    InputKind,
    ParsedInput,
    Transcript,
    _TERMINAL_STATUSES,
    parse_input,
)
from botference_ui import RoomMode, StatusSnapshot
from paths import BotferencePaths
from render_blocks import parse_render_blocks


# ── parse_input ───────────────────────────────────────────


class TestParseInput:
    def test_at_claude_message(self):
        p = parse_input("@claude What do you think?")
        assert p.kind is InputKind.MESSAGE
        assert p.target == "@claude"
        assert p.body == "What do you think?"

    def test_at_codex_message(self):
        p = parse_input("@codex Review this file")
        assert p.kind is InputKind.MESSAGE
        assert p.target == "@codex"
        assert p.body == "Review this file"

    def test_at_all_message(self):
        p = parse_input("@all Here's the plan context")
        assert p.kind is InputKind.MESSAGE
        assert p.target == "@all"
        assert p.body == "Here's the plan context"

    def test_mention_case_insensitive(self):
        p = parse_input("@Claude Hello")
        assert p.target == "@claude"

    def test_plain_text_no_target(self):
        p = parse_input("Just a plain message")
        assert p.kind is InputKind.MESSAGE
        assert p.target == ""
        assert p.body == "Just a plain message"

    def test_empty_string(self):
        p = parse_input("")
        assert p.kind is InputKind.MESSAGE
        assert p.body == ""

    def test_whitespace_only(self):
        p = parse_input("   ")
        assert p.kind is InputKind.MESSAGE
        assert p.body == ""

    def test_slash_caucus(self):
        p = parse_input("/caucus Should we use microservices?")
        assert p.kind is InputKind.CAUCUS
        assert p.body == "Should we use microservices?"

    def test_slash_caucus_no_arg(self):
        p = parse_input("/caucus")
        assert p.kind is InputKind.CAUCUS
        assert p.body == ""

    def test_slash_lead(self):
        p = parse_input("/lead @claude")
        assert p.kind is InputKind.LEAD
        assert p.body == "@claude"

    def test_slash_draft(self):
        p = parse_input("/draft")
        assert p.kind is InputKind.DRAFT
        assert p.body == ""

    def test_slash_draft_with_rounds(self):
        p = parse_input("/draft 2")
        assert p.kind is InputKind.DRAFT
        assert p.body == "2"

    def test_slash_finalize(self):
        p = parse_input("/finalize")
        assert p.kind is InputKind.FINALIZE

    def test_slash_resume(self):
        p = parse_input("/resume latest")
        assert p.kind is InputKind.RESUME
        assert p.body == "latest"

    def test_slash_permissions(self):
        p = parse_input("/permissions")
        assert p.kind is InputKind.PERMISSIONS

    def test_slash_status(self):
        p = parse_input("/status")
        assert p.kind is InputKind.STATUS

    def test_slash_quit(self):
        p = parse_input("/quit")
        assert p.kind is InputKind.QUIT

    def test_unknown_slash_becomes_message(self):
        p = parse_input("/unknown command")
        assert p.kind is InputKind.MESSAGE
        assert p.body == "/unknown command"

    def test_at_mention_with_no_body(self):
        p = parse_input("@claude")
        assert p.kind is InputKind.MESSAGE
        assert p.target == "@claude"
        assert p.body == ""


# ── AutoRouter ────────────────────────────────────────────


class TestAutoRouter:
    def test_first_plain_text_routes_to_all(self):
        r = AutoRouter()
        p = ParsedInput(kind=InputKind.MESSAGE, body="hello")
        assert r.resolve(p) == "@all"

    def test_stays_all_after_all(self):
        r = AutoRouter()
        r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="1"))
        route = r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="2"))
        assert route == "@all"

    def test_explicit_at_all_stays_all(self):
        r = AutoRouter()
        r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="1",
                               target="@all"))
        route = r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="2"))
        assert route == "@all"

    def test_directed_mention_changes_route(self):
        r = AutoRouter()
        r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="1"))  # @all
        r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="2",
                               target="@claude"))
        route = r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="3"))
        assert route == "@claude"

    def test_directed_mention_on_first_turn(self):
        r = AutoRouter()
        route = r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="hi",
                                       target="@codex"))
        assert route == "@codex"

    def test_switching_from_claude_to_codex(self):
        r = AutoRouter()
        r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="1",
                               target="@claude"))
        r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="2",
                               target="@codex"))
        route = r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="3"))
        assert route == "@codex"

    def test_at_all_resets_after_directed(self):
        r = AutoRouter()
        r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="1",
                               target="@claude"))
        r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="2",
                               target="@all"))
        route = r.resolve(ParsedInput(kind=InputKind.MESSAGE, body="3"))
        assert route == "@all"


# ── Transcript ────────────────────────────────────────────


class TestTranscript:
    def test_add_increments_counter(self):
        t = Transcript()
        r0 = t.add("user", "hello")
        r1 = t.add("claude", "hi back")
        assert r0.turn_index == 0
        assert r1.turn_index == 1
        assert len(t.entries) == 2

    def test_context_since_no_unseen(self):
        t = Transcript()
        t.add("user", "hello")
        t.add("claude", "hi")
        t.mark_seen("claude")
        ctx = t.context_since("claude", "next question")
        # Should contain user message but no "Room update"
        assert "[User says:]" in ctx
        assert "next question" in ctx

    def test_context_since_with_unseen_entries(self):
        t = Transcript()
        t.add("user", "hello both")
        t.add("claude", "I'll start")
        t.mark_seen("claude")
        t.add("codex", "Good idea")
        t.add("user", "what next?")
        ctx = t.context_since("claude", "continue please")
        assert "[Room update since your last response]" in ctx
        assert "Good idea" in ctx
        assert "what next?" in ctx
        assert "[User says:]" in ctx
        assert "continue please" in ctx

    def test_context_since_excludes_own_entries(self):
        t = Transcript()
        t.add("claude", "I said something")
        t.mark_seen("claude")
        t.add("claude", "I said more")  # this shouldn't appear
        ctx = t.context_since("claude", "user msg")
        assert "I said more" not in ctx

    def test_context_since_includes_tool_summaries(self):
        t = Transcript()
        tools = [ToolSummary(
            id="t1", name="read_file",
            input_preview="src/main.py",
            output_preview="142 lines",
        )]
        t.add("codex", "Let me check", tools)
        ctx = t.context_since("claude", "and?")
        assert "read_file" in ctx
        assert "142 lines" in ctx

    def test_context_since_never_seen(self):
        """Model that has never been marked seen gets all entries."""
        t = Transcript()
        t.add("user", "first")
        t.add("claude", "response")
        ctx = t.context_since("codex", "hi")
        assert "first" in ctx
        assert "response" in ctx

    def test_mark_seen_updates_correctly(self):
        t = Transcript()
        t.add("user", "ALPHA_MSG")
        t.mark_seen("claude")
        t.add("user", "BRAVO_MSG")
        t.add("user", "CHARLIE_MSG")
        t.mark_seen("claude")
        t.add("user", "DELTA_MSG")
        ctx = t.context_since("claude", "")
        assert "ALPHA_MSG" not in ctx
        assert "BRAVO_MSG" not in ctx
        assert "CHARLIE_MSG" not in ctx
        assert "DELTA_MSG" in ctx


# ── CaucusFooter ──────────────────────────────────────────


class TestCaucusFooter:
    def test_parse_fenced_json(self):
        text = (
            "I think we should go with option A.\n\n"
            '```json\n'
            '{"status": "continue", "handoff_to": "codex", '
            '"writer_vote": "claude", "summary": "leaning toward A"}\n'
            '```'
        )
        f = CaucusFooter.parse(text)
        assert f is not None
        assert f.status == "continue"
        assert f.handoff_to == "codex"
        assert f.writer_vote == "claude"
        assert f.summary == "leaning toward A"
        assert f.is_terminal is False

    def test_parse_raw_json(self):
        text = (
            "Agreed on the approach.\n"
            '{"status": "ready_to_draft", "handoff_to": "user", '
            '"writer_vote": "codex", "summary": "consensus reached"}'
        )
        f = CaucusFooter.parse(text)
        assert f is not None
        assert f.status == "ready_to_draft"
        assert f.is_terminal is True

    def test_parse_no_footer(self):
        assert CaucusFooter.parse("Just a regular response.") is None

    def test_parse_invalid_json(self):
        text = "Some text\n{invalid json with status}"
        assert CaucusFooter.parse(text) is None

    def test_terminal_statuses(self):
        for status in _TERMINAL_STATUSES:
            f = CaucusFooter(
                status=status, handoff_to="user",
                writer_vote="none", summary="test",
            )
            assert f.is_terminal is True

    def test_continue_is_not_terminal(self):
        f = CaucusFooter(
            status="continue", handoff_to="codex",
            writer_vote="none", summary="ongoing",
        )
        assert f.is_terminal is False

    def test_strip_footer_fenced(self):
        text = (
            "Main content here.\n\n"
            '```json\n'
            '{"status": "continue", "handoff_to": "codex", '
            '"writer_vote": "none", "summary": "test"}\n'
            '```'
        )
        stripped = CaucusFooter.strip_footer(text)
        assert "Main content here." in stripped
        assert '"status"' not in stripped

    def test_strip_footer_raw(self):
        text = (
            "Analysis complete.\n"
            '{"status": "no_objection", "handoff_to": "user", '
            '"writer_vote": "claude", "summary": "done"}'
        )
        stripped = CaucusFooter.strip_footer(text)
        assert "Analysis complete." in stripped
        assert '"status"' not in stripped

    def test_strip_footer_no_footer(self):
        text = "No footer here."
        assert CaucusFooter.strip_footer(text) == text

    def test_parse_missing_optional_fields(self):
        text = '{"status": "blocked"}'
        f = CaucusFooter.parse(text)
        assert f is not None
        assert f.status == "blocked"
        assert f.handoff_to == "user"       # default
        assert f.writer_vote == "none"      # default
        assert f.summary == ""              # default


# ── Mock adapters/UI for Botference tests ────────────────────


class MockAdapter:
    """Minimal mock for ClaudeAdapter / CodexAdapter."""

    def __init__(self, responses: Optional[list[AdapterResponse]] = None):
        self._responses = list(responses or [])
        self._call_idx = 0
        self.session_id = ""
        self.thread_id = ""
        self.model = "mock-model"
        self.tools = ["Read"]
        self.effort = ""
        self.cwd = ""
        self.add_dirs: list[str] = []
        self.settings: dict | None = None
        self.sandbox = "read-only"
        self.send_calls: list[str] = []
        self.resume_calls: list[str] = []
        self._cumulative_input = 0

    def _next(self) -> AdapterResponse:
        if self._call_idx < len(self._responses):
            r = self._responses[self._call_idx]
            self._call_idx += 1
            return r
        return AdapterResponse(text="(no more mock responses)")

    async def send(self, prompt: str) -> AdapterResponse:
        self.send_calls.append(prompt)
        self.session_id = "mock-session"
        self.thread_id = "mock-thread"
        return self._next()

    async def resume(self, message: str) -> AdapterResponse:
        self.resume_calls.append(message)
        return self._next()

    def context_percent(self, resp=None) -> float:
        return 10.0

    def context_tokens(self, resp=None) -> int:
        return 0


@dataclass
class MockUI:
    """Collects all UI calls for assertions."""
    room_entries: list[tuple[str, str]] = field(default_factory=list)
    caucus_entries: list[tuple[str, str]] = field(default_factory=list)
    room_blocks: list[list[dict] | None] = field(default_factory=list)
    caucus_blocks: list[list[dict] | None] = field(default_factory=list)
    statuses: list[StatusSnapshot] = field(default_factory=list)
    modes: list[RoomMode] = field(default_factory=list)
    permission_responses: list[bool] = field(default_factory=list)
    permission_requests: list[object] = field(default_factory=list)

    def add_room_entry(
        self, speaker: str, text: str, blocks: list[dict] | None = None,
    ) -> None:
        self.room_entries.append((speaker, text))
        self.room_blocks.append(blocks)

    def add_caucus_entry(
        self, speaker: str, text: str, blocks: list[dict] | None = None,
    ) -> None:
        self.caucus_entries.append((speaker, text))
        self.caucus_blocks.append(blocks)

    def set_status(self, status: StatusSnapshot) -> None:
        self.statuses.append(status)

    def set_mode(self, mode: RoomMode) -> None:
        self.modes.append(mode)

    async def request_write_permission(self, request) -> bool:
        self.permission_requests.append(request)
        if self.permission_responses:
            return self.permission_responses.pop(0)
        return False


def _ok(text: str = "OK", **kw) -> AdapterResponse:
    return AdapterResponse(text=text, **kw)


def _make_botference(
    claude_responses: list[AdapterResponse] | None = None,
    codex_responses: list[AdapterResponse] | None = None,
    tmp_path: Path | None = None,
) -> tuple[Botference, MockAdapter, MockAdapter, MockUI]:
    claude = MockAdapter(claude_responses or [_ok("Claude says hi")])
    codex = MockAdapter(codex_responses or [_ok("Codex says hi")])
    ui = MockUI()
    kwargs = {}
    if tmp_path is not None:
        work_dir = tmp_path / "work"
        work_dir.mkdir(exist_ok=True)
        archive_dir = tmp_path / "archive"
        archive_dir.mkdir(exist_ok=True)
        repo_root = Path(__file__).resolve().parent.parent
        kwargs["paths"] = BotferencePaths(
            botference_home=repo_root,
            project_root=tmp_path,
            project_dir=tmp_path,
            work_dir=work_dir,
            build_dir=tmp_path,
            archive_dir=archive_dir,
        )
    c = Botference(
        claude=claude, codex=codex,
        system_prompt="Plan an app", task="Build a thing",
        **kwargs,
    )
    return c, claude, codex, ui


# ── Botference.handle_input ──────────────────────────────────


@pytest.mark.asyncio
class TestBotferenceQuit:
    async def test_quit_sets_flag(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/quit", ui)
        assert c.quit_requested is True
        assert any("Exiting" in t for _, t in ui.room_entries)


@pytest.mark.asyncio
class TestBotferenceStatus:
    async def test_status_shows_info(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/status", ui)
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("Mode:" in m for m in system_msgs)
        assert any("Lead:" in m for m in system_msgs)

    async def test_status_shows_percent_and_tokens(self):
        c, _, _, ui = _make_botference()
        c._claude_tokens = 342_000
        c._claude_window = 1_000_000
        c._claude_pct = 34.2
        c._codex_tokens = 167_000
        c._codex_window = 272_000
        c._codex_pct = 61.4

        await c.handle_input("/status", ui)

        status_text = "\n".join(t for s, t in ui.room_entries if s == "system")
        assert "Claude: ~34% (342.0K / 1.0M)" in status_text
        assert "Codex:  ~61% (167.0K / 272.0K)" in status_text

    async def test_permissions_shows_active_roots(self, tmp_path):
        c, _, _, ui = _make_botference(tmp_path=tmp_path)
        await c.handle_input("/permissions", ui)
        status_text = "\n".join(t for s, t in ui.room_entries if s == "system")
        assert "Planner write roots:" in status_text
        assert "Active: work" in status_text


@pytest.mark.asyncio
class TestBotferenceLead:
    async def test_set_lead_claude(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/lead @claude", ui)
        assert c.lead == "@claude"

    async def test_set_lead_codex(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/lead @codex", ui)
        assert c.lead == "@codex"

    async def test_set_lead_auto(self):
        c, _, _, ui = _make_botference()
        c.lead = "@claude"
        await c.handle_input("/lead auto", ui)
        assert c.lead == "auto"

    async def test_invalid_lead(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/lead invalid", ui)
        assert c.lead == "auto"
        assert any("Usage" in t for _, t in ui.room_entries)


@pytest.mark.asyncio
class TestBotferenceMessageRouting:
    async def test_first_plain_routes_to_all(self):
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok("from claude")],
            codex_responses=[_ok("from codex")],
        )
        await c.handle_input("Hello botference", ui)
        # Both models should get send() calls (first turn)
        assert len(claude.send_calls) == 1
        assert len(codex.send_calls) == 1

    async def test_directed_at_claude_only(self):
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok("hi")],
        )
        await c.handle_input("@claude What do you think?", ui)
        assert len(claude.send_calls) == 1
        assert len(codex.send_calls) == 0

    async def test_directed_at_codex_only(self):
        c, claude, codex, ui = _make_botference(
            codex_responses=[_ok("yo")],
        )
        await c.handle_input("@codex Check this", ui)
        assert len(codex.send_calls) == 1
        assert len(claude.send_calls) == 0

    async def test_resume_on_second_turn(self):
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok("hi"), _ok("resumed")],
        )
        await c.handle_input("@claude first", ui)
        await c.handle_input("second", ui)
        assert len(claude.send_calls) == 1   # first turn: send
        assert len(claude.resume_calls) == 1  # second turn: resume

    async def test_transcript_records_entries(self):
        c, _, _, ui = _make_botference(
            claude_responses=[_ok("yo")],
        )
        await c.handle_input("@claude hi", ui)
        assert len(c.transcript.entries) == 2  # user + claude
        assert c.transcript.entries[0].speaker == "user"
        assert c.transcript.entries[1].speaker == "claude"

    async def test_session_snapshot_persisted_after_message(self, tmp_path):
        c, _, _, ui = _make_botference(
            claude_responses=[_ok("yo")],
            tmp_path=tmp_path,
        )
        await c.handle_input("@claude hi", ui)
        session_path = tmp_path / "work" / "sessions" / f"{c.session_id}.json"
        payload = json.loads(session_path.read_text(encoding="utf-8"))
        assert payload["session_id"] == c.session_id
        assert len(payload["transcript"]) == 2
        assert payload["transcript"][0]["speaker"] == "user"
        assert payload["transcript"][1]["speaker"] == "claude"

    async def test_permission_request_can_grant_runtime_write_root(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[
                _ok('<write-access-request path="src" reason="Need to update existing app code" />'),
                _ok("Updated plan after approval"),
            ],
            tmp_path=tmp_path,
        )
        ui.permission_responses = [True]

        await c.handle_input("@claude update the app", ui)

        assert len(ui.permission_requests) == 1
        request = ui.permission_requests[0]
        assert request.model == "claude"
        assert request.path == "src"
        assert any(
            "Granted write access to src" in text
            for speaker, text in ui.room_entries
            if speaker == "system"
        )
        assert any(root.name == "src" for root in c._plan_write_roots())
        assert any(path.endswith("/src") for path in codex.add_dirs)
        session_path = tmp_path / "work" / "sessions" / f"{c.session_id}.json"
        payload = json.loads(session_path.read_text(encoding="utf-8"))
        assert "src" in payload["granted_plan_write_roots"]
        assert claude.resume_calls[-1].startswith("Write access to src is now approved")

    async def test_permission_request_can_be_denied(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[
                _ok('<write-access-request path="src" reason="Need to update existing app code" />'),
                _ok("I cannot edit src without approval."),
            ],
            tmp_path=tmp_path,
        )
        ui.permission_responses = [False]

        await c.handle_input("@claude update the app", ui)

        assert len(ui.permission_requests) == 1
        assert any(
            "Denied write access to src." == text
            for speaker, text in ui.room_entries
            if speaker == "system"
        )
        assert not any(root.name == "src" for root in c._plan_write_roots())
        assert not any(path.endswith("/src") for path in codex.add_dirs)
        assert claude.resume_calls[-1].startswith("Write access to src was denied")

    async def test_tool_summaries_displayed_as_folded_tree(self):
        resp = _ok("Found it", tool_summaries=[
            ToolSummary(
                id="t1",
                name="Grep",
                input_preview='{"pattern":"pattern","path":"/tmp/src"}',
                        output_preview="3 matches"),
        ])
        c, _, _, ui = _make_botference(claude_responses=[resp])
        await c.handle_input("@claude search", ui)
        tool_entries = [t for _, t in ui.room_entries if "Explored" in t]
        assert len(tool_entries) == 1
        assert tool_entries[0] == "Explored\n└ Search pattern in src"
        assert "3 matches" not in tool_entries[0]
        room_texts = [t for _, t in ui.room_entries]
        assert room_texts.index("Explored\n└ Search pattern in src") < room_texts.index("Found it")

    async def test_tool_summaries_handle_bash_commands(self):
        resp = _ok("Checked it", tool_summaries=[
            ToolSummary(
                id="t1",
                name="Bash",
                input_preview='{"command":"/bin/zsh -lc \\"pwd\\""}',
            ),
        ])
        c, _, _, ui = _make_botference(claude_responses=[resp])
        await c.handle_input("@claude inspect", ui)
        tool_entries = [t for _, t in ui.room_entries if "Explored" in t]
        assert len(tool_entries) == 1
        assert tool_entries[0] == "Explored\n└ Shell pwd"

    async def test_tool_summaries_handle_edit_tools(self):
        resp = _ok("Updated it", tool_summaries=[
            ToolSummary(
                id="t1",
                name="Edit",
                input_preview='{"file_path":"src/app.py","old_string":"old","new_string":"new"}',
            ),
        ])
        c, _, _, ui = _make_botference(claude_responses=[resp])
        await c.handle_input("@claude update", ui)
        tool_entries = [t for _, t in ui.room_entries if "Explored" in t]
        assert len(tool_entries) == 1
        assert tool_entries[0] == "Explored\n└ Edit app.py"

    async def test_tool_summaries_preserve_structured_diff_blocks(self):
        diff_text = "@@ -1,1 +1,1 @@\n-old_name = 1\n+new_name = 1"
        resp = _ok("Checked it", tool_summaries=[
            ToolSummary(
                id="t1",
                name="Bash",
                input_preview='{"command":"git diff -- src/app.py"}',
                output_preview="@@ -1,1 +1,1 @@ ...",
                output_blocks=parse_render_blocks(diff_text),
            ),
        ])
        c, _, _, ui = _make_botference(claude_responses=[resp])
        await c.handle_input("@claude inspect", ui)
        explored_index = next(
            i for i, (_, text) in enumerate(ui.room_entries) if text.startswith("Explored")
        )
        explored_blocks = ui.room_blocks[explored_index]
        assert explored_blocks is not None
        assert any(block["type"] == "diff" for block in explored_blocks)


@pytest.mark.asyncio
class TestBotferenceCaucus:
    async def test_caucus_no_topic_shows_usage(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/caucus", ui)
        assert any("Usage" in t for _, t in ui.room_entries)

    async def test_caucus_sets_mode_and_restores(self):
        continue_footer = (
            '{"status": "continue", "handoff_to": "codex", '
            '"writer_vote": "none", "summary": "discussing"}'
        )
        terminal_footer = (
            '{"status": "no_objection", "handoff_to": "user", '
            '"writer_vote": "claude", "summary": "agreed"}'
        )
        # 3 minimum rounds: 2 continue + 1 terminal per model
        c, _, _, ui = _make_botference(
            claude_responses=[
                _ok("init"),
                _ok(f"Turn text\n{continue_footer}"),
                _ok(f"Turn text\n{continue_footer}"),
                _ok(f"Turn text\n{terminal_footer}"),
            ],
            codex_responses=[
                _ok("init"),
                _ok(f"Turn text\n{continue_footer}"),
                _ok(f"Turn text\n{continue_footer}"),
                _ok(f"Turn text\n{terminal_footer}"),
            ],
        )
        assert c.mode is RoomMode.PUBLIC
        await c.handle_input("/caucus Architecture choice?", ui)
        # Should have entered CAUCUS mode then returned to PUBLIC
        assert RoomMode.CAUCUS in ui.modes
        assert ui.modes[-1] is RoomMode.PUBLIC
        assert c.mode is RoomMode.PUBLIC

    async def test_caucus_summary_posted_to_room(self):
        continue_footer = (
            '{"status": "continue", "handoff_to": "codex", '
            '"writer_vote": "none", "summary": "still discussing"}'
        )
        terminal_footer = (
            '{"status": "ready_to_draft", "handoff_to": "user", '
            '"writer_vote": "codex", "summary": "consensus on approach"}'
        )
        # Provide enough responses for 3 minimum rounds + init
        c, _, _, ui = _make_botference(
            claude_responses=[
                _ok("init"),
                _ok(f"Point A\n{continue_footer}"),
                _ok(f"Point B\n{continue_footer}"),
                _ok(f"I agree\n{terminal_footer}"),
            ],
            codex_responses=[
                _ok("init"),
                _ok(f"Response A\n{continue_footer}"),
                _ok(f"Response B\n{continue_footer}"),
                _ok(f"Me too\n{terminal_footer}"),
            ],
        )
        await c.handle_input("/caucus Design?", ui)
        summary_entries = [t for s, t in ui.room_entries if s == "summary"]
        assert len(summary_entries) >= 1
        assert "agreement" in summary_entries[0].lower()

    async def test_caucus_auto_lead_from_consensus(self):
        continue_footer = (
            '{"status": "continue", "handoff_to": "codex", '
            '"writer_vote": "claude", "summary": "discussing"}'
        )
        terminal_footer_claude = (
            '{"status": "no_objection", "handoff_to": "user", '
            '"writer_vote": "claude", "summary": "done"}'
        )
        terminal_footer_codex = (
            '{"status": "no_objection", "handoff_to": "user", '
            '"writer_vote": "claude", "summary": "done"}'
        )
        c, _, _, ui = _make_botference(
            claude_responses=[
                _ok("init"),
                _ok(f"text\n{continue_footer}"),
                _ok(f"text\n{continue_footer}"),
                _ok(f"text\n{terminal_footer_claude}"),
            ],
            codex_responses=[
                _ok("init"),
                _ok(f"text\n{continue_footer}"),
                _ok(f"text\n{continue_footer}"),
                _ok(f"text\n{terminal_footer_codex}"),
            ],
        )
        assert c.lead == "auto"
        await c.handle_input("/caucus who writes?", ui)
        assert c.lead == "@claude"

    async def test_caucus_footer_stripped_in_display(self):
        footer = (
            '```json\n'
            '{"status": "continue", "handoff_to": "codex", '
            '"writer_vote": "none", "summary": "ongoing"}\n'
            '```'
        )
        c, _, _, ui = _make_botference(
            claude_responses=[_ok("init"),
                              _ok(f"My analysis is solid.\n\n{footer}"),
                              _ok(f"Second turn.\n\n{footer}"),
                              _ok(f"Third turn.\n\n{footer}"),
                              _ok(f"Fourth turn.\n\n{footer}"),
                              _ok(f"Fifth turn.\n\n{footer}")],
            codex_responses=[_ok("init"),
                             _ok(f"I concur.\n\n{footer}"),
                             _ok(f"Response B.\n\n{footer}"),
                             _ok(f"Response C.\n\n{footer}"),
                             _ok(f"Response D.\n\n{footer}"),
                             _ok(f"Final.\n\n{footer}")],
        )
        await c.handle_input("/caucus test", ui)
        # Caucus entries should have the analysis text but not the raw JSON
        text_entries = [t for s, t in ui.caucus_entries
                        if s in ("claude", "codex")]
        for t in text_entries:
            assert '"status"' not in t

    async def test_caucus_aborts_on_bootstrap_failure(self):
        """If a model fails to start, caucus should abort cleanly."""
        failing = MockAdapter()
        failing.send = AsyncMock(side_effect=RuntimeError("auth failed"))
        c, _, _, ui = _make_botference()
        c.claude = failing  # claude will fail to init
        await c.handle_input("/caucus test topic", ui)
        assert c.mode is RoomMode.PUBLIC
        assert any("aborted" in t.lower() for _, t in ui.room_entries)
        # No caucus turns should have been attempted
        caucus_model_entries = [s for s, _ in ui.caucus_entries
                                if s in ("claude", "codex")]
        assert caucus_model_entries == []

    async def test_caucus_mid_turn_failure_reports_blocked(self):
        """If a model fails mid-caucus, summary should show blocked, not max-rounds."""
        c, claude, codex, ui = _make_botference(
            claude_responses=[
                _ok("init"),                     # send (ensure_initialized)
                _ok("Claude's first caucus turn\n"
                     '{"status": "continue", "handoff_to": "codex", '
                     '"writer_vote": "none", "summary": "ongoing"}'),
            ],
            codex_responses=[
                _ok("init"),                     # send (ensure_initialized)
            ],
        )
        # Codex succeeds at init but fails on the first caucus resume
        original_resume = codex.resume

        async def fail_resume(msg):
            raise RuntimeError("connection lost")

        codex.resume = fail_resume

        await c.handle_input("/caucus architecture?", ui)
        assert c.mode is RoomMode.PUBLIC
        # Summary should say blocked, not "max rounds reached"
        summary_entries = [t for s, t in ui.room_entries if s == "summary"]
        assert len(summary_entries) >= 1
        assert "blocked" in summary_entries[0].lower()
        assert "max rounds" not in summary_entries[0].lower()


@pytest.mark.asyncio
class TestBotferenceDraft:
    async def test_draft_requires_lead(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/draft", ui)
        assert any("No lead" in t for _, t in ui.room_entries)

    async def test_draft_default_two_rounds_writes_plan_and_comments(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[
                _ok("claude init"),
                _ok("**Thread:** demo\n\n# Draft Plan v1"),
                _ok("**Thread:** demo\n\n# Draft Plan v2"),
                _ok("**Thread:** demo\n\n# Draft Plan v3"),
            ],
            codex_responses=[
                _ok("codex init"),
                _ok("# Review 1\n\nNeeds more detail."),
                _ok("# Review 2\n\nLooks good now."),
            ],
            tmp_path=tmp_path,
        )
        c.lead = "@claude"
        await c.handle_input("/draft", ui)
        plan_path = tmp_path / "work" / "implementation-plan.md"
        assert plan_path.read_text() == "**Thread:** demo\n\n# Draft Plan v3\n"
        assert (tmp_path / "work" / "AI-reviewer_comments_round-1.md").read_text() == (
            "# Review 1\n\nNeeds more detail.\n"
        )
        assert (tmp_path / "work" / "AI-reviewer_comments_round-2.md").read_text() == (
            "# Review 2\n\nLooks good now.\n"
        )
        assert len(claude.send_calls) == 1
        assert len(codex.send_calls) == 1
        assert any("Draft complete" in t for _, t in ui.room_entries)

    async def test_draft_zero_rounds_writes_plan_only(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[
                _ok("claude init"),
                _ok("**Thread:** demo\n\n# Draft Plan v1"),
            ],
            tmp_path=tmp_path,
        )
        c.lead = "@claude"
        await c.handle_input("/draft 0", ui)
        assert (tmp_path / "work" / "implementation-plan.md").read_text() == (
            "**Thread:** demo\n\n# Draft Plan v1\n"
        )
        assert list((tmp_path / "work").glob("AI-reviewer_comments_round-*.md")) == []
        assert len(claude.send_calls) == 1
        assert len(codex.send_calls) == 0

    async def test_draft_invalid_rounds_rejected(self):
        c, _, _, ui = _make_botference()
        c.lead = "@claude"
        await c.handle_input("/draft nope", ui)
        assert any("Usage: /draft [rounds]" in t for _, t in ui.room_entries)


@pytest.mark.asyncio
class TestBotferenceFinalize:
    async def test_finalize_requires_lead(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/finalize", ui)
        assert any("No lead" in t for _, t in ui.room_entries)

    async def test_finalize_revises_plan_writes_checkpoint_and_archives_comments(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[
                _ok("claude init"),
                _ok("**Thread:** demo\n\n# Final Plan"),
                _ok(
                    "Checkpoint - Demo\n\n"
                    "**Thread:** demo\n"
                    "**Last updated:** 2026-04-01\n"
                    "**Last agent:** claude\n"
                    "**Status:** ready\n\n"
                    "## Knowledge State\n\n"
                    "| Task | Status | Notes |\n"
                    "|------|--------|-------|\n\n"
                    "## Last Reflection\n\n"
                    "none\n\n"
                    "## Next Task\n\n"
                    "1. Start implementation\n"
                ),
            ],
            tmp_path=tmp_path,
        )
        c.lead = "@claude"
        work = tmp_path / "work"
        work.joinpath("implementation-plan.md").write_text(
            "**Thread:** demo\n\n# Draft Plan v3\n", encoding="utf-8"
        )
        work.joinpath("AI-reviewer_comments_round-1.md").write_text(
            "# Review 1\n\nNeeds more detail.\n", encoding="utf-8"
        )
        work.joinpath("AI-reviewer_comments_round-2.md").write_text(
            "# Review 2\n\nLooks good now.\n", encoding="utf-8"
        )

        await c.handle_input("/finalize", ui)
        assert c.mode is RoomMode.PUBLIC
        assert work.joinpath("implementation-plan.md").read_text() == (
            "**Thread:** demo\n\n# Final Plan\n"
        )
        assert "Checkpoint - Demo" in work.joinpath("checkpoint.md").read_text()
        assert list(work.glob("AI-reviewer_comments_round-*.md")) == []
        archived_dir = tmp_path / "archive" / "reviewer-comments" / "demo"
        assert archived_dir.joinpath("AI-reviewer_comments_round-1.md").is_file()
        assert archived_dir.joinpath("AI-reviewer_comments_round-2.md").is_file()
        assert any("Finalize complete" in t for _, t in ui.room_entries)

    async def test_finalize_without_reviewer_comments_only_creates_checkpoint(self, tmp_path):
        c, claude, _, ui = _make_botference(
            claude_responses=[
                _ok("claude init"),
                _ok(
                    "Checkpoint - Demo\n\n"
                    "**Thread:** demo\n"
                    "**Last updated:** 2026-04-01\n"
                    "**Last agent:** claude\n"
                    "**Status:** ready\n\n"
                    "## Knowledge State\n\n"
                    "| Task | Status | Notes |\n"
                    "|------|--------|-------|\n\n"
                    "## Last Reflection\n\n"
                    "none\n\n"
                    "## Next Task\n\n"
                    "1. Start implementation\n"
                ),
            ],
            tmp_path=tmp_path,
        )
        c.lead = "@claude"
        work = tmp_path / "work"
        work.joinpath("implementation-plan.md").write_text(
            "**Thread:** demo\n\n# Draft Plan v3\n", encoding="utf-8"
        )
        await c.handle_input("/finalize", ui)
        assert c.mode is RoomMode.PUBLIC
        assert work.joinpath("implementation-plan.md").read_text() == (
            "**Thread:** demo\n\n# Draft Plan v3\n"
        )
        assert work.joinpath("checkpoint.md").is_file()
        assert len(claude.resume_calls) == 1

    async def test_finalize_without_prior_sessions(self, tmp_path):
        """Bootstraps the lead session before finalizing."""
        c, claude, codex, ui = _make_botference(
            claude_responses=[
                _ok("claude bootstrapped"),
                _ok(
                    "Checkpoint - Demo\n\n"
                    "**Thread:** demo\n"
                    "**Last updated:** 2026-04-01\n"
                    "**Last agent:** claude\n"
                    "**Status:** ready\n\n"
                    "## Knowledge State\n\n"
                    "| Task | Status | Notes |\n"
                    "|------|--------|-------|\n\n"
                    "## Last Reflection\n\n"
                    "none\n\n"
                    "## Next Task\n\n"
                    "1. Start implementation\n"
                ),
            ],
            tmp_path=tmp_path,
        )
        c.lead = "@claude"
        work = tmp_path / "work"
        work.joinpath("implementation-plan.md").write_text(
            "**Thread:** demo\n\n# Plan content\n", encoding="utf-8"
        )
        await c.handle_input("/finalize", ui)
        assert c.mode is RoomMode.PUBLIC
        assert len(claude.send_calls) == 1


@pytest.mark.asyncio
class TestBotferenceResume:
    async def test_resume_latest_restores_session_and_uses_resume(self, tmp_path):
        original, _, _, original_ui = _make_botference(
            claude_responses=[_ok("first reply")],
            tmp_path=tmp_path,
        )
        await original.handle_input("@claude first question", original_ui)
        original_session_id = original.session_id

        resumed, claude, codex, resumed_ui = _make_botference(
            claude_responses=[_ok("continued reply")],
            codex_responses=[_ok("codex reply")],
            tmp_path=tmp_path,
        )
        await resumed.handle_input("/resume latest", resumed_ui)

        assert resumed.session_id == original_session_id
        assert resumed.claude.session_id == "mock-session"
        assert resumed.router.current_route == "@claude"
        assert len(resumed.transcript.entries) == 2
        assert any("Resumed session" in text for _, text in resumed_ui.room_entries)

        await resumed.handle_input("follow up", resumed_ui)
        assert len(claude.resume_calls) == 1
        assert len(claude.send_calls) == 0
        assert len(codex.send_calls) == 0

    async def test_resume_requires_fresh_controller(self, tmp_path):
        c, _, _, ui = _make_botference(
            claude_responses=[_ok("reply")],
            tmp_path=tmp_path,
        )
        await c.handle_input("@claude hi", ui)
        await c.handle_input("/resume latest", ui)
        assert any(
            "fresh controller session" in text.lower()
            for _, text in ui.room_entries
        )

    async def test_draft_without_prior_session(self, tmp_path):
        """Bootstraps lead and reviewer sessions before drafting."""
        c, claude, codex, ui = _make_botference(
            codex_responses=[
                _ok("codex bootstrapped"),
                _ok("**Thread:** demo\n\n# Draft here"),
                _ok("**Thread:** demo\n\n# Draft revised"),
            ],
            claude_responses=[
                _ok("claude bootstrapped"),
                _ok("# Review\n\nNeeds one tweak."),
            ],
            tmp_path=tmp_path,
        )
        c.lead = "@codex"
        await c.handle_input("/draft 1", ui)
        assert len(codex.send_calls) == 1
        assert len(claude.send_calls) == 1
        assert len(codex.resume_calls) == 2
        assert (tmp_path / "work" / "implementation-plan.md").read_text() == (
            "**Thread:** demo\n\n# Draft revised\n"
        )


# ── Caucus summary generation ─────────────────────────────


class TestCaucusSummary:
    def test_summary_no_footer(self):
        s = Botference._caucus_summary("arch", None, {})
        assert "max rounds" in s.lower()

    def test_summary_disagree(self):
        f = CaucusFooter("disagree", "user", "none", "Can't agree on DB")
        s = Botference._caucus_summary("db choice", f, {})
        assert "disagreement" in s.lower()
        assert "Can't agree" in s

    def test_summary_need_user_input(self):
        f = CaucusFooter("need_user_input", "user", "none", "Which region?")
        s = Botference._caucus_summary("deploy", f, {})
        assert "user input" in s.lower()

    def test_summary_blocked(self):
        f = CaucusFooter("blocked", "user", "none", "Missing creds")
        s = Botference._caucus_summary("auth", f, {})
        assert "blocked" in s.lower()

    def test_summary_agreement(self):
        f = CaucusFooter("ready_to_draft", "user", "claude", "Ready")
        votes = {"claude": "claude", "codex": "claude"}
        s = Botference._caucus_summary("plan", f, votes)
        assert "agreement" in s.lower()


# ── StatusSnapshot integration ────────────────────────────


class TestBotferenceStatusSnapshot:
    def test_initial_snapshot(self):
        c, _, _, _ = _make_botference()
        snap = c.status_snapshot()
        assert snap.mode is RoomMode.PUBLIC
        assert snap.lead == "auto"
        assert snap.route == "@all"
        assert snap.claude_percent is None
        assert snap.codex_percent is None
        assert snap.claude_tokens is None
        assert snap.codex_tokens is None
        assert snap.claude_window is None
        assert snap.codex_window is None

    @pytest.mark.asyncio
    async def test_snapshot_updates_after_message(self):
        c, _, _, ui = _make_botference(claude_responses=[_ok("hi")])
        await c.handle_input("@claude hello", ui)
        snap = c.status_snapshot()
        assert snap.claude_percent is not None
        assert snap.route == "@claude"


# ── Regression: late-join transcript backfill (bug 2) ─────


@pytest.mark.asyncio
class TestLateJoinBackfill:
    async def test_codex_sees_prior_claude_discussion(self):
        """After several @claude turns, first @codex gets transcript backfill."""
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok("claude turn 1"), _ok("claude turn 2")],
            codex_responses=[_ok("codex first reply")],
        )
        await c.handle_input("@claude first question", ui)
        await c.handle_input("follow up", ui)
        # Now switch to codex — first time it's being initialized
        await c.handle_input("@codex what do you think?", ui)
        # Codex's send() should have received transcript backfill
        assert len(codex.send_calls) == 1
        init_prompt = codex.send_calls[0]
        assert "claude turn 1" in init_prompt
        assert "first question" in init_prompt

    async def test_caucus_bootstrap_includes_transcript(self):
        """Models bootstrapped during /caucus get prior discussion."""
        c, claude, codex, ui = _make_botference(
            claude_responses=[
                _ok("claude room reply"),           # send (@claude msg)
                _ok("claude bootstrapped"),          # send (caucus ensure_init)
                _ok("caucus turn\n"                  # resume (caucus)
                     '{"status": "no_objection", "handoff_to": "user", '
                     '"writer_vote": "none", "summary": "ok"}'),
            ],
            codex_responses=[
                _ok("codex bootstrapped"),           # send (caucus ensure_init)
                _ok("caucus turn\n"
                     '{"status": "no_objection", "handoff_to": "user", '
                     '"writer_vote": "none", "summary": "ok"}'),
            ],
        )
        await c.handle_input("@claude context setup", ui)
        # codex never seen room discussion — caucus should bootstrap it
        await c.handle_input("/caucus architecture?", ui)
        assert len(codex.send_calls) == 1
        init_prompt = codex.send_calls[0]
        # Codex's bootstrap prompt should contain the prior @claude discussion
        assert "context setup" in init_prompt


# ── Regression: no duplicate user message on resume (bug 3) ──


@pytest.mark.asyncio
class TestNoDuplicateUserMessage:
    async def test_resume_context_does_not_duplicate_user_entry(self):
        """On resume, context_since should not re-inject the user message."""
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok("first"), _ok("second")],
        )
        # First turn — initializes claude
        await c.handle_input("@claude hello", ui)
        # Second turn — resumes claude
        await c.handle_input("follow up question", ui)
        resume_ctx = claude.resume_calls[0]
        # The user message "follow up question" should appear exactly once
        count = resume_ctx.count("follow up question")
        assert count == 1, (
            f"User message appeared {count} times in resume context "
            f"(expected 1):\n{resume_ctx}"
        )


# ── _update_pct passes resp to codex (task 3) ────────────


from unittest.mock import MagicMock


class TestContextPercentUpdate:
    def test_update_pct_stores_codex_tokens_and_raw_percent(self):
        """_update_pct("codex", resp) stores raw tokens, window, and % of window."""
        c, claude, codex, ui = _make_botference()
        resp = AdapterResponse(
            text="test", input_tokens=50000, output_tokens=5000,
            tool_result_tokens_estimate=1000, context_window=200000,
        )
        codex.context_percent = MagicMock(return_value=42.0)
        codex.context_tokens = MagicMock(return_value=50000)
        c._update_pct("codex", resp)
        codex.context_percent.assert_called_once_with(resp)
        codex.context_tokens.assert_called_once_with(resp)
        assert c._codex_tokens == 50000
        assert c._codex_window == 200000
        assert c._codex_pct == pytest.approx(25.0)  # 50000/200000*100

    def test_update_pct_stores_claude_tokens_and_raw_percent(self):
        """_update_pct("claude", resp) stores raw tokens, window, and % of window."""
        c, claude, codex, ui = _make_botference()
        resp = AdapterResponse(
            text="test", input_tokens=50000, output_tokens=5000,
            tool_result_tokens_estimate=1000, context_window=1000000,
        )
        claude.context_percent = MagicMock(return_value=30.0)
        claude.context_tokens = MagicMock(return_value=100000)
        c._update_pct("claude", resp)
        claude.context_percent.assert_called_once_with(resp)
        claude.context_tokens.assert_called_once_with(resp)
        assert c._claude_tokens == 100000
        assert c._claude_window == 1000000
        assert c._claude_pct == pytest.approx(10.0)  # 100000/1000000*100


# ── /help text regression ────────────────────────────────


class TestHelpText:
    def test_help_explains_context_display(self):
        """Help text must explain context shows occupancy / window."""
        c, claude, codex, ui = _make_botference()
        c._show_help(ui)
        help_text = " ".join(text for _, text in ui.room_entries)
        assert "occupancy" in help_text.lower() or "context" in help_text.lower()

    def test_help_documents_relay(self):
        """Help text must mention /relay and /tag alias."""
        c, claude, codex, ui = _make_botference()
        c._show_help(ui)
        help_text = " ".join(text for _, text in ui.room_entries)
        assert "/relay" in help_text
        assert "/tag" in help_text


# ── First-turn over-limit warning (task 4) ────────────────


@pytest.mark.asyncio
class TestContextWarnings:
    async def test_first_turn_over_limit_emits_warning_for_codex(self):
        """First @codex turn with context_percent > 100% emits a one-time warning."""
        c, claude, codex, ui = _make_botference(
            codex_responses=[_ok("codex turn 1"), _ok("codex turn 2")],
        )
        codex.context_percent = MagicMock(return_value=153.0)
        codex.context_tokens = MagicMock(return_value=50000)
        await c.handle_input("@codex hello", ui)
        # Should have one system warning about context
        warnings = [
            t for s, t in ui.room_entries
            if s == "system" and "consider yielding" in t.lower()
        ]
        assert len(warnings) == 1
        # Second turn should NOT emit another warning
        await c.handle_input("follow up", ui)
        warnings_after = [
            t for s, t in ui.room_entries
            if s == "system" and "consider yielding" in t.lower()
        ]
        assert len(warnings_after) == 1  # still just one

    async def test_warning_mentions_yield_threshold_and_sets_status(self):
        c, claude, codex, ui = _make_botference(
            codex_responses=[_ok("codex turn 1", context_window=272_000)],
        )
        codex.context_percent = MagicMock(return_value=153.0)
        codex.context_tokens = MagicMock(return_value=231_768)

        await c.handle_input("@codex hello", ui)

        warnings = [
            t for s, t in ui.room_entries
            if s == "system" and "consider yielding" in t.lower()
        ]
        assert len(warnings) == 1
        assert "231,768 / 272,000" in warnings[0]
        assert "85% of window" in warnings[0]
        assert "yield threshold" in warnings[0].lower()
        assert ui.statuses[-1].codex_percent == pytest.approx(85.2088235294)


@pytest.mark.asyncio
class TestContextStatusRefresh:
    async def test_caucus_updates_status_after_each_turn(self):
        continue_footer = (
            '{"status": "continue", "handoff_to": "codex", '
            '"writer_vote": "none", "summary": "discussing"}'
        )
        terminal_footer = (
            '{"status": "no_objection", "handoff_to": "user", '
            '"writer_vote": "claude", "summary": "done"}'
        )
        c, _, _, ui = _make_botference(
            claude_responses=[
                _ok("init", context_window=1_000_000),
                _ok(f"Turn text\n{continue_footer}", context_window=1_000_000),
                _ok(f"Turn text\n{continue_footer}", context_window=1_000_000),
                _ok(f"Turn text\n{terminal_footer}", context_window=1_000_000),
            ],
            codex_responses=[
                _ok("init", context_window=272_000),
                _ok(f"Turn text\n{continue_footer}", context_window=272_000),
                _ok(f"Turn text\n{continue_footer}", context_window=272_000),
                _ok(f"Turn text\n{terminal_footer}", context_window=272_000),
            ],
        )

        await c.handle_input("/caucus Architecture choice?", ui)

        assert len(ui.statuses) >= 9




# ── Initial prompt section framing ────────────────────────


class TestInitialPromptSections:
    def test_build_initial_prompt_omits_empty_system_and_task_blocks(self):
        """With empty system_prompt and task, the section headers must be absent."""
        claude = MockAdapter()
        codex = MockAdapter()
        c = Botference(claude=claude, codex=codex, system_prompt="", task="")
        prompt = c._build_initial_prompt("claude")
        # Room preamble and room history should still be present
        assert "shared planning room" in prompt
        assert "--- Room History ---" in prompt
        # Empty-content sections must be omitted entirely
        assert "--- System Prompt ---" not in prompt
        assert "--- Task ---" not in prompt

    def test_build_initial_prompt_includes_non_empty_sections(self):
        """With non-empty system_prompt and task, the section headers must appear."""
        claude = MockAdapter()
        codex = MockAdapter()
        c = Botference(claude=claude, codex=codex,
                    system_prompt="Plan an app", task="Build a thing")
        prompt = c._build_initial_prompt("claude")
        assert "--- System Prompt ---" in prompt
        assert "Plan an app" in prompt
        assert "--- Task ---" in prompt
        assert "Build a thing" in prompt


# ── CLI planning mode routing (lib/config.sh) ────────────


import subprocess


def _shell_parse_loop_args(*args: str) -> dict[str, str]:
    """Source lib/config.sh and return vars after parse_loop_args."""
    script_dir = Path(__file__).resolve().parent.parent / "lib"
    cmd = (
        f'source "{script_dir}/config.sh" && '
        f'parse_loop_args {" ".join(args)} && '
        'echo "LOOP_MODE=$LOOP_MODE" && '
        'echo "PROMPT_FILE=$PROMPT_FILE" && '
        'echo "BOTFERENCE_MODE=$BOTFERENCE_MODE" && '
        'echo "INIT_PROFILE=$INIT_PROFILE"'
    )
    result = subprocess.run(
        ["bash", "-c", cmd],
        capture_output=True, text=True, timeout=5,
    )
    assert result.returncode == 0, f"Shell failed: {result.stderr}"
    out = {}
    for line in result.stdout.strip().splitlines():
        k, _, v = line.partition("=")
        out[k] = v
    return out


def _shell_eval_config(*args: str) -> dict[str, str]:
    """Source lib/config.sh, parse args, and inspect shell helper outputs."""
    script_dir = Path(__file__).resolve().parent.parent / "lib"
    cmd = (
        f'source "{script_dir}/config.sh" && '
        f'parse_loop_args {" ".join(args)} && '
        'echo "INTERACTIVE_PLAN=$(is_interactive_plan_mode && echo true || echo false)"'
    )
    result = subprocess.run(
        ["bash", "-c", cmd],
        capture_output=True, text=True, timeout=5,
    )
    assert result.returncode == 0, f"Shell failed: {result.stderr}"
    out = {}
    for line in result.stdout.strip().splitlines():
        k, _, v = line.partition("=")
        out[k] = v
    return out


class TestPlanningModeRouting:
    def test_parse_loop_args_splits_plan_and_research_plan(self):
        # bare plan → freeform: no prompt file, botference mode on
        plan = _shell_parse_loop_args("plan")
        assert plan["LOOP_MODE"] == "plan"
        assert plan["PROMPT_FILE"] == ""
        assert plan["BOTFERENCE_MODE"] == "true"

        # research-plan → structured: uses prompts/plan.md, botference mode on
        rp = _shell_parse_loop_args("research-plan")
        assert rp["LOOP_MODE"] == "research-plan"
        assert rp["PROMPT_FILE"] == "prompts/plan.md"
        assert rp["BOTFERENCE_MODE"] == "true"

    def test_parse_loop_args_supports_archive_mode(self):
        archive = _shell_parse_loop_args("archive")
        assert archive["LOOP_MODE"] == "archive"
        assert archive["PROMPT_FILE"] == ""
        assert archive["BOTFERENCE_MODE"] == "false"

    def test_parse_loop_args_supports_init_mode(self):
        init = _shell_parse_loop_args("init", "--profile=greenfield-app")
        assert init["LOOP_MODE"] == "init"
        assert init["PROMPT_FILE"] == ""
        assert init["BOTFERENCE_MODE"] == "false"
        assert init["INIT_PROFILE"] == "greenfield-app"

    def test_interactive_plan_mode_helper(self):
        assert _shell_eval_config("plan")["INTERACTIVE_PLAN"] == "true"
        assert _shell_eval_config("research-plan")["INTERACTIVE_PLAN"] == "true"
        assert _shell_eval_config("-p", "plan")["INTERACTIVE_PLAN"] == "false"
        assert _shell_eval_config("build")["INTERACTIVE_PLAN"] == "false"


class TestInitModeLauncher:
    def test_botference_init_creates_project_local_state(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent

        result = subprocess.run(
            [str(repo_root / "botference"), "init", "--profile=greenfield-app"],
            cwd=tmp_path,
            env={
                **os.environ,
                "BOTFERENCE_HOME": str(repo_root),
            },
            capture_output=True,
            text=True,
            timeout=10,
        )

        assert result.returncode == 0, result.stderr
        project_dir = tmp_path / "botference"
        assert project_dir.is_dir()
        assert (project_dir / "README.md").is_file()
        assert (project_dir / "project.json").is_file()
        assert (project_dir / "implementation-plan.md").is_file()
        assert (project_dir / "checkpoint.md").is_file()
        assert (project_dir / "build" / "AI-generated-outputs").is_dir()
        assert (project_dir / "archive").is_dir()
        assert not (tmp_path / "run").exists()
        assert not (tmp_path / "implementation-plan.md").exists()

        project_json = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
        assert project_json["profile"] == "greenfield-app"
        assert project_json["modes"]["build"] is True
        assert project_json["write_roots"]["plan"] == ["botference"]
        assert project_json["write_roots"]["build"] == ["botference"]


class TestArchiveModeLauncher:
    def test_botference_archive_runs_archive_script(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        work = tmp_path / "work"
        work.mkdir()
        build = tmp_path / "build"
        build.mkdir()
        (work / "checkpoint.md").write_text(
            "**Thread:** demo-thread\n"
            "**Last updated:** 2026-03-29\n",
            encoding="utf-8",
        )
        (work / "implementation-plan.md").write_text(
            "- [ ] 1. Demo task **coder**\n",
            encoding="utf-8",
        )
        (work / "HUMAN_REVIEW_NEEDED.md").write_text(
            "# HUMAN REVIEW NEEDED\n",
            encoding="utf-8",
        )
        (work / "inbox.md").write_text("operator note\n", encoding="utf-8")
        (tmp_path / "CHANGELOG.md").write_text("# CHANGELOG\n\nentry\n", encoding="utf-8")
        (work / "iteration_count").write_text("7\n", encoding="utf-8")
        (build / "logs").mkdir()
        (build / "logs" / "usage.jsonl").write_text("", encoding="utf-8")

        result = subprocess.run(
            [str(repo_root / "botference"), "archive"],
            cwd=tmp_path,
            env={
                **os.environ,
                "BOTFERENCE_HOME": str(repo_root),
            },
            capture_output=True,
            text=True,
            timeout=10,
        )

        assert result.returncode == 0, result.stderr
        archive_dir = tmp_path / "archive" / "2026-03-29_demo-thread"
        assert archive_dir.is_dir()
        assert (archive_dir / "checkpoint.md").is_file()
        assert (archive_dir / "implementation-plan.md").is_file()
        assert (archive_dir / "CHANGELOG.md").is_file()
        assert (work / "checkpoint.md").is_file()
        assert (work / "implementation-plan.md").is_file()
        assert (work / "HUMAN_REVIEW_NEEDED.md").is_file()
        assert (work / "iteration_count").read_text(encoding="utf-8").strip() == "0"

    def test_botference_archive_uses_suffix_when_archive_dir_exists(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        work = tmp_path / "work"
        work.mkdir()
        build = tmp_path / "build"
        build.mkdir()
        (work / "checkpoint.md").write_text(
            "**Thread:** demo-thread\n"
            "**Last updated:** 2026-03-29\n",
            encoding="utf-8",
        )
        (work / "implementation-plan.md").write_text(
            "- [ ] 1. Demo task **coder**\n",
            encoding="utf-8",
        )
        (work / "HUMAN_REVIEW_NEEDED.md").write_text(
            "# HUMAN REVIEW NEEDED\n",
            encoding="utf-8",
        )
        (work / "inbox.md").write_text("", encoding="utf-8")
        (tmp_path / "CHANGELOG.md").write_text("# CHANGELOG\n", encoding="utf-8")
        (work / "iteration_count").write_text("1\n", encoding="utf-8")
        (build / "logs").mkdir()
        (build / "logs" / "usage.jsonl").write_text("", encoding="utf-8")
        (tmp_path / "archive" / "2026-03-29_demo-thread").mkdir(parents=True)

        result = subprocess.run(
            [str(repo_root / "botference"), "archive"],
            cwd=tmp_path,
            env={
                **os.environ,
                "BOTFERENCE_HOME": str(repo_root),
            },
            capture_output=True,
            text=True,
            timeout=10,
        )

        assert result.returncode == 0, result.stderr
        assert "Archive target exists" in result.stdout
        assert (tmp_path / "archive" / "2026-03-29_demo-thread_2").is_dir()

    def _setup_archive_project(self, tmp_path):
        """Helper: minimal project layout for archive tests."""
        repo_root = Path(__file__).resolve().parent.parent
        work = tmp_path / "work"
        work.mkdir()
        build = tmp_path / "build"
        build.mkdir()
        (work / "checkpoint.md").write_text(
            "**Thread:** demo-thread\n"
            "**Last updated:** 2026-03-29\n",
            encoding="utf-8",
        )
        (work / "implementation-plan.md").write_text(
            "- [ ] 1. Demo task **coder**\n",
            encoding="utf-8",
        )
        (work / "HUMAN_REVIEW_NEEDED.md").write_text(
            "# HUMAN REVIEW NEEDED\n",
            encoding="utf-8",
        )
        (work / "inbox.md").write_text("", encoding="utf-8")
        (tmp_path / "CHANGELOG.md").write_text("# CHANGELOG\n", encoding="utf-8")
        (work / "iteration_count").write_text("1\n", encoding="utf-8")
        (build / "logs").mkdir()
        (build / "logs" / "usage.jsonl").write_text("", encoding="utf-8")
        return repo_root, work

    def _run_archive(self, tmp_path, repo_root):
        return subprocess.run(
            [str(repo_root / "botference"), "archive"],
            cwd=tmp_path,
            env={**os.environ, "BOTFERENCE_HOME": str(repo_root)},
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_archive_moves_handoff_history(self, tmp_path):
        repo_root, work = self._setup_archive_project(tmp_path)
        # Create handoff history directory with files
        hist = work / "handoffs" / "claude"
        hist.mkdir(parents=True)
        (hist / "2026-03-29T12-00-00Z_handoff.md").write_text(
            "---\nmodel: claude\n---\n## Objective\ntest\n", encoding="utf-8"
        )
        hist_codex = work / "handoffs" / "codex"
        hist_codex.mkdir(parents=True)
        (hist_codex / "2026-03-29T13-00-00Z_handoff.md").write_text(
            "---\nmodel: codex\n---\n## Objective\ntest\n", encoding="utf-8"
        )

        result = self._run_archive(tmp_path, repo_root)
        assert result.returncode == 0, result.stderr

        archive_dir = tmp_path / "archive" / "2026-03-29_demo-thread"
        # History moved into archive
        assert (archive_dir / "handoffs" / "claude" / "2026-03-29T12-00-00Z_handoff.md").is_file()
        assert (archive_dir / "handoffs" / "codex" / "2026-03-29T13-00-00Z_handoff.md").is_file()
        # Original history dir removed
        assert not (work / "handoffs").exists()
        assert "Archived handoff history" in result.stdout

    def test_archive_clears_live_handoff_files(self, tmp_path):
        repo_root, work = self._setup_archive_project(tmp_path)
        (work / "handoff-claude.md").write_text("live claude handoff", encoding="utf-8")
        (work / "handoff-codex.md").write_text("live codex handoff", encoding="utf-8")

        result = self._run_archive(tmp_path, repo_root)
        assert result.returncode == 0, result.stderr

        assert not (work / "handoff-claude.md").exists()
        assert not (work / "handoff-codex.md").exists()

    def test_archive_succeeds_without_handoff_files(self, tmp_path):
        """Archive works cleanly when no relay has ever occurred."""
        repo_root, work = self._setup_archive_project(tmp_path)
        # No handoff files or directories created

        result = self._run_archive(tmp_path, repo_root)
        assert result.returncode == 0, result.stderr

        archive_dir = tmp_path / "archive" / "2026-03-29_demo-thread"
        assert archive_dir.is_dir()
        assert not (archive_dir / "handoffs").exists()
        assert "Archived handoff history" not in result.stdout

    def test_archive_supports_project_local_botference_dir(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        project_dir = tmp_path / "botference"
        build = project_dir / "build"
        project_dir.mkdir()
        build.mkdir()
        (project_dir / "checkpoint.md").write_text(
            "**Thread:** demo-thread\n"
            "**Last updated:** 2026-03-29\n",
            encoding="utf-8",
        )
        (project_dir / "implementation-plan.md").write_text(
            "- [ ] 1. Demo task **coder**\n",
            encoding="utf-8",
        )
        (project_dir / "HUMAN_REVIEW_NEEDED.md").write_text(
            "# HUMAN REVIEW NEEDED\n",
            encoding="utf-8",
        )
        (project_dir / "inbox.md").write_text("operator note\n", encoding="utf-8")
        (project_dir / "CHANGELOG.md").write_text("# CHANGELOG\n\nentry\n", encoding="utf-8")
        (project_dir / "iteration_count").write_text("7\n", encoding="utf-8")
        (build / "logs").mkdir()
        (build / "logs" / "usage.jsonl").write_text("", encoding="utf-8")

        result = subprocess.run(
            [str(repo_root / "botference"), "archive"],
            cwd=tmp_path,
            env={
                **os.environ,
                "BOTFERENCE_HOME": str(repo_root),
            },
            capture_output=True,
            text=True,
            timeout=10,
        )

        assert result.returncode == 0, result.stderr
        archive_dir = tmp_path / "botference" / "archive" / "2026-03-29_demo-thread"
        assert archive_dir.is_dir()
        assert (archive_dir / "checkpoint.md").is_file()
        assert (archive_dir / "implementation-plan.md").is_file()
        assert (archive_dir / "CHANGELOG.md").is_file()
        assert (project_dir / "checkpoint.md").is_file()
        assert (project_dir / "implementation-plan.md").is_file()
        assert (project_dir / "iteration_count").read_text(encoding="utf-8").strip() == "0"


class TestProjectLocalPolicy:
    def test_framework_agents_are_not_treated_as_project_overrides_in_self_hosted_layout(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        built_in_agents = tmp_path / ".claude" / "agents"
        built_in_agents.mkdir(parents=True)
        (built_in_agents / "coder.md").write_text("# coder\n", encoding="utf-8")

        cmd = f'''
source "{repo_root / "lib" / "config.sh"}"
export BOTFERENCE_HOME="{tmp_path}"
export BOTFERENCE_PROJECT_ROOT="{tmp_path}"
init_botference_paths
validate_project_agents
'''
        result = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
            text=True,
            cwd=tmp_path,
            timeout=10,
        )

        assert result.returncode == 0, result.stderr
        assert result.stderr == ""

    def test_build_mode_can_be_disabled_per_project(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        project_dir = tmp_path / "botference"
        project_dir.mkdir()
        (project_dir / "project.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "profile": "vault-drafter",
                    "modes": {"plan": True, "research_plan": True, "build": False},
                    "write_roots": {"plan": ["botference"], "build": ["botference"]},
                    "agent_overrides": [],
                }
            ),
            encoding="utf-8",
        )

        result = subprocess.run(
            [str(repo_root / "botference"), "build"],
            cwd=tmp_path,
            env={
                **os.environ,
                "BOTFERENCE_HOME": str(repo_root),
            },
            capture_output=True,
            text=True,
            timeout=10,
        )

        assert result.returncode == 1
        assert "disabled by" in result.stderr
        assert "project.json" in result.stderr

    def test_reserved_project_agent_requires_explicit_override(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        project_dir = tmp_path / "botference"
        agents_dir = project_dir / "agents"
        agents_dir.mkdir(parents=True)
        (project_dir / "project.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "profile": "vault-drafter",
                    "modes": {"plan": True, "research_plan": True, "build": True},
                    "write_roots": {"plan": ["botference"], "build": ["botference"]},
                    "agent_overrides": [],
                }
            ),
            encoding="utf-8",
        )
        (agents_dir / "coder.md").write_text("# coder\n", encoding="utf-8")

        result = subprocess.run(
            [str(repo_root / "botference"), "archive"],
            cwd=tmp_path,
            env={
                **os.environ,
                "BOTFERENCE_HOME": str(repo_root),
            },
            capture_output=True,
            text=True,
            timeout=10,
        )

        assert result.returncode == 1
        assert "shadows a built-in agent" in result.stderr
        assert "agent_overrides" in result.stderr

    def test_init_project_uses_custom_project_dir_name(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        custom_dir = "state"

        result = subprocess.run(
            [sys.executable, str(repo_root / "scripts" / "init_project.py"), "--profile", "vault-drafter"],
            cwd=tmp_path,
            env={
                **os.environ,
                "BOTFERENCE_HOME": str(repo_root),
                "BOTFERENCE_PROJECT_ROOT": str(tmp_path),
                "BOTFERENCE_PROJECT_DIR_NAME": custom_dir,
            },
            capture_output=True,
            text=True,
            timeout=10,
        )

        assert result.returncode == 0, result.stderr
        project_dir = tmp_path / custom_dir
        assert project_dir.is_dir()
        policy = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
        assert policy["write_roots"]["plan"] == [custom_dir]
        assert policy["write_roots"]["build"] == [custom_dir]

    def test_non_git_snapshot_scopes_to_owned_paths(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        project_dir = tmp_path / "botference"
        build_dir = project_dir / "build"
        wiki_dir = project_dir / "wiki"
        project_dir.mkdir()
        build_dir.mkdir()
        wiki_dir.mkdir()
        (project_dir / "project.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "profile": "vault-drafter",
                    "modes": {"plan": True, "research_plan": True, "build": True},
                    "write_roots": {
                        "plan": ["botference"],
                        "build": ["botference/build", "botference/wiki"],
                    },
                    "agent_overrides": [],
                }
            ),
            encoding="utf-8",
        )
        (project_dir / "checkpoint.md").write_text("checkpoint\n", encoding="utf-8")
        (build_dir / "draft.md").write_text("draft\n", encoding="utf-8")
        (wiki_dir / "entry.md").write_text("entry\n", encoding="utf-8")
        (tmp_path / "large-note.md").write_text("outside scope\n", encoding="utf-8")

        cmd = f'''
source "{repo_root / "lib" / "config.sh"}"
source "{repo_root / "lib" / "post-run.sh"}"
export BOTFERENCE_HOME="{repo_root}"
export BOTFERENCE_PROJECT_ROOT="{tmp_path}"
init_botference_paths
snapshot=$(mktemp)
plan_write_state_snapshot "$snapshot" build
cut -f2 "$snapshot"
'''
        result = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
            text=True,
            cwd=tmp_path,
            timeout=10,
        )

        assert result.returncode == 0, result.stderr
        paths = set(filter(None, result.stdout.splitlines()))
        assert "botference/checkpoint.md" in paths
        assert "botference/build/draft.md" in paths
        assert "botference/wiki/entry.md" in paths
        assert "large-note.md" in paths

    def test_project_local_plan_policy_allows_any_work_file(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        project_dir = tmp_path / "botference"
        exports_dir = project_dir / "exports"
        project_dir.mkdir()
        exports_dir.mkdir()
        (project_dir / "project.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "profile": "vault-drafter",
                    "modes": {"plan": True, "research_plan": True, "build": True},
                    "write_roots": {"plan": ["botference"], "build": ["botference"]},
                    "agent_overrides": [],
                }
            ),
            encoding="utf-8",
        )
        work_file = exports_dir / "caucus.md"
        outside_file = tmp_path / "notes.md"
        work_file.write_text("export\n", encoding="utf-8")
        outside_file.write_text("outside\n", encoding="utf-8")

        cmd = f'''
source "{repo_root / "lib" / "config.sh"}"
export BOTFERENCE_HOME="{repo_root}"
export BOTFERENCE_PROJECT_ROOT="{tmp_path}"
init_botference_paths
policy_path_allowed "{work_file}" plan && echo work-ok
policy_path_allowed "{outside_file}" plan && echo outside-ok
true
'''
        result = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
            text=True,
            cwd=tmp_path,
            timeout=10,
        )

        assert result.returncode == 0, result.stderr
        lines = set(filter(None, result.stdout.splitlines()))
        assert "work-ok" in lines
        assert "outside-ok" not in lines

    def test_project_local_plan_policy_requires_explicit_roots(self, tmp_path):
        repo_root = Path(__file__).resolve().parent.parent
        project_dir = tmp_path / "botference"
        exports_dir = project_dir / "exports"
        project_dir.mkdir()
        exports_dir.mkdir()
        (project_dir / "project.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "profile": "vault-drafter",
                    "modes": {"plan": True, "research_plan": True, "build": True},
                    "write_roots": {"plan": [], "build": ["botference"]},
                    "agent_overrides": [],
                }
            ),
            encoding="utf-8",
        )
        work_file = exports_dir / "caucus.md"

        cmd = f'''
source "{repo_root / "lib" / "config.sh"}"
export BOTFERENCE_HOME="{repo_root}"
export BOTFERENCE_PROJECT_ROOT="{tmp_path}"
init_botference_paths
policy_path_allowed "{work_file}" plan && echo work-ok
true
'''
        result = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
            text=True,
            cwd=tmp_path,
            timeout=10,
        )

        assert result.returncode == 0, result.stderr
        lines = set(filter(None, result.stdout.splitlines()))
        assert "work-ok" not in lines


class TestPlanningPromptPolicy:
    def test_plan_dispatcher_is_lazy_and_shell_limited(self):
        text = (Path(__file__).resolve().parent.parent / "prompts" / "plan.md").read_text(encoding="utf-8")
        assert "inspect only the files and paths needed" in text
        assert "scan the whole workspace up front" not in text
        assert "Scan the workspace first" not in text
        assert "`git diff`" in text

    def test_plan_agent_prompt_is_lazy_and_shell_limited(self):
        text = (Path(__file__).resolve().parent.parent / ".claude" / "agents" / "plan.md").read_text(encoding="utf-8")
        assert "inspect only the files and paths needed" in text
        assert "Read / Glob / Grep / Bash / WebSearch / WebFetch" in text
        assert "`git diff`" in text


# ── Relay command parsing ─────────────────────────────────


class TestRelayParsing:
    """parse_input for all relay command forms."""

    # ── canonical: /relay @model ──

    def test_relay_at_claude(self):
        p = parse_input("/relay @claude")
        assert p.kind is InputKind.RELAY
        assert p.target == "claude"

    def test_relay_at_codex(self):
        p = parse_input("/relay @codex")
        assert p.kind is InputKind.RELAY
        assert p.target == "codex"

    # ── canonical without @: /relay model ──

    def test_relay_claude_no_at(self):
        p = parse_input("/relay claude")
        assert p.kind is InputKind.RELAY
        assert p.target == "claude"

    def test_relay_codex_no_at(self):
        p = parse_input("/relay codex")
        assert p.kind is InputKind.RELAY
        assert p.target == "codex"

    # ── hyphenated aliases: /relay-claude, /relay-codex ──

    def test_relay_hyphen_claude(self):
        p = parse_input("/relay-claude")
        assert p.kind is InputKind.RELAY
        assert p.target == "claude"

    def test_relay_hyphen_codex(self):
        p = parse_input("/relay-codex")
        assert p.kind is InputKind.RELAY
        assert p.target == "codex"

    # ── /tag alias ──

    def test_tag_at_claude(self):
        p = parse_input("/tag @claude")
        assert p.kind is InputKind.RELAY
        assert p.target == "claude"

    def test_tag_at_codex(self):
        p = parse_input("/tag @codex")
        assert p.kind is InputKind.RELAY
        assert p.target == "codex"

    def test_tag_claude_no_at(self):
        p = parse_input("/tag claude")
        assert p.kind is InputKind.RELAY
        assert p.target == "claude"

    def test_tag_codex_no_at(self):
        p = parse_input("/tag codex")
        assert p.kind is InputKind.RELAY
        assert p.target == "codex"

    # ── case insensitivity ──

    def test_relay_case_insensitive(self):
        p = parse_input("/Relay @Claude")
        assert p.kind is InputKind.RELAY
        assert p.target == "claude"

    def test_tag_case_insensitive(self):
        p = parse_input("/TAG @CODEX")
        assert p.kind is InputKind.RELAY
        assert p.target == "codex"

    def test_relay_hyphen_case_insensitive(self):
        p = parse_input("/Relay-Claude")
        assert p.kind is InputKind.RELAY
        assert p.target == "claude"

    # ── all aliases produce identical ParsedInput ──

    def test_all_claude_aliases_equivalent(self):
        forms = [
            "/relay @claude",
            "/relay claude",
            "/relay-claude",
            "/tag @claude",
            "/tag claude",
        ]
        results = [parse_input(f) for f in forms]
        for r in results:
            assert r.kind is InputKind.RELAY
            assert r.target == "claude"

    def test_all_codex_aliases_equivalent(self):
        forms = [
            "/relay @codex",
            "/relay codex",
            "/relay-codex",
            "/tag @codex",
            "/tag codex",
        ]
        results = [parse_input(f) for f in forms]
        for r in results:
            assert r.kind is InputKind.RELAY
            assert r.target == "codex"

    # ── invalid relay forms ──

    def test_relay_no_target(self):
        p = parse_input("/relay")
        assert p.kind is InputKind.RELAY
        assert p.target == ""

    def test_tag_no_target(self):
        p = parse_input("/tag")
        assert p.kind is InputKind.RELAY
        assert p.target == ""

    def test_relay_at_all_invalid(self):
        p = parse_input("/relay @all")
        assert p.kind is InputKind.RELAY
        assert p.target == ""

    def test_relay_unknown_model(self):
        p = parse_input("/relay @gemini")
        assert p.kind is InputKind.RELAY
        assert p.target == ""

    def test_tag_unknown_model(self):
        p = parse_input("/tag random")
        assert p.kind is InputKind.RELAY
        assert p.target == ""

    def test_relay_with_trailing_text(self):
        """Extra args after the model are rejected."""
        p = parse_input("/relay @claude extra stuff")
        assert p.kind is InputKind.RELAY
        assert p.target == ""


# ── Relay dispatch ────────────────────────────────────────


@pytest.mark.asyncio
class TestBotferenceRelay:
    async def test_relay_invalid_target_shows_usage(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/relay", ui)
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("usage" in t.lower() for t in system_msgs)

    async def test_relay_at_all_shows_usage(self):
        c, _, _, ui = _make_botference()
        await c.handle_input("/relay @all", ui)
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("usage" in t.lower() for t in system_msgs)

    async def test_relay_no_session_shows_error(self):
        """Relay target with no active session should explain the issue."""
        c, _, _, ui = _make_botference()
        await c.handle_input("/relay @claude", ui)
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("no active session" in t.lower() for t in system_msgs)

    async def test_relay_with_active_session_dispatches(self):
        """Relay target with an active session reaches _relay_model."""
        c, _, _, ui = _make_botference(
            claude_responses=[_ok("init")],
        )
        # Initialize claude first
        await c.handle_input("@claude hello", ui)
        ui.room_entries.clear()
        # Now relay
        await c.handle_input("/relay @claude", ui)
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        # Should NOT see "no active session" — should reach the stub
        assert not any("no active session" in t.lower() for t in system_msgs)

    async def test_relay_aliases_all_reach_same_dispatch(self):
        """All valid relay forms for a model hit the same code path."""
        forms = [
            "/relay @claude",
            "/relay claude",
            "/relay-claude",
            "/tag @claude",
            "/tag claude",
        ]
        for form in forms:
            c, _, _, ui = _make_botference(claude_responses=[_ok("init")])
            await c.handle_input("@claude setup", ui)
            ui.room_entries.clear()
            await c.handle_input(form, ui)
            system_msgs = [t for s, t in ui.room_entries if s == "system"]
            # All should reach the relay stub, not show usage error
            assert not any("usage" in t.lower() for t in system_msgs), (
                f"Form {form!r} showed usage error instead of dispatching"
            )

    async def test_relay_does_not_affect_router(self):
        """Relay command should not change the auto-router's current route."""
        c, _, _, ui = _make_botference(
            claude_responses=[_ok("init")],
        )
        await c.handle_input("@claude hello", ui)
        assert c.router.current_route == "@claude"
        await c.handle_input("/relay @claude", ui)
        assert c.router.current_route == "@claude"


# ── Relay controller state (task 3) ──────────────────────


class TestRelayTierConstants:
    def test_constants_exist_and_ordered(self):
        from botference import RELAY_TIER_SELF_MAX, RELAY_TIER_CROSS_MAX
        assert RELAY_TIER_SELF_MAX < RELAY_TIER_CROSS_MAX
        assert RELAY_TIER_SELF_MAX == 70
        assert RELAY_TIER_CROSS_MAX == 90


class TestYieldPressureStorage:
    def test_update_pct_stores_yield_pressure(self):
        """_update_pct stores normalized yield pressure from adapter.context_percent."""
        c, claude, codex, ui = _make_botference()
        resp = AdapterResponse(
            text="test", input_tokens=50000, context_window=200000,
        )
        claude.context_percent = lambda r: 42.5
        claude.context_tokens = lambda r: 50000
        c._update_pct("claude", resp)
        assert c.yield_pressure("claude") == pytest.approx(42.5)

    def test_yield_pressure_defaults_to_zero(self):
        """yield_pressure returns 0.0 for models with no recorded pressure."""
        c, _, _, _ = _make_botference()
        assert c.yield_pressure("claude") == 0.0
        assert c.yield_pressure("codex") == 0.0

    def test_yield_pressure_independent_per_model(self):
        """Each model tracks its own yield pressure independently."""
        c, claude, codex, ui = _make_botference()
        resp_c = AdapterResponse(text="c", input_tokens=80000, context_window=1000000)
        resp_x = AdapterResponse(text="x", input_tokens=50000, context_window=200000)
        claude.context_percent = lambda r: 35.0
        claude.context_tokens = lambda r: 80000
        codex.context_percent = lambda r: 78.0
        codex.context_tokens = lambda r: 50000
        c._update_pct("claude", resp_c)
        c._update_pct("codex", resp_x)
        assert c.yield_pressure("claude") == pytest.approx(35.0)
        assert c.yield_pressure("codex") == pytest.approx(78.0)

    def test_yield_pressure_updates_on_each_turn(self):
        """yield_pressure reflects the most recent _update_pct call."""
        c, claude, _, _ = _make_botference()
        resp1 = AdapterResponse(text="t1", input_tokens=10000, context_window=200000)
        claude.context_percent = lambda r: 20.0
        claude.context_tokens = lambda r: 10000
        c._update_pct("claude", resp1)
        assert c.yield_pressure("claude") == pytest.approx(20.0)

        resp2 = AdapterResponse(text="t2", input_tokens=90000, context_window=200000)
        claude.context_percent = lambda r: 85.0
        claude.context_tokens = lambda r: 90000
        c._update_pct("claude", resp2)
        assert c.yield_pressure("claude") == pytest.approx(85.0)

    def test_yield_pressure_stored_alongside_raw_occupancy(self):
        """Both raw occupancy and normalized yield pressure are stored together."""
        c, claude, _, _ = _make_botference()
        resp = AdapterResponse(text="t", input_tokens=100000, context_window=1000000)
        claude.context_percent = lambda r: 50.0
        claude.context_tokens = lambda r: 100000
        c._update_pct("claude", resp)
        # Raw occupancy: 100000/1000000 = 10%
        assert c._claude_pct == pytest.approx(10.0)
        # Normalized yield pressure: 50%
        assert c.yield_pressure("claude") == pytest.approx(50.0)


class TestRelayBoundary:
    def test_relay_boundary_none_by_default(self):
        """relay_boundary returns None for models with no relay."""
        c, _, _, _ = _make_botference()
        assert c.relay_boundary("claude") is None
        assert c.relay_boundary("codex") is None

    def test_set_relay_boundary_records_last_turn_index(self):
        """set_relay_boundary records the turn_index of the last transcript entry."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "hello")
        c.transcript.add("claude", "hi back")
        c.set_relay_boundary("claude")
        assert c.relay_boundary("claude") == 1  # second entry, 0-indexed

    def test_relay_boundary_empty_transcript(self):
        """set_relay_boundary on empty transcript records -1."""
        c, _, _, _ = _make_botference()
        c.set_relay_boundary("claude")
        assert c.relay_boundary("claude") == -1

    def test_relay_boundary_independent_per_model(self):
        """Each model's relay boundary is tracked independently."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "msg 1")
        c.set_relay_boundary("claude")
        c.transcript.add("user", "msg 2")
        c.transcript.add("codex", "reply")
        c.set_relay_boundary("codex")
        assert c.relay_boundary("claude") == 0
        assert c.relay_boundary("codex") == 2

    def test_relay_boundary_updates_on_second_relay(self):
        """A second relay for the same model updates the boundary."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "msg 1")
        c.set_relay_boundary("claude")
        assert c.relay_boundary("claude") == 0
        c.transcript.add("user", "msg 2")
        c.transcript.add("claude", "reply")
        c.set_relay_boundary("claude")
        assert c.relay_boundary("claude") == 2


# ── Relay generation (task 5) ────────────────────────────

from paths import BotferencePaths
from botference import RELAY_TIER_SELF_MAX, RELAY_TIER_CROSS_MAX

_VALID_HANDOFF_BODY = """\
## Objective
Test relay objective

## Resolved Decisions
None

## Open Questions
None

## Positions In Play

### Converging
None

### Contested
None

## Constraints
None

## Current Thread
Testing relay

## Response Obligation
Continue testing

## Decision Criteria
None

## Next Action
Proceed with next step
"""


def _make_relay_botference(
    tmp_path,
    claude_responses=None,
    codex_responses=None,
):
    """Create a Botference with paths pointing to tmp_path for file-write tests."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    archive_dir = tmp_path / "archive"
    archive_dir.mkdir()
    # botference_home must point to the repo root so prompts/relay.md is found
    repo_root = Path(__file__).resolve().parent.parent
    paths = BotferencePaths(
        botference_home=repo_root,
        project_root=tmp_path,
        project_dir=tmp_path,
        work_dir=work_dir,
        build_dir=tmp_path,
        archive_dir=archive_dir,
    )
    claude = MockAdapter(claude_responses or [_ok("init")])
    codex = MockAdapter(codex_responses or [_ok("init")])
    ui = MockUI()
    c = Botference(
        claude=claude, codex=codex,
        system_prompt="Test prompt", task="Test task",
        paths=paths,
    )
    return c, claude, codex, ui, work_dir


@pytest.mark.asyncio
class TestRelayGeneration:
    """Task 5: relay generation with tier selection, file writes, teardown."""

    async def test_self_authored_relay_success(self, tmp_path):
        """Self-authored relay immediately restarts and keeps only history."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY), _ok("fresh")],
        )
        # Initialize claude
        await c.handle_input("@claude hello", ui)
        ui.room_entries.clear()

        # Relay claude
        await c.handle_input("/relay @claude", ui)

        # Room confirmation
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed claude" in t.lower() for t in system_msgs)
        assert any("tier: self" in t.lower() for t in system_msgs)
        assert any("started a fresh session" in t.lower() for t in system_msgs)

        # No success-path live file remains
        live_file = work_dir / "handoff-claude.md"
        assert not live_file.exists()

        # History file written
        history_dir = work_dir / "handoffs" / "claude"
        assert history_dir.exists()
        history_files = list(history_dir.iterdir())
        assert len(history_files) == 1
        assert history_files[0].name.endswith("_handoff.md")
        content = history_files[0].read_text()
        assert "model: claude" in content
        assert "generation_tier: self" in content
        assert "## Objective" in content

        # Relay restarts immediately
        assert len(claude.send_calls) == 2
        assert "claude" in c._models_initialized

    async def test_self_authored_relay_codex(self, tmp_path):
        """Self-authored relay works for codex too."""
        c, _, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            codex_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY), _ok("fresh")],
        )
        await c.handle_input("@codex hello", ui)
        ui.room_entries.clear()

        await c.handle_input("/relay @codex", ui)

        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed codex" in t.lower() for t in system_msgs)
        assert not (work_dir / "handoff-codex.md").exists()
        assert (work_dir / "handoffs" / "codex").exists()
        assert len(codex.send_calls) == 2
        assert "codex" in c._models_initialized

    async def test_cross_authored_relay(self, tmp_path):
        """Cross-authored tier used when yield pressure is moderate."""
        c, claude, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY)],
            codex_responses=[_ok("init")],
        )
        # Initialize both models
        await c.handle_input("@claude hello", ui)
        await c.handle_input("@codex hello", ui)

        # Set claude's yield pressure to cross tier (>= 70, < 90)
        c._yield_pressure["codex"] = 75.0
        ui.room_entries.clear()

        # Relay codex — claude (peer) generates the handoff
        await c.handle_input("/relay @codex", ui)

        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed codex" in t.lower() for t in system_msgs)
        assert any("tier: cross" in t.lower() for t in system_msgs)

    async def test_cross_skipped_when_peer_not_initialized(self, tmp_path):
        """Cross tier is skipped when peer has no session; falls to mechanical."""
        c, claude, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            codex_responses=[_ok("init")],
        )
        # Only init codex, not claude
        await c.handle_input("@codex hello", ui)
        # Set codex pressure to cross range
        c._yield_pressure["codex"] = 75.0
        ui.room_entries.clear()

        # Relay codex — cross should be skipped (claude not init'd),
        # falls through to mechanical which succeeds
        await c.handle_input("/relay @codex", ui)

        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed codex" in t.lower() for t in system_msgs)
        assert any("tier: mechanical" in t.lower() for t in system_msgs)

    async def test_fallthrough_self_to_cross(self, tmp_path):
        """When self-authored fails validation, falls through to cross."""
        c, claude, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            # claude: init + bad self body; then good cross body for codex
            claude_responses=[_ok("init"), _ok("bad body no headings")],
            codex_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY)],
        )
        # Initialize both
        await c.handle_input("@claude hello", ui)
        await c.handle_input("@codex hello", ui)
        ui.room_entries.clear()

        # Relay claude — self fails validation, falls to cross (codex generates)
        await c.handle_input("/relay @claude", ui)

        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed claude" in t.lower() for t in system_msgs)
        assert any("tier: cross" in t.lower() for t in system_msgs)

    async def test_self_fails_falls_to_mechanical(self, tmp_path):
        """Self-authored fails; mechanical fallback succeeds."""
        c, claude, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok("bad body"), _ok("fresh")],
        )
        await c.handle_input("@claude hello", ui)
        ui.room_entries.clear()

        await c.handle_input("/relay @claude", ui)

        # Mechanical fallback succeeds
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed claude" in t.lower() for t in system_msgs)
        assert any("tier: mechanical" in t.lower() for t in system_msgs)

        # Only history remains on success
        assert not (work_dir / "handoff-claude.md").exists()
        assert (work_dir / "handoffs" / "claude").exists()

    async def test_relay_immediately_reinitializes_claude(self, tmp_path):
        """Relay tears down the old session and immediately starts a new one."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY), _ok("fresh")],
        )
        await c.handle_input("@claude hello", ui)
        await c.handle_input("/relay @claude", ui)

        assert len(claude.send_calls) == 2
        assert "claude" in c._models_initialized

    async def test_relay_immediately_reinitializes_codex(self, tmp_path):
        """Relay tears down the old Codex session and immediately starts a new one."""
        c, _, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            codex_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY), _ok("fresh")],
        )
        await c.handle_input("@codex hello", ui)
        await c.handle_input("/relay @codex", ui)

        assert len(codex.send_calls) == 2
        assert "codex" in c._models_initialized

    async def test_relay_boundary_recorded(self, tmp_path):
        """Relay records the transcript boundary index."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY)],
        )
        await c.handle_input("@claude hello", ui)
        assert c.relay_boundary("claude") is None

        await c.handle_input("/relay @claude", ui)
        assert c.relay_boundary("claude") is not None
        assert c.relay_boundary("claude") >= 0

    async def test_relay_warned_overlimit_cleared(self, tmp_path):
        """Teardown clears over-limit warning state."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY)],
        )
        await c.handle_input("@claude hello", ui)
        c._warned_overlimit_models.add("claude")
        await c.handle_input("/relay @claude", ui)

        assert "claude" not in c._warned_overlimit_models

    async def test_tier_sequence_low_pressure(self):
        """Low pressure → self, cross, mechanical."""
        c, _, _, _ = _make_botference()
        seq = c._relay_tier_sequence("claude", 30.0)
        assert seq == ["self", "cross", "mechanical"]

    async def test_tier_sequence_moderate_pressure(self):
        """Moderate pressure → cross, mechanical."""
        c, _, _, _ = _make_botference()
        seq = c._relay_tier_sequence("claude", 75.0)
        assert seq == ["cross", "mechanical"]

    async def test_tier_sequence_high_pressure(self):
        """High pressure → mechanical only."""
        c, _, _, _ = _make_botference()
        seq = c._relay_tier_sequence("claude", 95.0)
        assert seq == ["mechanical"]

    async def test_tier_sequence_boundary_self(self):
        """Exactly at RELAY_TIER_SELF_MAX → cross, mechanical."""
        c, _, _, _ = _make_botference()
        seq = c._relay_tier_sequence("claude", float(RELAY_TIER_SELF_MAX))
        assert seq == ["cross", "mechanical"]

    async def test_tier_sequence_boundary_cross(self):
        """Exactly at RELAY_TIER_CROSS_MAX → mechanical only."""
        c, _, _, _ = _make_botference()
        seq = c._relay_tier_sequence("claude", float(RELAY_TIER_CROSS_MAX))
        assert seq == ["mechanical"]

    async def test_handoff_doc_frontmatter_fields(self, tmp_path):
        """Generated handoff document has correct frontmatter fields."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY), _ok("fresh")],
        )
        await c.handle_input("@claude hello", ui)
        await c.handle_input("/relay @claude", ui)

        content = next((work_dir / "handoffs" / "claude").iterdir()).read_text()
        assert "model: claude" in content
        assert "session_id: mock-session" in content
        assert "room_mode: public" in content
        assert "lead: auto" in content
        assert "generation_tier: self" in content

    async def test_relay_strips_model_frontmatter(self, tmp_path):
        """If model includes frontmatter in response, it's stripped."""
        body_with_fm = (
            "---\nmodel: claude\nsession_id: bad\n---\n\n"
            + _VALID_HANDOFF_BODY
        )
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok(body_with_fm), _ok("fresh")],
        )
        await c.handle_input("@claude hello", ui)
        await c.handle_input("/relay @claude", ui)

        content = next((work_dir / "handoffs" / "claude").iterdir()).read_text()
        # Should have controller's frontmatter, not model's
        assert "session_id: mock-session" in content
        assert "session_id: bad" not in content

    async def test_relay_self_error_falls_through(self, tmp_path):
        """If self-authored resume raises, falls through to next tier."""
        c, claude, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init")],
            codex_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY)],
        )
        await c.handle_input("@claude hello", ui)
        await c.handle_input("@codex hello", ui)

        # Make claude.resume raise on the relay call
        original_next = claude._next
        call_count = [0]
        async def failing_resume(msg):
            call_count[0] += 1
            raise RuntimeError("connection lost")
        claude.resume = failing_resume
        ui.room_entries.clear()

        # Relay claude — self raises, falls to cross (codex)
        await c.handle_input("/relay @claude", ui)

        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed claude" in t.lower() for t in system_msgs)
        assert any("tier: cross" in t.lower() for t in system_msgs)

    async def test_successful_relay_keeps_history_only(self, tmp_path):
        """Successful relay keeps the archived handoff but not a live file."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY), _ok("fresh")],
        )
        await c.handle_input("@claude hello", ui)
        await c.handle_input("/relay @claude", ui)

        assert not (work_dir / "handoff-claude.md").exists()
        history_dir = work_dir / "handoffs" / "claude"
        history_file = list(history_dir.iterdir())[0]
        assert "generation_tier: self" in history_file.read_text()

    async def test_sequential_relay_both_models(self, tmp_path):
        """Relay claude then codex — both restart immediately and keep history only."""
        c, claude, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY), _ok("fresh")],
            codex_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY), _ok("fresh")],
        )
        # Initialize both models
        await c.handle_input("@claude hello", ui)
        await c.handle_input("@codex hello", ui)

        # Relay claude first (self tier, low pressure)
        ui.room_entries.clear()
        await c.handle_input("/relay @claude", ui)
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed claude" in t.lower() for t in system_msgs)
        assert "claude" in c._models_initialized

        # Now relay codex — both models should still end up initialized
        ui.room_entries.clear()
        await c.handle_input("/relay @codex", ui)
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed codex" in t.lower() for t in system_msgs)
        assert "codex" in c._models_initialized

        # Only history files should remain
        assert not (work_dir / "handoff-claude.md").exists()
        assert not (work_dir / "handoff-codex.md").exists()
        assert (work_dir / "handoffs" / "claude").exists()
        assert (work_dir / "handoffs" / "codex").exists()

    async def test_sequential_relay_second_can_use_cross(self, tmp_path):
        """After relaying claude, codex can still use cross tier because claude restarted."""
        c, claude, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[
                _ok("init"),
                _ok(_VALID_HANDOFF_BODY),
                _ok("fresh claude"),
                _ok(_VALID_HANDOFF_BODY),
            ],
            codex_responses=[_ok("init"), _ok(_VALID_HANDOFF_BODY), _ok("fresh codex")],
        )
        await c.handle_input("@claude hello", ui)
        await c.handle_input("@codex hello", ui)

        # Relay claude first
        await c.handle_input("/relay @claude", ui)

        # Set codex pressure to cross range
        c._yield_pressure["codex"] = 75.0
        ui.room_entries.clear()

        # Relay codex — cross tier should be available because claude restarted
        await c.handle_input("/relay @codex", ui)
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed codex" in t.lower() for t in system_msgs)
        assert any("tier: cross" in t.lower() for t in system_msgs)


# ── Task 6: Mechanical handoff generation ─────────────────


@pytest.mark.asyncio
class TestMechanicalHandoff:
    """Mechanical handoff generation from controller state alone."""

    def test_mechanical_returns_valid_body(self):
        """Mechanical generation produces a body with all required headings."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "Build the thing")
        c.transcript.add("claude", "Sure, I can help with that")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        # Must contain all required section headings
        for heading in [
            "## Objective",
            "## Resolved Decisions",
            "## Open Questions",
            "## Positions In Play",
            "### Converging",
            "### Contested",
            "## Constraints",
            "## Current Thread",
            "## Response Obligation",
            "## Decision Criteria",
            "## Next Action",
        ]:
            assert heading in body, f"Missing heading: {heading}"

    def test_mechanical_body_passes_validation(self):
        """Mechanical body + controller frontmatter passes full validation."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "Build the thing")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None

        from datetime import datetime, timezone
        from handoff import build_frontmatter, validate_handoff
        fm = build_frontmatter(
            model="claude", session_id="test-sess",
            created="2026-03-30T12:00:00Z",
            room_mode="public", lead="auto",
            yield_pct=95.0, context_tokens=180000,
            context_window=200000, generation_tier="mechanical",
        )
        result = validate_handoff(fm + "\n" + body)
        assert result.valid is True, f"Validation errors: {result.errors}"

    def test_mechanical_derives_objective_from_task(self):
        """Objective section uses the task when available."""
        c, _, _, _ = _make_botference()
        c.task = "Design a REST API for widgets"
        c.transcript.add("user", "let's start")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        assert "REST API" in body or "widgets" in body

    def test_mechanical_derives_objective_from_transcript(self):
        """Objective from transcript when task is empty."""
        c, _, _, _ = _make_botference()
        c.task = ""
        c.transcript.add("user", "We need to refactor the auth module")
        c.transcript.add("claude", "I can help with that")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        assert "refactor" in body.lower() or "auth" in body.lower()

    def test_mechanical_preserves_constraints(self):
        """Explicit user constraints are preserved."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "We must use Python and must not use async")
        c.transcript.add("claude", "Understood")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        assert "must use Python" in body or "Python" in body
        assert "must not use async" in body or "async" in body

    def test_mechanical_extracts_open_questions(self):
        """Unresolved questions from transcript appear in Open Questions."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "Which database should we use?")
        c.transcript.add("claude", "I'd suggest Postgres or SQLite")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        # The open question about database should be captured
        assert "database" in body.lower() or "Database" in body

    def test_mechanical_includes_recent_positions(self):
        """Recent attributed positions appear in Positions In Play."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "How should we structure the API?")
        c.transcript.add("claude", "I think we should use REST with versioning")
        c.transcript.add("codex", "GraphQL would be more flexible")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        # Positions should be attributed
        assert "Claude" in body or "claude" in body
        assert "Codex" in body or "codex" in body

    def test_mechanical_current_thread_from_tail(self):
        """Current Thread uses topic from recent turns."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "Let's talk about authentication")
        c.transcript.add("claude", "OK, for auth we could use JWT")
        c.transcript.add("user", "Now let's discuss the deployment strategy")
        c.transcript.add("claude", "For deployment, I suggest Docker")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        # Current thread should reflect the most recent topic
        assert "deployment" in body.lower() or "Docker" in body

    def test_mechanical_response_obligation(self):
        """Response Obligation states what the fresh model should do."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "What's the best caching strategy?")
        c.transcript.add("claude", "Let me think about this")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        # Should have some response obligation content
        obj_start = body.index("## Response Obligation")
        next_section = body.index("## Decision Criteria")
        obligation = body[obj_start:next_section].strip()
        assert len(obligation) > len("## Response Obligation")

    def test_mechanical_next_action(self):
        """Next Action has a concrete first step."""
        c, _, _, _ = _make_botference()
        c.transcript.add("user", "Build a REST API")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        # Next Action should have content
        action_start = body.index("## Next Action")
        action_text = body[action_start + len("## Next Action"):].strip()
        assert len(action_text) > 0

    def test_mechanical_empty_transcript_still_valid(self):
        """Mechanical handoff with no transcript produces valid document."""
        c, _, _, _ = _make_botference()
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None

        from handoff import build_frontmatter, validate_handoff
        fm = build_frontmatter(
            model="claude", session_id="s",
            created="2026-03-30T12:00:00Z",
            room_mode="public", lead="auto",
            yield_pct=95.0, context_tokens=0,
            context_window=200000, generation_tier="mechanical",
        )
        result = validate_handoff(fm + "\n" + body)
        assert result.valid is True, f"Validation errors: {result.errors}"

    def test_mechanical_includes_mode_and_lead(self):
        """Mechanical handoff reflects current room mode and lead."""
        c, _, _, _ = _make_botference()
        c.mode = RoomMode.CAUCUS
        c.lead = "@codex"
        c.transcript.add("user", "hello")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        assert "caucus" in body.lower() or "Caucus" in body

    async def test_mechanical_relay_end_to_end(self, tmp_path):
        """Full relay using mechanical tier writes valid files."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("init"), _ok("fresh")],
        )
        await c.handle_input("@claude hello", ui)
        # Set pressure to mechanical range
        c._yield_pressure["claude"] = 95.0
        ui.room_entries.clear()

        await c.handle_input("/relay @claude", ui)

        # Should succeed with mechanical tier
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed claude" in t.lower() for t in system_msgs)
        assert any("tier: mechanical" in t.lower() for t in system_msgs)

        # History file exists and is valid
        from handoff import validate_handoff
        history = next((work_dir / "handoffs" / "claude").iterdir()).read_text()
        result = validate_handoff(history)
        assert result.valid is True, f"Validation errors: {result.errors}"
        assert "generation_tier: mechanical" in history
        assert not (work_dir / "handoff-claude.md").exists()

    async def test_mechanical_fallback_from_failed_self(self, tmp_path):
        """When self tier fails, mechanical fallback succeeds."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            # init OK, self-authored returns bad body
            claude_responses=[_ok("init"), _ok("garbage with no headings"), _ok("fresh")],
        )
        await c.handle_input("@claude hello", ui)
        ui.room_entries.clear()

        await c.handle_input("/relay @claude", ui)

        # Should succeed via mechanical fallback
        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("relayed claude" in t.lower() for t in system_msgs)
        assert any("tier: mechanical" in t.lower() for t in system_msgs)

        from handoff import validate_handoff
        history = next((work_dir / "handoffs" / "claude").iterdir()).read_text()
        assert validate_handoff(history).valid is True
        assert not (work_dir / "handoff-claude.md").exists()

    def test_mechanical_tail_entries_limited(self):
        """Mechanical handoff uses tail of transcript, not entire history."""
        c, _, _, _ = _make_botference()
        # Add many entries
        for i in range(50):
            c.transcript.add("user", f"Message {i}")
            c.transcript.add("claude", f"Response {i}")
        c._models_initialized.add("claude")

        body = c._relay_generate_mechanical("claude")
        assert body is not None
        # Should not contain very early messages verbatim
        assert "Message 0" not in body
        # But should reference recent ones
        assert "Message 49" in body or "Response 49" in body


# ── Task 7: Bootstrap from handoff safely ─────────────────


class TestContextAfter:
    """Transcript.context_after filters entries by turn_index."""

    def test_returns_entries_after_boundary(self):
        t = Transcript()
        t.add("user", "before relay")
        t.add("claude", "pre-relay response")
        boundary = t.entries[-1].turn_index
        t.add("user", "after relay")
        t.add("codex", "post-relay codex")

        result = t.context_after(boundary)
        assert "after relay" in result
        assert "post-relay codex" in result
        assert "before relay" not in result
        assert "pre-relay response" not in result

    def test_returns_all_when_boundary_minus_one(self):
        t = Transcript()
        t.add("user", "first")
        t.add("claude", "second")
        result = t.context_after(-1)
        assert "first" in result
        assert "second" in result

    def test_empty_transcript(self):
        t = Transcript()
        result = t.context_after(-1)
        # Should still have ROOM_ROLE_SUFFIX
        assert result.strip() != ""

    def test_no_entries_after_boundary(self):
        t = Transcript()
        t.add("user", "only msg")
        boundary = t.entries[-1].turn_index
        result = t.context_after(boundary)
        assert "only msg" not in result


@pytest.mark.asyncio
class TestBootstrapFromHandoff:
    """Task 7: relay bootstrap is immediate and in-process only."""

    async def test_relay_immediately_bootstraps_on_success(self, tmp_path):
        """Successful relay immediately starts the fresh session and keeps only history."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[
                _ok("init"),
                _ok(_VALID_HANDOFF_BODY),
                _ok("fresh session response"),
            ],
        )
        await c.handle_input("@claude hello", ui)
        await c.handle_input("/relay @claude", ui)

        assert len(claude.send_calls) == 2
        assert "claude" in c._models_initialized
        assert not (work_dir / "handoff-claude.md").exists()
        history_dir = work_dir / "handoffs" / "claude"
        assert any(history_dir.iterdir()), "history copy should be preserved"

    async def test_failed_immediate_bootstrap_persists_diagnostic_handoff(self, tmp_path):
        """If the immediate restart fails, relay leaves a diagnostic live handoff."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[
                _ok("init"),
                _ok(_VALID_HANDOFF_BODY),
            ],
        )
        await c.handle_input("@claude hello", ui)

        original_send = claude.send

        async def fail_second_send(prompt):
            if len(claude.send_calls) >= 1:
                raise RuntimeError("connection failed")
            return await original_send(prompt)

        claude.send = fail_second_send
        await c.handle_input("/relay @claude", ui)

        live_file = work_dir / "handoff-claude.md"
        assert live_file.exists(), "failure should preserve a diagnostic handoff"
        assert "claude" not in c._models_initialized

    async def test_retry_after_failed_relay_uses_pending_handoff(self, tmp_path):
        """A retry in the same process consumes pending relay state, not the file."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[
                _ok("init"),
                _ok(_VALID_HANDOFF_BODY),
                _ok("fresh response"),
            ],
        )
        await c.handle_input("@claude hello", ui)

        original_send = claude.send

        async def fail_second_send(prompt):
            if len(claude.send_calls) >= 1:
                raise RuntimeError("connection failed")
            return await original_send(prompt)

        claude.send = fail_second_send
        await c.handle_input("/relay @claude", ui)

        live_file = work_dir / "handoff-claude.md"
        assert live_file.exists()

        claude.send = original_send
        ui.room_entries.clear()
        await c.handle_input("@claude continue", ui)

        assert "--- Handoff ---" in claude.send_calls[-1]
        assert not live_file.exists(), "successful retry clears the diagnostic handoff"
        assert "claude" in c._models_initialized

    async def test_relay_prompt_includes_handoff(self, tmp_path):
        """Immediate relay restart prompt contains the handoff document."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[
                _ok("init"),
                _ok(_VALID_HANDOFF_BODY),
                _ok("fresh response"),
            ],
        )
        await c.handle_input("@claude hello", ui)
        claude.send_calls.clear()
        await c.handle_input("/relay @claude", ui)

        assert len(claude.send_calls) >= 1
        prompt = claude.send_calls[-1]
        assert "--- Handoff ---" in prompt
        assert "## Objective" in prompt

    async def test_relay_excludes_pre_relay_history(self, tmp_path):
        """Immediate relay restart does not include pre-relay transcript entries."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[
                _ok("init"),
                _ok(_VALID_HANDOFF_BODY),
                _ok("fresh response"),
            ],
        )
        await c.handle_input("@claude tell me about unicorns", ui)
        claude.send_calls.clear()
        await c.handle_input("/relay @claude", ui)

        prompt = claude.send_calls[-1]
        assert "unicorns" not in prompt, "pre-relay history must be excluded"

    async def test_post_relay_message_uses_resume_not_send(self, tmp_path):
        """After a successful relay, the next user message continues the fresh session."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[
                _ok("init"),
                _ok(_VALID_HANDOFF_BODY),
                _ok("fresh response"),
                _ok("follow-up"),
            ],
        )
        await c.handle_input("@claude hello", ui)
        await c.handle_input("/relay @claude", ui)

        claude.send_calls.clear()
        claude.resume_calls.clear()
        await c.handle_input("@claude continue", ui)

        assert claude.send_calls == []
        assert len(claude.resume_calls) == 2 or len(claude.resume_calls) == 1
        assert "claude" in c._models_initialized

    async def test_bootstrap_without_handoff_works_normally(self, tmp_path):
        """First bootstrap without any relay/handoff works as before."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("hello response")],
        )

        live_file = work_dir / "handoff-claude.md"
        assert not live_file.exists()

        await c.handle_input("@claude hello", ui)

        # Normal bootstrap — no handoff in prompt
        assert len(claude.send_calls) == 1
        assert "--- Handoff ---" not in claude.send_calls[0]
        assert "claude" in c._models_initialized

    async def test_relay_shows_restarting_label(self, tmp_path):
        """Immediate relay restart should say 'Restarting', not 'Resuming'."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[
                _ok("init"),
                _ok(_VALID_HANDOFF_BODY),
                _ok("fresh response"),
            ],
        )
        await c.handle_input("@claude hello", ui)
        ui.room_entries.clear()
        await c.handle_input("/relay @claude", ui)

        system_msgs = [t for s, t in ui.room_entries if s == "system"]
        assert any("Restarting claude" in t for t in system_msgs)

    async def test_fresh_start_ignores_persisted_live_handoff_file(self, tmp_path):
        """A new controller instance must not auto-load a persisted handoff file."""
        c, claude, codex, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[
                _ok("fresh response"),
            ],
            codex_responses=[_ok("codex init")],
        )
        live_file = work_dir / "handoff-claude.md"
        live_file.write_text("---\nmodel: claude\n---\n\n## Objective\nstale\n", encoding="utf-8")

        await c.handle_input("@claude hello", ui)

        assert len(claude.send_calls) == 1
        assert "--- Handoff ---" not in claude.send_calls[0]
        assert live_file.exists(), "fresh sessions should ignore persisted handoff files"

    async def test_ensure_initialized_ignores_persisted_live_handoff_file(self, tmp_path):
        """_ensure_initialized should also ignore persisted live handoff files."""
        c, claude, _, ui, work_dir = _make_relay_botference(
            tmp_path,
            claude_responses=[_ok("fresh response")],
        )
        live_file = work_dir / "handoff-claude.md"
        live_file.write_text("---\nmodel: claude\n---\n\n## Objective\nstale\n", encoding="utf-8")

        result = await c._ensure_initialized("claude", ui)
        assert result is True
        assert "--- Handoff ---" not in claude.send_calls[0]
        assert live_file.exists()
