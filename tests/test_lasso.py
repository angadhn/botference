"""Tests for lasso — bringing what you have read and said into a council chat.

Nothing here touches the network in anger: `BOTFERENCE_COMPANION` is pointed at
a port nothing is listening on, which is exactly the state a reader who has not
started the browser companion is in — so every test below is the FALLBACK path
as well as the path it looks like. The one test about the companion being there
stands up a tiny HTTP server of its own.

See core/lasso.py and frontends/plugin/SPEC.md, "lasso — bringing what you have
read and said into a chat".
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

import lasso
import video_watch
from botference import InputKind, parse_input

from test_botference import _make_botference  # the shared controller scaffolding


DEAD = "http://127.0.0.1:9"     # discard; nothing ever answers there


@pytest.fixture(autouse=True)
def _no_companion(monkeypatch):
    monkeypatch.setenv("BOTFERENCE_COMPANION", DEAD)


def _council(root: Path, chats: list[dict]) -> Path:
    (root / "work" / "sessions").mkdir(parents=True, exist_ok=True)
    for c in chats:
        (root / "work" / "sessions" / f"{c['id']}.json").write_text(json.dumps({
            "version": "2", "session_id": c["id"], "title": c["title"],
            "project_id": c.get("project", ""),
            "updated_at": c.get("updated", "2026-08-10T10:00:00Z"),
            "transcript": [{"speaker": s, "text": t} for s, t in c.get("msgs", [])],
        }), encoding="utf-8")
    return root


# ── the command ────────────────────────────────────────────


def test_lasso_is_a_command():
    assert parse_input("/lasso tether release").kind is InputKind.LASSO
    assert parse_input("/lasso tether release").body == "tether release"
    assert parse_input("/lasso").kind is InputKind.LASSO
    assert parse_input("/lasso attach 2").body == "attach 2"
    # …and a message that merely mentions it is a message
    assert parse_input("what does /lasso do?").kind is InputKind.MESSAGE


# ── the reply line ─────────────────────────────────────────


def test_a_bot_may_ask_for_a_search():
    assert lasso.parse_lasso_request("nothing here") is None
    assert lasso.parse_lasso_request("lasso: tether release") == "tether release"
    assert lasso.parse_lasso_request("ok.\n\nlasso: first\nlasso: second") == "second"
    assert lasso.parse_lasso_request("- **lasso: tether release**") == "tether release"
    assert lasso.parse_lasso_request("`lasso: tether release`") == "tether release"


def test_a_lasso_line_inside_a_fence_is_code():
    assert lasso.parse_lasso_request("```\nlasso: not a request\n```") is None
    assert lasso.parse_lasso_request("```\nlasso: no\n```\nlasso: yes please") == "yes please"


def test_a_bare_lasso_asks_for_nothing():
    assert lasso.parse_lasso_request("lasso:") is None
    assert lasso.parse_lasso_request("lasso:   ") is None
    assert lasso.parse_lasso_request("I could lasso: something for you") is None


def test_the_reply_line_protocols_ignore_each_other():
    """`watch:` and `lasso:` are different asks and must never cross."""
    assert video_watch.parse_video_request("lasso: tether release") is None
    assert lasso.parse_lasso_request("watch: https://youtu.be/abc") is None
    assert lasso.parse_lasso_request("ask gemini: what was in the video") is None
    both = "Sure.\n\nwatch: https://www.youtube.com/watch?v=dQw4w9WgXcQ\nlasso: tether release"
    assert lasso.parse_lasso_request(both) == "tether release"
    assert video_watch.parse_video_request(both)["kind"] == "watch"


# ── the fallback search ────────────────────────────────────


def test_local_search_finds_this_councils_own_chats(tmp_path):
    root = _council(tmp_path, [
        {"id": "s1", "title": "Tether release timing",
         "msgs": [["user", "when do we release?"],
                  ["claude", "the libration angle has to be through zero"]]},
        {"id": "s2", "title": "Kettle descaling",
         "msgs": [["user", "vinegar?"], ["claude", "vinegar."]]},
        {"id": "s3", "title": "empty", "msgs": []},
    ])
    rows = lasso.local_search(root, "tether")
    assert [r["id"] for r in rows] == ["s1"]
    assert rows[0]["kind"] == "chat"
    assert rows[0]["title"] == "Tether release timing"
    assert rows[0]["url_or_path"].endswith("s1.json")
    assert len(rows[0]["hit"]) <= lasso.HIT_MAX
    assert lasso.local_search(root, "libration")[0]["id"] == "s1"
    assert lasso.local_search(root, "zzzqq") == []
    assert lasso.local_search(root, "") == []
    assert not any(r["id"] == "s3" for r in lasso.local_search(root, "empty"))


def test_a_title_match_outranks_a_body_match(tmp_path):
    root = _council(tmp_path, [
        {"id": "body", "title": "Something else",
         "msgs": [["user", "kettle kettle kettle"]]},
        {"id": "title", "title": "The kettle", "msgs": [["user", "hello"]]},
    ])
    assert [r["id"] for r in lasso.local_search(root, "kettle")] == ["title", "body"]


def test_every_term_found_beats_most_terms_found(tmp_path):
    root = _council(tmp_path, [
        {"id": "one", "title": "tether tether tether tether", "msgs": [["user", "hi"]]},
        {"id": "both", "title": "tether release", "msgs": [["user", "hi"]]},
    ])
    assert lasso.local_search(root, "tether release")[0]["id"] == "both"


def test_search_says_it_fell_back(tmp_path):
    root = _council(tmp_path, [{"id": "s1", "title": "Tether", "msgs": [["user", "hi"]]}])
    r = lasso.search(root, "tether")
    assert r.source == "local"
    assert r.narrow is True
    assert [x["id"] for x in r.results] == ["s1"]


def test_the_companion_wins_when_it_is_running(tmp_path, monkeypatch):
    """One index on this machine: where the companion answers, it is the answer."""
    seen = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.path)
            body = json.dumps({"ok": True, "results": [
                {"kind": "page", "id": "abc", "title": "A page of mine",
                 "url_or_path": "https://x.test/p", "hit": "the tether", "when": ""},
            ]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # keep pytest output clean
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("BOTFERENCE_COMPANION", f"http://127.0.0.1:{srv.server_port}")
    try:
        _council(tmp_path, [{"id": "s1", "title": "Tether", "msgs": [["user", "hi"]]}])
        r = lasso.search(tmp_path, "tether")
        assert r.source == "companion"
        assert r.narrow is False
        assert [x["kind"] for x in r.results] == ["page"]
        assert "q=tether" in seen[0]
    finally:
        srv.shutdown()


# ── a path the reader named ────────────────────────────────


def test_a_path_is_checked_not_trusted(tmp_path):
    f = tmp_path / "paper.md"
    f.write_text("hello", encoding="utf-8")
    assert lasso.looks_like_path("~/x.pdf") and lasso.looks_like_path("/x.pdf")
    assert not lasso.looks_like_path("kalman filter")
    assert lasso.resolve_owner_path(str(f)) == (f, "")
    assert lasso.resolve_owner_path("/tmp/../etc/passwd")[1] == "that path is not allowed"
    assert lasso.resolve_owner_path(str(tmp_path))[1] == "no such file"
    assert lasso.resolve_owner_path("paper.md")[1] == "give an absolute path"
    assert lasso.resolve_owner_path("")[1] == "no path"


# ── digests ────────────────────────────────────────────────


def test_a_chat_digest_is_the_transcript_as_a_file(tmp_path):
    root = _council(tmp_path, [
        {"id": "s1", "title": "Tether release timing", "project": "orbits",
         "msgs": [["user", "when do we release?"], ["claude", "at libration zero"]]},
    ])
    row = lasso.local_chat_digest(root, "s1", tmp_path / "att")
    assert row["kind"] == "chat" and row["title"] == "Tether release timing"
    md = Path(row["path"]).read_text(encoding="utf-8")
    assert md.startswith("# Tether release timing")
    assert "- project: orbits" in md
    assert "**user:** when do we release?" in md
    assert "**claude:** at libration zero" in md
    assert "2 messages" in row["summary"]
    assert lasso.local_chat_digest(root, "nope", tmp_path / "att") is None


def test_a_file_digest_copies_and_leaves_the_original(tmp_path):
    src = tmp_path / "paper.md"
    src.write_text("# A paper\n", encoding="utf-8")
    row = lasso.local_file_digest(src, tmp_path / "att")
    assert row["kind"] == "file" and row["title"] == "paper.md"
    assert Path(row["path"]) != src
    assert Path(row["path"]).read_text(encoding="utf-8") == "# A paper\n"
    assert src.exists()
    assert "copied from" in row["summary"]


# ── the record's rules ─────────────────────────────────────


def test_no_duplicates_and_twenty_is_the_cap():
    rows: list[dict] = []
    for i in range(lasso.ATTACHMENTS_MAX):
        rows, why = lasso.add_attachment(
            rows, {"kind": "file", "id": f"/x/{i}", "title": f"{i}", "path": f"/a/{i}.md"})
        assert why == ""
    assert len(rows) == lasso.ATTACHMENTS_MAX
    same, why = lasso.add_attachment(
        rows, {"kind": "file", "id": "/x/0", "title": "0", "path": "/a/0.md"})
    assert why == "" and len(same) == lasso.ATTACHMENTS_MAX, "attaching twice is a no-op"
    over, why = lasso.add_attachment(
        rows, {"kind": "file", "id": "/x/new", "title": "new", "path": "/a/new.md"})
    assert "already carries 20" in why
    assert len(over) == lasso.ATTACHMENTS_MAX


def test_detach_deletes_our_digest_and_nothing_else(tmp_path):
    ours = tmp_path / ".botference" / "lasso" / "s1" / "chat-x.md"
    ours.parent.mkdir(parents=True)
    ours.write_text("digest", encoding="utf-8")
    theirs = tmp_path / "their-paper.md"
    theirs.write_text("theirs", encoding="utf-8")
    rows = [
        {"kind": "chat", "id": "s1", "title": "X", "path": str(ours)},
        {"kind": "file", "id": str(theirs), "title": "their-paper.md", "path": str(theirs)},
    ]
    kept, gone = lasso.detach(rows, "1")
    assert gone["title"] == "X"
    assert not ours.exists(), "our digest goes"
    assert len(kept) == 1
    kept2, gone2 = lasso.detach(kept, str(theirs))
    assert gone2 is not None and kept2 == []
    assert theirs.exists(), "a file outside .botference is never deleted"
    assert lasso.detach([], "1") == ([], None)


# ── the envelope ───────────────────────────────────────────


def test_the_block_names_paths_and_never_contents():
    rows = [{"kind": "chat", "id": "s1", "title": "Tether release timing",
             "path": "/w/.botference/lasso/s1/chat-tether.md",
             "summary": "A council chat about tethers."}]
    block = lasso.attachments_block(rows)
    assert block.startswith(lasso.ATTACH_HEADER)
    assert "never inline them back" in block
    assert "- Tether release timing (chat) — /w/.botference/lasso/s1/chat-tether.md" in block
    assert "A council chat about tethers." in block
    assert lasso.attachments_block([]) == ""


def test_past_the_budget_the_summaries_go_and_the_paths_stay():
    rows = [{"kind": "page", "id": f"p{i}", "title": f"Attachment number {i}",
             "path": f"/w/att/very-long-name-number-{i}.md", "summary": "x" * 400}
            for i in range(12)]
    block = lasso.attachments_block(rows)
    assert len(block) <= 1200
    assert "xxxx" not in block
    for r in rows:
        assert r["path"] in block
    assert "xxxx" in lasso.attachments_block(rows[:2])


# ── the controller ─────────────────────────────────────────


@pytest.mark.asyncio
class TestTheCommand:
    async def _bot(self, tmp_path, chats):
        _council(tmp_path, chats)
        c, claude, codex, ui = _make_botference(tmp_path=tmp_path)
        return c, ui

    async def test_a_search_shows_offers_and_attaches_nothing(self, tmp_path):
        c, ui = await self._bot(tmp_path, [
            {"id": "s1", "title": "Tether release timing",
             "msgs": [["user", "when?"], ["claude", "at libration zero"]]}])
        await c.handle_input("/lasso tether", ui)
        said = "\n".join(t for _, t in ui.room_entries)
        assert "1 match for “tether”" in said
        assert "Tether release timing" in said
        assert "/lasso attach" in said
        assert c._attachments == [], "a search attaches nothing"
        assert "this council's own chats only" in said, "and it says how far it looked"

    async def test_attaching_one_puts_it_on_the_record_and_in_the_room(self, tmp_path):
        c, ui = await self._bot(tmp_path, [
            {"id": "s1", "title": "Tether release timing",
             "msgs": [["user", "when?"], ["claude", "at libration zero"]]}])
        await c.handle_input("/lasso tether", ui)
        await c.handle_input("/lasso attach 1", ui)
        assert len(c._attachments) == 1
        row = c._attachments[0]
        assert row["kind"] == "chat" and row["title"] == "Tether release timing"
        assert Path(row["path"]).is_file()
        assert "at libration zero" in Path(row["path"]).read_text(encoding="utf-8")
        # the bots are told in the room too — an attachment mid-chat is news
        assert any("1 attachment added to this chat" in t for _, t in ui.room_entries)
        assert any("attachment added" in e.text for e in c.transcript.entries)

    async def test_the_turn_names_it_by_path_and_never_its_contents(self, tmp_path):
        c, ui = await self._bot(tmp_path, [
            {"id": "s1", "title": "Tether release timing",
             "msgs": [["user", "when?"], ["claude", "at libration zero"]]}])
        await c.handle_input("/lasso tether", ui)
        await c.handle_input("/lasso attach 1", ui)
        prompt = c._build_initial_prompt("claude")
        assert lasso.ATTACH_HEADER in prompt
        assert c._attachments[0]["path"] in prompt
        assert "never inline them back" in prompt
        assert "at libration zero" not in prompt.split(lasso.ATTACH_HEADER)[1]

    async def test_a_path_attaches_straight_away(self, tmp_path):
        c, ui = await self._bot(tmp_path, [])
        f = tmp_path / "kalman.md"
        f.write_text("# Kalman\n", encoding="utf-8")
        await c.handle_input(f"/lasso {f}", ui)
        assert [a["title"] for a in c._attachments] == ["kalman.md"]
        assert f.exists()

    async def test_a_path_that_is_not_a_file_is_refused_in_words(self, tmp_path):
        c, ui = await self._bot(tmp_path, [])
        await c.handle_input("/lasso /no/such/paper.pdf", ui)
        assert c._attachments == []
        assert any("no such file" in t for _, t in ui.room_entries)
        await c.handle_input("/lasso /tmp/../etc/passwd", ui)
        assert c._attachments == []
        assert any("not allowed" in t for _, t in ui.room_entries)

    async def test_attach_without_a_search_says_so(self, tmp_path):
        c, ui = await self._bot(tmp_path, [])
        await c.handle_input("/lasso attach 1", ui)
        assert c._attachments == []
        assert any("nothing on offer" in t for _, t in ui.room_entries)

    async def test_bare_lasso_lists_what_the_chat_carries(self, tmp_path):
        c, ui = await self._bot(tmp_path, [])
        await c.handle_input("/lasso", ui)
        assert any("carrying nothing" in t for _, t in ui.room_entries)
        f = tmp_path / "kalman.md"
        f.write_text("# Kalman\n", encoding="utf-8")
        await c.handle_input(f"/lasso {f}", ui)
        ui.room_entries.clear()
        await c.handle_input("/lasso", ui)
        said = "\n".join(t for _, t in ui.room_entries)
        assert "Attached to this chat (1)" in said and "kalman.md" in said

    async def test_detach_takes_it_off_and_the_turn_stops_naming_it(self, tmp_path):
        c, ui = await self._bot(tmp_path, [])
        f = tmp_path / "kalman.md"
        f.write_text("# Kalman\n", encoding="utf-8")
        await c.handle_input(f"/lasso {f}", ui)
        copied = Path(c._attachments[0]["path"])
        await c.handle_input("/lasso detach 1", ui)
        assert c._attachments == []
        assert not copied.exists(), "our copy goes"
        assert f.exists(), "theirs does not"
        assert lasso.ATTACH_HEADER not in c._build_initial_prompt("claude")
        await c.handle_input("/lasso detach 9", ui)
        assert any("Nothing to detach" in t for _, t in ui.room_entries)

    async def test_what_is_attached_survives_a_save_and_a_resume(self, tmp_path):
        c, ui = await self._bot(tmp_path, [])
        f = tmp_path / "kalman.md"
        f.write_text("# Kalman\n", encoding="utf-8")
        await c.handle_input(f"/lasso {f}", ui)
        payload = c._session_payload()
        assert [a["title"] for a in payload["attachments"]] == ["kalman.md"]
        c2, _, _, _ = _make_botference(tmp_path=tmp_path)
        c2._restore_from_payload(payload)
        assert [a["title"] for a in c2._attachments] == ["kalman.md"]
        assert c2._lasso_offer == [], "the last search's menu is not a fact worth keeping"
        # …and a chat that never used it writes no field at all
        c3, _, _, _ = _make_botference(tmp_path=tmp_path)
        assert "attachments" not in c3._session_payload()

    async def test_a_bots_lasso_line_shows_the_reader_the_matches(self, tmp_path):
        c, ui = await self._bot(tmp_path, [
            {"id": "s1", "title": "Tether release timing",
             "msgs": [["user", "when?"], ["claude", "at libration zero"]]}])
        c._maybe_lasso_for_bot("Because of the libration.\n\nlasso: tether release", ui)
        said = "\n".join(t for _, t in ui.room_entries)
        assert "match" in said and "Tether release timing" in said
        assert c._attachments == [], "a bot's ask attaches nothing"
        assert len(c._lasso_offer) == 1, "and the reader can now take it"

    async def test_a_reply_with_no_lasso_line_does_nothing(self, tmp_path):
        c, ui = await self._bot(tmp_path, [
            {"id": "s1", "title": "Tether", "msgs": [["user", "hi"]]}])
        c._maybe_lasso_for_bot("Just an answer.", ui)
        assert ui.room_entries == []
        assert c._lasso_offer == []
