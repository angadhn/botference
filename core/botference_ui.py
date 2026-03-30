"""
botference_ui.py — Textual UI primitives for botference mode.

Task 2 focuses on the deterministic TUI layer: pane focus, input policy,
status formatting, and scrollable room/caucus panes. The controller logic
lands separately in botference.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional

from rich.text import Text


class RoomMode(str, Enum):
    PUBLIC = "public"
    CAUCUS = "caucus"
    DRAFT = "draft"
    REVIEW = "review"


class PaneFocus(str, Enum):
    ROOM = "room"
    CAUCUS = "caucus"


@dataclass(frozen=True)
class StatusSnapshot:
    mode: RoomMode = RoomMode.PUBLIC
    lead: str = "auto"
    route: str = "@all"
    claude_percent: Optional[float] = None
    codex_percent: Optional[float] = None
    claude_tokens: Optional[int] = None
    claude_window: Optional[int] = None
    codex_tokens: Optional[int] = None
    codex_window: Optional[int] = None
    observe_enabled: bool = True


@dataclass(frozen=True)
class SubmissionDecision:
    allow_submit: bool
    reason: str = ""
    is_slash_command: bool = False


@dataclass(frozen=True)
class PaneVisualState:
    css_class: str
    dimmed: bool


@dataclass(frozen=True)
class TranscriptEntry:
    speaker: str
    text: str


def cycle_pane_focus(
    current: PaneFocus, *, backwards: bool = False
) -> PaneFocus:
    """Switch between room and caucus panes."""
    del backwards  # Two panes only; direction does not change the target.
    return (
        PaneFocus.CAUCUS if current is PaneFocus.ROOM else PaneFocus.ROOM
    )


def submission_policy(focused_pane: PaneFocus, text: str) -> SubmissionDecision:
    stripped = text.strip()
    if not stripped:
        return SubmissionDecision(
            allow_submit=False,
            reason="Enter a message or command.",
        )

    is_slash_command = stripped.startswith("/")
    if focused_pane is PaneFocus.CAUCUS and not is_slash_command:
        return SubmissionDecision(
            allow_submit=False,
            reason="Caucus focused — Shift-Tab to Council to send messages",
        )

    return SubmissionDecision(
        allow_submit=True,
        is_slash_command=is_slash_command,
    )


def pane_visual_state(
    pane: PaneFocus, focused_pane: PaneFocus
) -> PaneVisualState:
    active = pane is focused_pane
    return PaneVisualState(
        css_class="focused-pane" if active else "idle-pane",
        dimmed=not active,
    )


def _humanize_tokens(n: int) -> str:
    """Format token count: 1234567 → '1.2M', 45000 → '45.0K'."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _format_context_percent(
    value: Optional[float],
) -> str:
    """Format status context as percent of full window."""
    if value is None:
        return "--"
    return f"~{value:.0f}%"


def _context_style(value: Optional[float]) -> str:
    """Return Rich style string based on context usage thresholds.

    value is percentage of actual context window (0–100+).
    """
    if value is None:
        return "dim"
    if value >= 90:
        return "bold red"
    if value >= 75:
        return "bold yellow"
    return ""


def format_status_line(status: StatusSnapshot) -> str:
    return (
        f"Mode: {status.mode.value} | Lead: {status.lead} | "
        f"Route: {status.route} | "
        f"Claude: {_format_context_percent(status.claude_percent)} | "
        f"Codex: {_format_context_percent(status.codex_percent)} | "
        f"Observe: {'on' if status.observe_enabled else 'off'}"
    )


def format_status_rich(status: StatusSnapshot) -> Text:
    """Rich Text version of the status line with context warning colors."""
    t = Text()
    t.append(f"Mode: {status.mode.value} | Lead: {status.lead} | "
             f"Route: {status.route} | Claude: ")
    t.append(
        _format_context_percent(status.claude_percent),
        style=_context_style(status.claude_percent),
    )
    t.append(" | Codex: ")
    t.append(
        _format_context_percent(status.codex_percent),
        style=_context_style(status.codex_percent),
    )
    t.append(f" | Observe: {'on' if status.observe_enabled else 'off'}")
    return t


