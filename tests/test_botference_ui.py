from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from botference_ui import (
    PaneFocus,
    RoomMode,
    StatusSnapshot,
    TranscriptEntry,
    _context_style,
    cycle_pane_focus,
    format_status_line,
    format_status_rich,
    pane_visual_state,
    render_transcript_entry,
    submission_policy,
)


class TestPaneFocus:
    def test_tab_cycles_room_to_caucus(self):
        assert cycle_pane_focus(PaneFocus.ROOM) is PaneFocus.CAUCUS

    def test_shift_tab_cycles_caucus_to_room(self):
        assert (
            cycle_pane_focus(PaneFocus.CAUCUS, backwards=True)
            is PaneFocus.ROOM
        )


class TestSubmissionPolicy:
    def test_room_focus_allows_plain_text(self):
        decision = submission_policy(PaneFocus.ROOM, "hello botference")
        assert decision.allow_submit is True
        assert decision.is_slash_command is False

    def test_caucus_focus_blocks_plain_text(self):
        decision = submission_policy(PaneFocus.CAUCUS, "hello botference")
        assert decision.allow_submit is False
        assert "Shift-Tab to Council" in decision.reason

    def test_caucus_focus_allows_slash_commands(self):
        decision = submission_policy(PaneFocus.CAUCUS, "/status")
        assert decision.allow_submit is True
        assert decision.is_slash_command is True

    def test_blank_input_is_rejected(self):
        decision = submission_policy(PaneFocus.ROOM, "   ")
        assert decision.allow_submit is False
        assert decision.reason == "Enter a message or command."


class TestStatusLine:
    def test_formats_status_with_percentages_and_observer(self):
        status = StatusSnapshot(
            mode=RoomMode.CAUCUS,
            lead="auto",
            route="@all",
            claude_percent=34.2,
            codex_percent=61.4,
            claude_tokens=342_000,
            claude_window=1_000_000,
            codex_tokens=167_000,
            codex_window=272_000,
            observe_enabled=True,
        )
        line = format_status_line(status)
        assert "Claude: ~34%" in line
        assert "Codex: ~61%" in line
        assert line.startswith("Mode: caucus")
        assert "Observe: on" in line

    def test_formats_missing_context_as_unknown(self):
        status = StatusSnapshot()
        line = format_status_line(status)
        assert "Claude: --" in line
        assert "Codex: --" in line

    def test_formats_rounded_percentages(self):
        status = StatusSnapshot(
            claude_percent=8.0,
            codex_percent=2.1,
            claude_tokens=80_000, claude_window=1_000_000,
            codex_tokens=5_700, codex_window=272_000,
        )
        line = format_status_line(status)
        assert "Claude: ~8%" in line
        assert "Codex: ~2%" in line


class TestContextWarningColors:
    def test_normal_usage_has_no_style(self):
        assert _context_style(50.0) == ""

    def test_80_percent_is_yellow(self):
        assert _context_style(80.0) == "bold yellow"

    def test_90_percent_is_red(self):
        assert _context_style(90.0) == "bold red"

    def test_none_is_dim(self):
        assert _context_style(None) == "dim"

    def test_normalized_75pct_is_yellow(self):
        """75% on normalized scale (where 100% = yield) should warn yellow."""
        assert _context_style(75.0) == "bold yellow"

    def test_50pct_no_style(self):
        """50% on normalized scale is well within budget — no style."""
        assert _context_style(50.0) == ""

    def test_normalized_90pct_is_red(self):
        """90% on normalized scale is critical — red."""
        assert _context_style(90.0) == "bold red"

    def test_rich_status_contains_styled_spans(self):
        status = StatusSnapshot(
            claude_percent=92.0, codex_percent=45.0,
            claude_tokens=920_000, claude_window=1_000_000,
            codex_tokens=122_400, codex_window=272_000,
        )
        rich_text = format_status_rich(status)
        assert rich_text.plain.startswith("Mode: public")
        assert "~92%" in rich_text.plain
        assert "~45%" in rich_text.plain
        # Verify the 92% span got styled (red)
        spans = rich_text._spans
        styled_texts = [
            (rich_text.plain[s.start:s.end], str(s.style))
            for s in spans
        ]
        assert any("~92%" in txt and "red" in style for txt, style in styled_texts)


