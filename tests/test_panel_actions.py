"""Botference.panel_action: one thing asked for from a list of chats.

The web council's left panel renames, moves, archives and deletes chats from
their rows. Those requests are answered at once, say nothing in the room, and
leave the open chat and a running bot turn alone. Everything here is made up.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from test_botference import _add_project, _make_botference, _ok  # noqa: E402


async def _saved_chat(tmp_path, title="Kettle notes", project=""):
    """A chat on disk that no process has open."""
    c, _, _, ui = _make_botference(claude_responses=[_ok("reply")], tmp_path=tmp_path)
    await c.handle_input(f"/rename {title}", ui)
    await c.handle_input("@claude hello", ui)
    if project:
        await c.handle_input(f"/file {project}", ui)
    return c.session_id


def _on_disk(tmp_path, sid) -> dict:
    return json.loads((tmp_path / "work" / "sessions" / f"{sid}.json").read_text())


def _titles(c) -> dict:
    return {s.session_id: s.title for s in c.session_store.list_summaries(limit=50)}


@pytest.mark.asyncio
class TestPanelRename:
    async def test_renames_a_chat_that_is_not_open(self, tmp_path):
        other = await _saved_chat(tmp_path)
        before = _on_disk(tmp_path, other)
        c, _, _, ui = _make_botference(tmp_path=tmp_path)
        said = len(ui.room_entries)

        result = c.panel_action({"action": "rename", "sid": other, "title": "  Tea   kettle "}, ui)

        assert result == {"ok": True}
        after = _on_disk(tmp_path, other)
        assert after["custom_title"] == "Tea kettle"
        assert after["updated_at"] == before["updated_at"], "the row does not jump to the top"
        assert after["transcript"] == before["transcript"]
        assert _titles(c)[other] == "Tea kettle"
        assert len(ui.room_entries) == said, "nothing is said in the open chat"
        assert ui.project_states, "the list is sent again"
        assert c.custom_title == "", "the open chat keeps its own name"

    async def test_renames_the_open_chat_even_while_a_turn_runs(self, tmp_path):
        c, _, _, ui = _make_botference(claude_responses=[_ok("reply")], tmp_path=tmp_path)
        await c.handle_input("@claude hello", ui)
        said = len(ui.room_entries)

        result = c.panel_action(
            {"action": "rename", "sid": c.session_id, "title": "Door colours"}, ui, busy=True,
        )

        assert result == {"ok": True}
        assert c.custom_title == "Door colours"
        assert _on_disk(tmp_path, c.session_id)["custom_title"] == "Door colours"
        assert len(ui.room_entries) == said

    async def test_refuses_an_empty_name_and_a_chat_that_is_gone(self, tmp_path):
        other = await _saved_chat(tmp_path)
        c, _, _, ui = _make_botference(tmp_path=tmp_path)
        assert c.panel_action({"action": "rename", "sid": other, "title": "   "}, ui) == {
            "ok": False, "error": "A chat needs a name.",
        }
        assert c.panel_action({"action": "rename", "sid": "nobody", "title": "x"}, ui) == {
            "ok": False, "error": "That chat is no longer there.",
        }
        assert c.panel_action({"action": "rename", "title": "x"}, ui)["ok"] is False
        assert _on_disk(tmp_path, other)["custom_title"] == "Kettle notes"


@pytest.mark.asyncio
class TestPanelMove:
    async def test_moves_another_chat_into_a_project_and_out_again(self, tmp_path):
        _add_project(tmp_path, "garden-plan", "Garden plan")
        other = await _saved_chat(tmp_path)
        c, _, _, ui = _make_botference(tmp_path=tmp_path)
        said = len(ui.room_entries)

        assert c.panel_action({"action": "move", "sid": other, "project": "garden-plan"}, ui) == {"ok": True}
        assert _on_disk(tmp_path, other)["project_id"] == "garden-plan"
        assert c.project_store.session_index_map().get(other) == "garden-plan"
        assert c.session_project_id == "", "the open chat stays where it is"
        assert c.active_project_id == ""

        assert c.panel_action({"action": "move", "sid": other, "project": ""}, ui) == {"ok": True}
        assert _on_disk(tmp_path, other)["project_id"] == ""
        assert other not in c.project_store.session_index_map()
        assert len(ui.room_entries) == said

    async def test_moves_the_open_chat_when_no_turn_is_running(self, tmp_path):
        _add_project(tmp_path, "garden-plan", "Garden plan")
        c, _, _, ui = _make_botference(claude_responses=[_ok("reply")], tmp_path=tmp_path)
        await c.handle_input("@claude hello", ui)
        said = len(ui.room_entries)

        refused = c.panel_action(
            {"action": "move", "sid": c.session_id, "project": "garden-plan"}, ui, busy=True,
        )
        assert refused["ok"] is False
        assert "still working" in refused["error"]
        assert c.session_project_id == ""

        assert c.panel_action({"action": "move", "sid": c.session_id, "project": "garden-plan"}, ui) == {"ok": True}
        assert c.session_project_id == "garden-plan"
        assert _on_disk(tmp_path, c.session_id)["project_id"] == "garden-plan"

        assert c.panel_action({"action": "move", "sid": c.session_id, "project": ""}, ui) == {"ok": True}
        assert c.session_project_id == ""
        assert _on_disk(tmp_path, c.session_id)["project_id"] == ""
        assert len(ui.room_entries) == said

    async def test_refuses_a_project_that_is_not_there(self, tmp_path):
        _add_project(tmp_path, "garden-plan", "Garden plan")
        other = await _saved_chat(tmp_path)
        c, _, _, ui = _make_botference(tmp_path=tmp_path)
        # a near miss is not good enough for a button: the id must be exact
        for wrong in ("garden", "attic"):
            assert c.panel_action({"action": "move", "sid": other, "project": wrong}, ui) == {
                "ok": False, "error": "That project is no longer there.",
            }
        assert _on_disk(tmp_path, other).get("project_id", "") == ""


@pytest.mark.asyncio
class TestPanelArchiveAndDelete:
    async def test_archives_and_brings_back_another_chat(self, tmp_path):
        other = await _saved_chat(tmp_path)
        c, _, _, ui = _make_botference(tmp_path=tmp_path)
        said = len(ui.room_entries)
        mine = c.session_id

        assert c.panel_action({"action": "archive", "sid": other}, ui) == {"ok": True, "fresh": False}
        assert not (tmp_path / "work" / "sessions" / f"{other}.json").exists()
        assert (tmp_path / "archive" / "sessions" / f"{other}.json").exists()
        assert other not in _titles(c)

        assert c.panel_action({"action": "unarchive", "sid": other}, ui) == {"ok": True}
        assert other in _titles(c)
        assert c.panel_action({"action": "unarchive", "sid": other}, ui)["ok"] is False
        assert c.session_id == mine
        assert len(ui.room_entries) == said

    async def test_deletes_another_chat_without_asking_in_the_room(self, tmp_path):
        _add_project(tmp_path, "garden-plan", "Garden plan")
        other = await _saved_chat(tmp_path, project="garden-plan")
        c, _, _, ui = _make_botference(tmp_path=tmp_path)
        said = len(ui.room_entries)
        mine = c.session_id

        assert c.panel_action({"action": "delete", "sid": other}, ui) == {"ok": True, "fresh": False}

        assert not (tmp_path / "work" / "sessions" / f"{other}.json").exists()
        assert other not in c.project_store.session_index_map()
        assert ui.choice_requests == [], "the panel asked already, in the row"
        assert len(ui.room_entries) == said
        assert c.session_id == mine
        assert c.panel_action({"action": "delete", "sid": other}, ui) == {
            "ok": False, "error": "That chat is no longer there.",
        }

    async def test_the_open_chat_waits_for_the_bots_then_a_fresh_chat_takes_its_place(self, tmp_path):
        c, _, _, ui = _make_botference(claude_responses=[_ok("reply")], tmp_path=tmp_path)
        await c.handle_input("@claude hello", ui)
        old = c.session_id

        for action in ("archive", "delete"):
            refused = c.panel_action({"action": action, "sid": old}, ui, busy=True)
            assert refused["ok"] is False and "still working" in refused["error"]
        assert c.session_id == old
        assert (tmp_path / "work" / "sessions" / f"{old}.json").exists()

        assert c.panel_action({"action": "delete", "sid": old}, ui) == {"ok": True, "fresh": True}
        assert c.session_id != old
        assert not (tmp_path / "work" / "sessions" / f"{old}.json").exists()
        assert c.transcript.entries == []

    async def test_archiving_the_open_chat_keeps_every_word(self, tmp_path):
        c, _, _, ui = _make_botference(claude_responses=[_ok("reply")], tmp_path=tmp_path)
        # nothing said yet: nothing to archive, and the chat stays put
        empty = c.panel_action({"action": "archive", "sid": c.session_id}, ui)
        assert empty["ok"] is False
        await c.handle_input("@claude hello", ui)
        old = c.session_id

        assert c.panel_action({"action": "archive", "sid": old}, ui) == {"ok": True, "fresh": True}

        assert c.session_id != old
        archived = json.loads((tmp_path / "archive" / "sessions" / f"{old}.json").read_text())
        assert [e["speaker"] for e in archived["transcript"]][:1] == ["user"]
        assert not (tmp_path / "work" / "sessions" / f"{old}.json").exists()


@pytest.mark.asyncio
class TestPanelProjects:
    async def test_makes_a_project_and_says_its_id(self, tmp_path):
        c, _, _, ui = _make_botference(claude_responses=[_ok("reply")], tmp_path=tmp_path)
        await c.handle_input("@claude hello", ui)
        said = len(ui.room_entries)

        result = c.panel_action({"action": "new-project", "title": " Shed   rebuild "}, ui)

        assert result["ok"] is True
        pid = result["project"]
        assert c.project_store.get(pid).title == "Shed rebuild"
        assert c.session_project_id == "", "making a project files nothing"
        assert len(ui.room_entries) == said
        again = c.panel_action({"action": "new-project", "title": "Shed rebuild"}, ui)
        assert again == {"ok": False, "error": "There is already a project with that name."}
        assert c.panel_action({"action": "new-project", "title": "  "}, ui) == {
            "ok": False, "error": "A project needs a name.",
        }

    async def test_archives_and_unarchives_a_project(self, tmp_path):
        _add_project(tmp_path, "garden-plan", "Garden plan")
        c, _, _, ui = _make_botference(tmp_path=tmp_path)
        assert c.panel_action({"action": "project-archive", "project": "garden-plan"}, ui) == {"ok": True}
        assert c.project_store.get("garden-plan").status == "archived"
        assert c.panel_action({"action": "project-unarchive", "project": "garden-plan"}, ui) == {"ok": True}
        assert c.project_store.get("garden-plan").status == "active"
        assert c.panel_action({"action": "project-archive", "project": "nope"}, ui)["ok"] is False
        assert ui.room_entries == [] or all("archiv" not in t.lower() for _, t in ui.room_entries)

    async def test_deletes_a_project_with_its_chats_and_nothing_else(self, tmp_path):
        _add_project(tmp_path, "garden-plan", "Garden plan")
        _add_project(tmp_path, "keeper", "Keeper")
        gone = [await _saved_chat(tmp_path, title=f"Bed {i}", project="garden-plan") for i in range(2)]
        kept = await _saved_chat(tmp_path, title="Kept", project="keeper")
        c, _, _, ui = _make_botference(tmp_path=tmp_path)
        mine = c.session_id

        result = c.panel_action({"action": "project-delete", "project": "garden-plan"}, ui)

        assert result == {"ok": True, "fresh": False, "chats": 2}
        assert not (tmp_path / "projects" / "garden-plan").exists()
        for sid in gone:
            assert not (tmp_path / "work" / "sessions" / f"{sid}.json").exists()
        assert (tmp_path / "work" / "sessions" / f"{kept}.json").exists()
        assert (tmp_path / "projects" / "keeper").exists()
        assert ui.choice_requests == []
        assert c.session_id == mine

    async def test_a_project_with_the_open_chat_in_it_waits_for_the_bots(self, tmp_path):
        _add_project(tmp_path, "garden-plan", "Garden plan")
        c, _, _, ui = _make_botference(claude_responses=[_ok("reply")], tmp_path=tmp_path)
        await c.handle_input("@claude hello", ui)
        await c.handle_input("/file garden-plan", ui)
        old = c.session_id

        refused = c.panel_action({"action": "project-delete", "project": "garden-plan"}, ui, busy=True)
        assert refused["ok"] is False and "still working" in refused["error"]
        assert (tmp_path / "projects" / "garden-plan").exists()

        result = c.panel_action({"action": "project-delete", "project": "garden-plan"}, ui)
        assert result == {"ok": True, "fresh": True, "chats": 1}
        assert c.session_id != old
        assert c.session_project_id == ""
        assert not (tmp_path / "work" / "sessions" / f"{old}.json").exists()


def test_an_unknown_action_is_refused_and_a_crash_is_caught(tmp_path):
    c, _, _, ui = _make_botference(tmp_path=tmp_path)
    assert c.panel_action({"action": "format-disk"}, ui) == {
        "ok": False, "error": "The panel cannot do that.",
    }
    assert c.panel_action({}, ui)["ok"] is False

    def boom(*a, **k):
        raise RuntimeError("disk on fire")
    c.session_store.unarchive = boom  # type: ignore[method-assign]
    assert c.panel_action({"action": "unarchive", "sid": "x"}, ui) == {
        "ok": False, "error": "That did not work.",
    }


def test_set_title_stamps_only_the_name(tmp_path):
    c, _, _, _ = _make_botference(tmp_path=tmp_path)
    c.session_store.save("s1", {
        "session_id": "s1", "created_at": "2026-07-01T00:00:00Z",
        "updated_at": "2026-07-02T00:00:00Z", "title": "first words",
        "project_id": "p", "transcript": [{"speaker": "user", "text": "first words"}],
    })
    assert c.session_store.set_title("s1", "A better name") is True
    payload = _on_disk(tmp_path, "s1")
    assert payload["custom_title"] == "A better name"
    assert payload["project_id"] == "p"
    assert payload["updated_at"] == "2026-07-02T00:00:00Z"
    assert _titles(c)["s1"] == "A better name"
    assert c.session_store.set_title("nobody", "x") is False