def render_transcript_entry(
    entry: TranscriptEntry, *, dimmed: bool = False
) -> Text:
    # Bright colors for bold speaker labels
    label_colors = {
        "user": "cyan",
        "claude": "bright_blue",
        "codex": "bright_green",
        "system": "yellow",
        "summary": "magenta",
    }
    # Muted colors for body text — distinguishes speaker but doesn't
    # compete with the bold label
    body_colors = {
        "user": "white",
        "claude": "blue",
        "codex": "green",
        "system": "bright_yellow",
        "summary": "bright_magenta",
    }
    label_map = {
        "user": "[You] ",
        "claude": "[Claude] ",
        "codex": "[Codex] ",
        "summary": "[Summary] ",
        "system": "System: ",
    }

    speaker = entry.speaker.lower()
    label = label_map.get(speaker, f"[{entry.speaker}] ")
    if dimmed:
        label_style = "bold bright_black"
        body_style = "bright_black"
    else:
        label_style = f"bold {label_colors.get(speaker, 'white')}"
        body_style = body_colors.get(speaker, "white")
    text = Text()
    text.append(label, style=label_style)
    text.append(entry.text, style=body_style)
    return text


TEXTUAL_IMPORT_ERROR: Optional[ModuleNotFoundError] = None
TEXTUAL_AVAILABLE = False

try:
    from textual.app import App, ComposeResult
    from textual.binding import Binding
    from textual.containers import Horizontal, Vertical
    from textual.message import Message
    from textual.reactive import reactive
    from textual.widget import Widget
    from textual.widgets import Input, RichLog, Static
    from textual.suggester import Suggester

    TEXTUAL_AVAILABLE = True
except ModuleNotFoundError as exc:
    TEXTUAL_IMPORT_ERROR = exc