class TestPaneVisualState:
    def test_focused_pane_is_not_dimmed(self):
        visual = pane_visual_state(PaneFocus.ROOM, PaneFocus.ROOM)
        assert visual.css_class == "focused-pane"
        assert visual.dimmed is False

    def test_inactive_pane_is_dimmed(self):
        visual = pane_visual_state(PaneFocus.CAUCUS, PaneFocus.ROOM)
        assert visual.css_class == "idle-pane"
        assert visual.dimmed is True


class TestTranscriptRendering:
    def test_renders_named_prefix_for_model(self):
        rendered = render_transcript_entry(
            TranscriptEntry(speaker="claude", text="Let me scan the repo.")
        )
        assert rendered.plain == "[Claude] Let me scan the repo."

    def test_renders_system_entry_without_brackets(self):
        rendered = render_transcript_entry(
            TranscriptEntry(speaker="system", text="Caucus ended.")
        )
        assert rendered.plain == "System: Caucus ended."

    def test_dimmed_entries_render_in_gray(self):
        rendered = render_transcript_entry(
            TranscriptEntry(speaker="codex", text="Background note."),
            dimmed=True,
        )
        styled_texts = [
            (rendered.plain[s.start:s.end], str(s.style))
            for s in rendered._spans
        ]
        assert any("bright_black" in style for _, style in styled_texts)

    def test_renders_structured_diff_with_line_number_gutters(self):
        rendered = render_transcript_entry(
            TranscriptEntry(
                speaker="codex",
                text="Edited in src/app.py (+1 -1)\n@@ -1,1 +1,1 @@\n- old_name = 1\n+ new_name = 1",
            )
        )
        assert "[Codex] " in rendered.plain
        assert "src/app.py" in rendered.plain
        assert "       1 + " in rendered.plain
        assert "   1      - " in rendered.plain

    def test_renders_structured_code_with_header_and_line_numbers(self):
        rendered = render_transcript_entry(
            TranscriptEntry(
                speaker="claude",
                text="'core/botference.py' lines 10-11:\n\n```python\ndef parse_input(raw: str):\n    return raw\n```",
            )
        )
        assert "core/botference.py" in rendered.plain
        assert "lines 10-11" in rendered.plain
        assert "  10  def parse_input(raw: str):" in rendered.plain
        assert "  11      return raw" in rendered.plain


# ── Textual widget tests (async, require textual installed) ─────────

import pytest

from botference_ui import TEXTUAL_AVAILABLE

_needs_textual = pytest.mark.skipif(
    not TEXTUAL_AVAILABLE, reason="textual not installed"
)

if TEXTUAL_AVAILABLE:
    from botference_ui import (
        CaucusPane,
        BotferenceApp,
        InputBar,
        RoomPane,
        StatusBar,
    )
    from textual.widgets import Input


@_needs_textual
@pytest.mark.asyncio
class TestBotferenceAppMount:
    async def test_app_mounts_with_both_panes(self):
        app = BotferenceApp()
        async with app.run_test():
            assert len(app.query(RoomPane)) == 1
            assert len(app.query(CaucusPane)) == 1

    async def test_app_mounts_input_bar_and_status(self):
        app = BotferenceApp()
        async with app.run_test():
            assert len(app.query(InputBar)) == 1
            assert len(app.query(StatusBar)) == 1

    async def test_initial_status_shows_defaults(self):
        app = BotferenceApp()
        async with app.run_test():
            bar = app.query_one(StatusBar)
            # StatusBar uses Rich Text; check the plain-text snapshot
            assert bar.status.mode is RoomMode.PUBLIC
            assert bar.status.lead == "auto"
            assert bar.status.route == "@all"

    async def test_room_pane_has_welcome_message(self):
        app = BotferenceApp()
        async with app.run_test():
            room = app.query_one(RoomPane)
            assert room.virtual_size.height > 0

    async def test_caucus_pane_has_placeholder(self):
        app = BotferenceApp()
        async with app.run_test():
            caucus = app.query_one(CaucusPane)
            assert caucus.virtual_size.height > 0


