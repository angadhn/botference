"""The command table (COMMAND_HELP) every /help and autocomplete reads.

The terminal /help, the council page's /help popup and the browser plugin's
popup + slash autocomplete are all drawn from core/botference.py
COMMAND_HELP. These tests hold the table to the parser: a command the
controller accepts must have a row, and the row must be short enough to fit
on one line of a popup.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from botference import (  # noqa: E402
    COMMAND_HELP,
    _SLASH_COMMANDS,
    _TARGETED_COMMANDS,
    command_help,
    get_completion_context,
    render_command_help,
)

_SCOPES = {"tui", "council", "plugin"}


def _names(row):
    return [row["cmd"], *(row.get("aliases") or [])]


def _all_names():
    return {n for row in COMMAND_HELP for n in _names(row)}


def test_every_slash_command_has_a_row():
    missing = [c for c in _SLASH_COMMANDS if c not in _all_names()]
    assert missing == []


def test_targeted_commands_mentions_and_extras_have_rows():
    names = _all_names()
    for c in (*_TARGETED_COMMANDS, "/relay", "/tag", "/compact", "/goal",
              "/parallel", "@claude", "@codex", "@all"):
        assert c in names, c


def test_rows_are_well_formed_and_short():
    seen = set()
    for row in COMMAND_HELP:
        assert row["cmd"] not in seen, row["cmd"]
        seen.add(row["cmd"])
        assert row["hint"] and "\n" not in row["hint"]
        assert len(row["hint"]) <= 62, (row["cmd"], len(row["hint"]))
        assert set(row["scope"]) <= _SCOPES and row["scope"], row["cmd"]
        assert row["group"]


def test_quit_is_terminal_only_and_plugin_gets_what_the_drawer_handles():
    council = {r["cmd"] for r in command_help("council")}
    plugin = {r["cmd"] for r in command_help("plugin")}
    assert "/quit" not in council and "/quit" not in plugin
    assert "/help" in council and "/help" in plugin
    assert plugin == {"@claude", "@codex", "@all", "/parallel", "/lasso", "/help"}


def test_completion_context_carries_commands():
    ctx = get_completion_context()
    assert "commands" in ctx
    cmds = {r["cmd"]: r for r in ctx["commands"]}
    assert cmds["/help"]["hint"]
    assert isinstance(cmds["/help"]["scope"], list)   # JSON-ready


def test_terminal_help_is_rendered_from_the_table():
    text = "\n".join(render_command_help("tui"))
    for row in command_help("tui"):
        assert row["cmd"] in text and row["hint"] in text
    for row in COMMAND_HELP:
        if "tui" not in row["scope"]:
            assert row["hint"] not in text