if TEXTUAL_AVAILABLE:

    class BotferenceInputSubmitted(Message):
        def __init__(self, text: str) -> None:
            self.text = text
            super().__init__()


    class TranscriptPane(RichLog):
        def __init__(self, title: str) -> None:
            super().__init__(wrap=True, markup=False, highlight=False)
            self.border_title = title
            self.can_focus = False
            self._entries: list[TranscriptEntry] = []
            self._dimmed = False

        def append_entry(self, entry: TranscriptEntry) -> None:
            self._entries.append(entry)
            self.write(
                render_transcript_entry(entry, dimmed=self._dimmed),
                scroll_end=True,
            )

        def set_dimmed(self, dimmed: bool) -> None:
            if dimmed == self._dimmed:
                return
            self._dimmed = dimmed
            scroll_y = self.scroll_y
            self.clear()
            for entry in self._entries:
                self.write(
                    render_transcript_entry(entry, dimmed=self._dimmed),
                    scroll_end=False,
                )
            self.scroll_to(
                y=min(scroll_y, self.max_scroll_y),
                animate=False,
                immediate=True,
            )


    class RoomPane(TranscriptPane):
        def __init__(self) -> None:
            super().__init__("COUNCIL")


    class CaucusPane(TranscriptPane):
        def __init__(self) -> None:
            super().__init__("CAUCUS")


    class StatusBar(Static):
        def __init__(self, status: Optional[StatusSnapshot] = None) -> None:
            super().__init__("", id="status-bar")
            self.status = status or StatusSnapshot()

        def update_status(self, status: StatusSnapshot) -> None:
            self.status = status
            self.update(format_status_rich(status))


    _COMPLETIONS = [
        "/caucus ",
        "/lead @claude",
        "/lead @codex",
        "/draft",
        "/finalize",
        "/status",
        "/help",
        "/quit",
        "/exit",
        "@claude ",
        "@codex ",
        "@all ",
    ]

    class SlashSuggester(Suggester):
        """Suggest /commands and @mentions as the user types."""

        async def get_suggestion(self, value: str) -> str | None:
            if not value:
                return None
            lower = value.lower()
            for cmd in _COMPLETIONS:
                if cmd.lower().startswith(lower) and cmd.lower() != lower:
                    return cmd
            return None

    class InputBar(Widget):
        def compose(self) -> ComposeResult:
            yield Static("You (@claude/@codex/@all, /help):", id="input-label")
            yield Input(
                placeholder="Send to the council room",
                id="shared-input",
                suggester=SlashSuggester(use_cache=False),
            )
            yield Static("", id="input-hint")

        def on_mount(self) -> None:
            self.focus_input()

        def focus_input(self) -> None:
            self.query_one(Input).focus()

        def clear(self) -> None:
            self.query_one(Input).value = ""

        def set_hint(self, text: str) -> None:
            self.query_one("#input-hint", Static).update(text)

        def set_placeholder(self, text: str) -> None:
            self.query_one(Input).placeholder = text

        def on_input_submitted(self, event: Input.Submitted) -> None:
            self.post_message(BotferenceInputSubmitted(event.value))


    class BotferenceApp(App[None]):
        CSS = """
        Screen {
            layout: vertical;
        }

        #panes {
            height: 1fr;
        }

        RoomPane, CaucusPane {
            width: 1fr;
            border: round $panel;
            padding: 0 1;
        }

        .focused-pane {
            border: round $accent;
        }

        .idle-pane {
            border: round $panel-lighten-1;
        }

        InputBar {
            height: auto;
            padding: 0 1;
        }

        #input-label {
            padding-top: 1;
        }

        #input-hint {
            color: $text-muted;
        }

        #bottom {
            height: auto;
            dock: bottom;
        }

        #status-bar {
            height: 1;
            padding: 0 1;
            background: $surface-darken-1;
            color: $text-muted;
        }
        """

        BINDINGS = [
            Binding("tab", "focus_next_pane", "Next Pane", priority=True),
            Binding("shift+tab", "focus_prev_pane", "Previous Pane", priority=True),
            Binding("up", "scroll_focused_up", show=False),
            Binding("down", "scroll_focused_down", show=False),
            Binding("pageup", "page_focused_up", show=False),
            Binding("pagedown", "page_focused_down", show=False),
        ]

        focused_pane = reactive(PaneFocus.ROOM)
        status = reactive(StatusSnapshot())

        def __init__(
            self,
            on_submit: Optional[Callable[[str], None]] = None,
            initial_status: Optional[StatusSnapshot] = None,
            **kwargs,
        ) -> None:
            super().__init__(**kwargs)
            self.on_submit = on_submit
            self._initial_status = initial_status or StatusSnapshot()

        def compose(self) -> ComposeResult:
            with Horizontal(id="panes"):
                yield RoomPane()
                yield CaucusPane()
            with Vertical(id="bottom"):
                yield InputBar()
                yield StatusBar(self.status)

        def on_mount(self) -> None:
            self.query_one(RoomPane).append_entry(
                TranscriptEntry(
                    speaker="system",
                    text="Council room ready. First plain text routes to @all.",
                )
            )
            self.query_one(CaucusPane).append_entry(
                TranscriptEntry(
                    speaker="system",
                    text="(empty until /caucus)",
                )
            )
            self._apply_focus_state()
            self.status = self._initial_status
            self.query_one(StatusBar).update_status(self.status)
            self.query_one(InputBar).focus_input()

        def watch_status(self, status: StatusSnapshot) -> None:
            if not self.is_running:
                return
            try:
                bars = self.query(StatusBar)
            except Exception:
                return
            if bars:
                bars.first().update_status(status)

        def _apply_focus_state(self) -> None:
            room = self.query_one(RoomPane)
            caucus = self.query_one(CaucusPane)
            for pane, pane_id in (
                (room, PaneFocus.ROOM),
                (caucus, PaneFocus.CAUCUS),
            ):
                visual = pane_visual_state(pane_id, self.focused_pane)
                pane.remove_class("focused-pane", "idle-pane")
                pane.add_class(visual.css_class)
                pane.set_dimmed(visual.dimmed)

            hint = ""
            placeholder = "Send to the council room"
            if self.focused_pane is PaneFocus.CAUCUS:
                hint = "Caucus focused — Shift-Tab to Council to send messages"
                placeholder = "Slash commands still work here"

            input_bar = self.query_one(InputBar)
            input_bar.set_hint(hint)
            input_bar.set_placeholder(placeholder)
            input_bar.focus_input()

        def action_focus_next_pane(self) -> None:
            self.focused_pane = cycle_pane_focus(self.focused_pane)
            self._apply_focus_state()

        def action_focus_prev_pane(self) -> None:
            self.focused_pane = cycle_pane_focus(
                self.focused_pane, backwards=True
            )
            self._apply_focus_state()

        def _focused_log(self) -> RichLog:
            if self.focused_pane is PaneFocus.CAUCUS:
                return self.query_one(CaucusPane)
            return self.query_one(RoomPane)

        def action_scroll_focused_up(self) -> None:
            self._focused_log().scroll_up(animate=False)

        def action_scroll_focused_down(self) -> None:
            self._focused_log().scroll_down(animate=False)

        def action_page_focused_up(self) -> None:
            self._focused_log().scroll_page_up(animate=False)

        def action_page_focused_down(self) -> None:
            self._focused_log().scroll_page_down(animate=False)

        def on_mouse_scroll_up(self, event) -> None:
            self._focused_log().scroll_up(animate=False)
            event.stop()

        def on_mouse_scroll_down(self, event) -> None:
            self._focused_log().scroll_down(animate=False)
            event.stop()

        def add_room_entry(self, speaker: str, text: str) -> None:
            self.query_one(RoomPane).append_entry(
                TranscriptEntry(speaker=speaker, text=text)
            )

        def add_caucus_entry(self, speaker: str, text: str) -> None:
            self.query_one(CaucusPane).append_entry(
                TranscriptEntry(speaker=speaker, text=text)
            )

        def set_status(self, status: StatusSnapshot) -> None:
            old_mode = self.status.mode
            self.status = status
            if status.mode != old_mode:
                self._sync_focus_to_mode(status.mode)

        def set_mode(self, mode: RoomMode) -> None:
            self.status = StatusSnapshot(
                mode=mode,
                lead=self.status.lead,
                route=self.status.route,
                claude_percent=self.status.claude_percent,
                codex_percent=self.status.codex_percent,
                claude_tokens=self.status.claude_tokens,
                claude_window=self.status.claude_window,
                codex_tokens=self.status.codex_tokens,
                codex_window=self.status.codex_window,
                observe_enabled=self.status.observe_enabled,
            )
            self._sync_focus_to_mode(mode)

        def _sync_focus_to_mode(self, mode: RoomMode) -> None:
            if mode is RoomMode.CAUCUS:
                self.focused_pane = PaneFocus.CAUCUS
            else:
                self.focused_pane = PaneFocus.ROOM
            self._apply_focus_state()

        def on_botference_input_submitted(
            self, message: BotferenceInputSubmitted
        ) -> None:
            decision = submission_policy(self.focused_pane, message.text)
            input_bar = self.query_one(InputBar)
            if not decision.allow_submit:
                input_bar.set_hint(decision.reason)
                input_bar.focus_input()
                return

            input_bar.clear()
            input_bar.set_hint("")
            if self.on_submit is not None:
                self.on_submit(message.text)
            input_bar.focus_input()


else:

    class BotferenceInputSubmitted:  # pragma: no cover - import guard fallback
        def __init__(self, text: str) -> None:
            self.text = text


    class RoomPane:  # pragma: no cover - import guard fallback
        pass


    class CaucusPane:  # pragma: no cover - import guard fallback
        pass


    class InputBar:  # pragma: no cover - import guard fallback
        pass


    class StatusBar:  # pragma: no cover - import guard fallback
        pass


    class BotferenceApp:  # pragma: no cover - import guard fallback
        def __init__(self, *_args, **_kwargs) -> None:
            raise ModuleNotFoundError(
                "textual is required to run botference_ui.BotferenceApp"
            ) from TEXTUAL_IMPORT_ERROR