@_needs_textual
@pytest.mark.asyncio
class TestFocusCycling:
    async def test_initial_focus_is_room(self):
        app = BotferenceApp()
        async with app.run_test():
            assert app.focused_pane is PaneFocus.ROOM

    async def test_tab_switches_to_caucus(self):
        app = BotferenceApp()
        async with app.run_test() as pilot:
            await pilot.press("tab")
            assert app.focused_pane is PaneFocus.CAUCUS

    async def test_shift_tab_switches_back_to_room(self):
        app = BotferenceApp()
        async with app.run_test() as pilot:
            await pilot.press("tab")
            assert app.focused_pane is PaneFocus.CAUCUS
            await pilot.press("shift+tab")
            assert app.focused_pane is PaneFocus.ROOM

    async def test_room_gets_focused_css_class(self):
        app = BotferenceApp()
        async with app.run_test():
            room = app.query_one(RoomPane)
            assert room.has_class("focused-pane")
            caucus = app.query_one(CaucusPane)
            assert caucus.has_class("idle-pane")

    async def test_tab_swaps_css_classes(self):
        app = BotferenceApp()
        async with app.run_test() as pilot:
            await pilot.press("tab")
            room = app.query_one(RoomPane)
            caucus = app.query_one(CaucusPane)
            assert room.has_class("idle-pane")
            assert caucus.has_class("focused-pane")


@_needs_textual
@pytest.mark.asyncio
class TestInputSubmission:
    async def test_room_submit_calls_on_submit(self):
        received = []
        app = BotferenceApp(on_submit=received.append)
        async with app.run_test() as pilot:
            inp = app.query_one(Input)
            inp.value = "@claude Hello"
            await pilot.press("enter")
            assert received == ["@claude Hello"]

    async def test_input_cleared_after_submit(self):
        app = BotferenceApp(on_submit=lambda _: None)
        async with app.run_test() as pilot:
            inp = app.query_one(Input)
            inp.value = "test message"
            await pilot.press("enter")
            assert inp.value == ""

    async def test_caucus_focus_blocks_plain_text_submit(self):
        received = []
        app = BotferenceApp(on_submit=received.append)
        async with app.run_test() as pilot:
            await pilot.press("tab")  # focus caucus
            inp = app.query_one(Input)
            inp.value = "plain text blocked"
            await pilot.press("enter")
            assert received == []  # nothing submitted

    async def test_caucus_focus_allows_slash_command(self):
        received = []
        app = BotferenceApp(on_submit=received.append)
        async with app.run_test() as pilot:
            await pilot.press("tab")  # focus caucus
            inp = app.query_one(Input)
            inp.value = "/status"
            await pilot.press("enter")
            assert received == ["/status"]

    async def test_blank_input_not_submitted(self):
        received = []
        app = BotferenceApp(on_submit=received.append)
        async with app.run_test() as pilot:
            inp = app.query_one(Input)
            inp.value = "   "
            await pilot.press("enter")
            assert received == []

    async def test_caucus_focus_shows_placeholder_hint(self):
        """When caucus is focused, the input placeholder changes."""
        app = BotferenceApp(on_submit=lambda _: None)
        async with app.run_test() as pilot:
            await pilot.press("tab")  # focus caucus
            inp = app.query_one(Input)
            assert "slash" in inp.placeholder.lower() or "command" in inp.placeholder.lower()


@_needs_textual
@pytest.mark.asyncio
class TestSetMode:
    async def test_set_mode_caucus_focuses_caucus_pane(self):
        app = BotferenceApp()
        async with app.run_test():
            app.set_mode(RoomMode.CAUCUS)
            assert app.focused_pane is PaneFocus.CAUCUS
            caucus = app.query_one(CaucusPane)
            assert caucus.has_class("focused-pane")

    async def test_set_mode_public_returns_to_room(self):
        app = BotferenceApp()
        async with app.run_test():
            app.set_mode(RoomMode.CAUCUS)
            app.set_mode(RoomMode.PUBLIC)
            assert app.focused_pane is PaneFocus.ROOM
            room = app.query_one(RoomPane)
            assert room.has_class("focused-pane")

    async def test_set_mode_updates_status_bar(self):
        app = BotferenceApp()
        async with app.run_test():
            app.set_mode(RoomMode.DRAFT)
            bar = app.query_one(StatusBar)
            assert bar.status.mode is RoomMode.DRAFT


@_needs_textual
@pytest.mark.asyncio
class TestEntryAppending:
    async def test_add_room_entry_increases_line_count(self):
        app = BotferenceApp()
        async with app.run_test():
            room = app.query_one(RoomPane)
            initial = room.virtual_size.height
            app.add_room_entry("claude", "Scanning workspace...")
            assert room.virtual_size.height > initial

    async def test_add_caucus_entry_increases_line_count(self):
        app = BotferenceApp()
        async with app.run_test():
            caucus = app.query_one(CaucusPane)
            initial = caucus.virtual_size.height
            app.add_caucus_entry("codex", "I agree with that approach")
            assert caucus.virtual_size.height > initial

    async def test_entries_go_to_correct_pane(self):
        app = BotferenceApp()
        async with app.run_test():
            room = app.query_one(RoomPane)
            caucus = app.query_one(CaucusPane)
            room_before = room.virtual_size.height
            caucus_before = caucus.virtual_size.height
            app.add_room_entry("user", "hello")
            assert room.virtual_size.height > room_before
            assert caucus.virtual_size.height == caucus_before


@_needs_textual
@pytest.mark.asyncio
class TestStatusUpdate:
    async def test_set_status_updates_bar(self):
        app = BotferenceApp()
        async with app.run_test():
            new_status = StatusSnapshot(
                mode=RoomMode.CAUCUS,
                lead="@claude",
                route="@claude",
                claude_percent=55.0,
                codex_percent=72.0,
            )
            app.set_status(new_status)
            bar = app.query_one(StatusBar)
            assert bar.status.lead == "@claude"
            assert bar.status.claude_percent == 55.0

    async def test_set_status_with_mode_change_syncs_focus(self):
        """set_status() must sync pane focus when mode changes."""
        app = BotferenceApp()
        async with app.run_test():
            assert app.focused_pane is PaneFocus.ROOM
            app.set_status(StatusSnapshot(mode=RoomMode.CAUCUS))
            assert app.focused_pane is PaneFocus.CAUCUS
            caucus = app.query_one(CaucusPane)
            assert caucus.has_class("focused-pane")

    async def test_set_status_without_mode_change_keeps_focus(self):
        """set_status() with same mode should not touch focus."""
        app = BotferenceApp()
        async with app.run_test():
            # Switch to caucus first
            app.set_mode(RoomMode.CAUCUS)
            assert app.focused_pane is PaneFocus.CAUCUS
            # Update context % without mode change
            app.set_status(StatusSnapshot(
                mode=RoomMode.CAUCUS, claude_percent=50.0,
            ))
            assert app.focused_pane is PaneFocus.CAUCUS


@_needs_textual
@pytest.mark.asyncio
class TestMouseScrollRouting:
    async def test_mouse_scroll_routes_to_focused_pane(self):
        """Mouse scroll events should route to whichever pane is focused."""
        app = BotferenceApp()
        async with app.run_test():
            # Add enough content to make room scrollable
            for i in range(50):
                app.add_room_entry("system", f"line {i}")
            room = app.query_one(RoomPane)
            # Scroll should target room (default focus)
            assert app.focused_pane is PaneFocus.ROOM
            # Verify the handler exists and routes correctly
            target = app._focused_log()
            assert isinstance(target, RoomPane)

    async def test_mouse_scroll_routes_to_caucus_when_focused(self):
        app = BotferenceApp()
        async with app.run_test() as pilot:
            await pilot.press("tab")  # focus caucus
            target = app._focused_log()
            assert isinstance(target, CaucusPane)
