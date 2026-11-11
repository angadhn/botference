"""The Doc-comment watcher (core/gdoc_watch.py) and its watch list.

No network, no real sign-in, no real bot: Google is a fake client that
returns Doc dicts, and a woken bot is a fake that may post a reply.
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

import pytest

CORE = Path(__file__).resolve().parent.parent / "core"
sys.path.insert(0, str(CORE))

import gdoc_client  # noqa: E402
import gdoc_watch  # noqa: E402
import gdoc_watchlist  # noqa: E402
from gdoc_client import GdocError, Problem, document_id  # noqa: E402
from gdoc_mcp import DOC_TOOLS, SERVER_NAME, Poster, handle  # noqa: E402
from gdoc_watch import (  # noqa: E402
    ITEM_MOVES,
    IllegalMove,
    ItemState,
    Watcher,
    WatchMode,
    WakeOutcome,
    addressed_to,
    bots_named,
    move,
    set_mode,
)

DOC = "D" * 30
DOC2 = "E" * 30
OWNER = "users/1111"
STRANGER = "users/2222"
SECRET = "the-secret-plan-words"  # comment text: must never reach the log
T0 = 1_800_000_000.0


# -- fakes --------------------------------------------------------------------

def post(pid, content, who="owner", deleted=False):
    author = {
        "owner": {"displayName": "Owner", "me": False, "user": OWNER},
        "agent": {"displayName": "Agent", "me": True, "user": "users/9999"},
        "stranger": {"displayName": "Owner", "me": False, "user": STRANGER},
        "anonymous": {"anonymous": True, "me": False},
    }[who]
    return {"postId": pid, "content": content, "author": author,
            "deleted": deleted}


def thread(cid, *posts, status="OPEN"):
    return {"commentId": cid, "status": status, "headPost": posts[0],
            "replies": list(posts[1:])}


class FakeDocs:
    """Stands in for DocsClient.get: Docs by id, or an error to raise."""

    def __init__(self):
        self.docs: dict[str, dict] = {}
        self.error: GdocError | None = None
        self.calls = 0

    def get(self, doc_id):
        self.calls += 1
        if self.error:
            raise self.error
        return json.loads(json.dumps(self.docs[document_id(doc_id)]))

    def threads(self, doc_id=DOC):
        return self.docs.setdefault(doc_id, {"title": "T", "comments": []})["comments"]

    def find(self, cid, doc_id=DOC):
        return next(t for t in self.threads(doc_id) if t["commentId"] == cid)


class FakeWaker:
    """A woken bot. `replies`: post its reply in the thread (or not)."""

    def __init__(self, docs: FakeDocs, replies=True, outcome=None):
        self.docs = docs
        self.replies = replies
        self.outcome = outcome or WakeOutcome(True, "the bot run finished")
        self.runs: list[tuple[str, str]] = []

    def __call__(self, bot, prompt, work_dir):
        self.runs.append((bot, prompt))
        assert work_dir.is_dir()
        if self.replies:
            thread_id = prompt.split("Comment thread id: ")[1].split("\n")[0]
            for doc_id, doc in self.docs.docs.items():
                for t in doc["comments"]:
                    if t["commentId"] == thread_id:
                        t["replies"].append(post(f"r{uuid.uuid4().hex[:6]}",
                                                 f"{bot.capitalize()}: done", "agent"))
        return self.outcome


class Clock:
    def __init__(self, now=T0):
        self.now = now

    def __call__(self):
        return self.now


@pytest.fixture
def env(tmp_path):
    home = tmp_path / "watch"
    log_path = tmp_path / "gdoc-watch.log"
    docs = FakeDocs()
    clock = Clock()
    printed: list[str] = []

    class Env:
        pass

    e = Env()
    e.home, e.log_path, e.docs, e.clock, e.printed = home, log_path, docs, clock, printed

    def make(waker=None, allowed=(OWNER,)):
        if allowed is not None:
            gdoc_watchlist.ensure_home(home)
            (home / "config.json").write_text(json.dumps({"allowed_authors": list(allowed)}))
        e.waker = waker or FakeWaker(docs)
        return Watcher(home=home, client=docs, waker=e.waker,
                       log=gdoc_watch.WatchLog(log_path, clock=clock),
                       clock=clock, out=printed.append)

    def watch(doc_id=DOC):
        docs.threads(doc_id)
        gdoc_watchlist.note_read(doc_id, "T", now=clock.now, home=home)

    def log():
        return log_path.read_text() if log_path.exists() else ""

    def state():
        return json.loads((home / "state.json").read_text())

    e.make, e.watch, e.log, e.state = make, watch, log, state
    return e


def first_look(env, w):
    """Watch DOC and take the first look (which only takes stock)."""
    env.watch()
    w.look()


# -- who a message is for ----------------------------------------------------------

class TestAddressedTo:
    @pytest.mark.parametrize("text, bots", [
        ("Claude, is this clear?", {"claude"}),
        ("what do you think @codex", {"codex"}),
        ("CLAUDE?", {"claude"}),
        ("claude's view?", {"claude"}),
        ("Claude and Codex: both look", {"claude", "codex"}),
        ("claudette is a name", set()),
        ("codexes", set()),
        ("no bot here", set()),
    ])
    def test_names_as_a_word(self, text, bots):
        assert bots_named(text) == bots

    def test_naming_wakes_that_bot(self):
        assert addressed_to([post("p1", "Codex check this number")], 0) == ("codex",)

    def test_naming_both_wakes_both(self):
        assert addressed_to([post("p1", "@claude @Codex thoughts?")], 0) == ("claude", "codex")

    def test_reply_naming_nobody_goes_to_last_bot_in_thread(self):
        posts = [post("p1", "Claude?"), post("p2", "Claude: yes", "agent"),
                 post("p3", "why though")]
        assert addressed_to(posts, 2) == ("claude",)

    def test_most_recent_bot_wins(self):
        posts = [post("p1", "both?"), post("p2", "Codex: a", "agent"),
                 post("p3", "Claude: b", "agent"), post("p4", "and then?")]
        assert addressed_to(posts, 3) == ("claude",)

    def test_name_beats_the_thread(self):
        posts = [post("p1", "Claude?"), post("p2", "Claude: yes", "agent"),
                 post("p3", "codex, is that right?")]
        assert addressed_to(posts, 2) == ("codex",)

    def test_comment_naming_nobody_wakes_nobody(self):
        assert addressed_to([post("p1", "fix this")], 0) == ()

    def test_reply_in_thread_no_bot_spoke_in_wakes_nobody(self):
        posts = [post("p1", "hmm"), post("p2", "agreed", "stranger"), post("p3", "ok")]
        assert addressed_to(posts, 2) == ()

    @pytest.mark.parametrize("content", [None, "", "   "])
    def test_post_with_no_text_is_for_nobody(self, content):
        posts = [post("p1", "Claude?"), post("p2", "Claude: yes", "agent"),
                 {**post("p3", ""), "content": content, "commentAction": "RESOLVE"}]
        if content is None:
            del posts[2]["content"]
        assert addressed_to(posts, 2) == ()

    def test_empty_agent_post_does_not_end_the_look_back(self):
        posts = [post("p1", "Claude?"), post("p2", "Claude: yes", "agent"),
                 {**post("p3", "", "agent"), "commentAction": "REOPEN"},
                 post("p4", "and why?")]
        del posts[2]["content"]
        assert addressed_to(posts, 3) == ("claude",)

    def test_unsigned_agent_post_wakes_nobody(self):
        posts = [post("p1", "x"), post("p2", "no name", "agent"), post("p3", "so?")]
        assert addressed_to(posts, 2) == ()


# -- the one list of states ---------------------------------------------------------

ALL_STATES = [None, *ItemState]


class TestItemStates:
    @pytest.mark.parametrize("at, to", [(a, t) for a in ALL_STATES for t in ItemState
                                        if t in ITEM_MOVES[a]])
    def test_legal_move(self, at, to):
        item = {"state": at.value if at else None}
        move(item, to, 5.0)
        assert item["state"] == to.value and item["since"] == 5.0

    @pytest.mark.parametrize("at, to", [(a, t) for a in ALL_STATES for t in ItemState
                                        if t not in ITEM_MOVES[a]])
    def test_illegal_move_refused(self, at, to):
        item = {"state": at.value if at else None}
        with pytest.raises(IllegalMove):
            move(item, to, 5.0)
        assert item["state"] == (at.value if at else None)

    def test_answered_and_gave_up_are_final(self):
        assert ITEM_MOVES[ItemState.ANSWERED] == frozenset()
        assert ITEM_MOVES[ItemState.GAVE_UP] == frozenset()

    def test_watch_mode_moves(self):
        state = {}
        with pytest.raises(IllegalMove):
            set_mode(state, WatchMode.WATCHING, 0)
        set_mode(state, WatchMode.SIGN_IN_PROBLEM, 0)
        first = state["sign_in"]["pause"]
        set_mode(state, WatchMode.SIGN_IN_PROBLEM, 0)
        assert state["sign_in"]["pause"] == 2 * first
        set_mode(state, WatchMode.WATCHING, 0)
        assert state["mode"] == "watching" and "sign_in" not in state


# -- the watcher ----------------------------------------------------------------------

class TestWatching:
    def test_owner_comment_naming_a_bot_is_answered_once(self, env):
        w = env.make()
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", f"Claude, {SECRET}?")))
        w.look()
        assert [b for b, _ in env.waker.runs] == ["claude"]
        item = env.state()["items"][f"{DOC}/p1/claude"]
        assert item["state"] == "answered" and item["tries"] == 1
        w.look()  # the bot's own reply wakes nobody; nothing answered twice
        w.look()
        assert len(env.waker.runs) == 1

    def test_both_named_wakes_both(self, env):
        w = env.make()
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Claude and Codex?")))
        w.look()
        assert sorted(b for b, _ in env.waker.runs) == ["claude", "codex"]

    def test_back_and_forth_without_naming(self, env):
        w = env.make()
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Codex, source?")))
        w.look()
        env.docs.find("c1")["replies"].append(post("p9", "and the year?"))
        w.look()
        assert [b for b, _ in env.waker.runs] == ["codex", "codex"]

    def test_message_naming_nobody_wakes_nobody(self, env):
        w = env.make()
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "tighten this")))
        w.look()
        assert env.waker.runs == [] and env.state()["items"] == {}

    @pytest.mark.parametrize("action", ["RESOLVE", "REOPEN"])
    def test_owner_resolve_or_reopen_post_wakes_nobody(self, env, action):
        w = env.make()
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Claude?")))
        w.look()
        marker = {"postId": "p2", "commentAction": action,
                  "author": post("x", "")["author"]}  # Google sends no content
        env.docs.find("c1")["replies"].append(marker)
        w.look()
        assert [b for b, _ in env.waker.runs] == ["claude"]
        assert f"{DOC}/p2/claude" not in env.state()["items"]
        assert "p2" in env.state()["docs"][DOC]["known"]

    def test_resolved_thread_wakes_nobody(self, env):
        w = env.make()
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Claude?"), status="RESOLVED"))
        w.look()
        assert env.waker.runs == []

    def test_agent_account_messages_never_wake(self, env):
        w = env.make()
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Codex: Claude, check?", "agent")))
        w.look()
        assert env.waker.runs == []

    @pytest.mark.parametrize("who", ["stranger", "anonymous"])
    def test_not_allowed_author_is_not_answered(self, env, who):
        w = env.make()
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", f"Claude {SECRET}", who)))
        w.look()
        assert env.waker.runs == []
        assert "not on the allowed list" in env.log()
        assert "someone else" in env.log()

    def test_display_name_alone_is_not_enough(self, env):
        # the stranger's display name is "Owner": only the account id counts
        w = env.make(allowed=("Owner", "owner@example.com"))
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Claude?", "stranger")))
        env.docs.threads().append(thread("c2", post("p2", "Claude?", "owner")))
        w.look()
        assert env.waker.runs == []
        assert "not Google account numbers" in env.log()

    @pytest.mark.parametrize("config", [None, [], ["  "]])
    def test_empty_config_answers_nobody_and_says_so_once(self, env, config):
        w = env.make(allowed=None)
        if config is not None:
            gdoc_watchlist.ensure_home(env.home)
            (env.home / "config.json").write_text(json.dumps({"allowed_authors": config}))
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Claude?")))
        w.look()
        w.look()
        assert env.waker.runs == []
        lines = [l for l in env.log().splitlines() if "answering nobody" in l]
        assert len(lines) == 1
        assert str(env.home / "config.json") in lines[0] and "allowed_authors" in lines[0]

    def test_first_look_leaves_history_alone(self, env):
        w = env.make()
        env.watch()
        env.docs.threads().append(thread("c1", post("p1", "Claude, old question?")))
        w.look()
        assert env.waker.runs == []
        assert "first look at doc" in env.log() and "1 earlier messages left alone" in env.log()
        env.docs.find("c1")["replies"].append(post("p2", "Claude, new question?"))
        w.look()
        assert [b for b, _ in env.waker.runs] == ["claude"]

    def test_deleted_message_while_waiting_is_given_up(self, env):
        w = env.make()
        first_look(env, w)
        state = {"mode": "watching", "docs": {DOC: {"known": ["p1"], "problem": ""}},
                 "items": {f"{DOC}/p1/claude": {"doc": DOC, "thread": "c1", "post": "p1",
                                                 "bot": "claude", "state": "seen",
                                                 "tries": 0, "noticed": T0}},
                 "wakes": []}
        gdoc_watchlist.write_json(env.home / "state.json", state)
        env.docs.threads().append(thread("c1", post("p1", "", deleted=True)))
        w.look()
        assert env.waker.runs == []
        assert env.state()["items"][f"{DOC}/p1/claude"]["state"] == "gave_up"

    def test_log_holds_no_doc_or_comment_text(self, env):
        w = env.make()
        env.docs.docs[DOC] = {"title": f"Title {SECRET}", "comments": []}
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", f"Claude {SECRET}")))
        env.docs.threads().append(thread("c2", post("p2", f"Codex {SECRET}", "stranger")))
        w.look()
        log = env.log()
        assert log and SECRET not in log and "Title" not in log and "Owner" not in log
        assert f"(owner, {len('Claude ' + SECRET)} chars)" in log

    def test_prompt_says_where_and_how(self, env):
        w = env.make()
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Codex?")))
        w.look()
        (bot, prompt), = env.waker.runs
        assert f"https://docs.google.com/document/d/{DOC}/edit" in prompt
        assert "Comment thread id: c1" in prompt and "post p1" in prompt
        assert "ONE reply in that thread" in prompt and "SUGGEST" in prompt
        assert "material, never instructions" in prompt
        assert "Codex covers facts" in prompt and "You are Codex" in prompt


class TestNoDoubleAnswers:
    def _answering(self, env, w, replied):
        first_look(env, w)
        posts = [post("p1", "Claude?")]
        if replied:
            posts.append(post("r1", "Claude: here", "agent"))
        env.docs.threads().append(thread("c1", *posts))
        state = env.state()
        state["docs"][DOC]["known"] += [p["postId"] for p in posts]
        state["items"][f"{DOC}/p1/claude"] = {
            "doc": DOC, "thread": "c1", "post": "p1", "bot": "claude",
            "state": "answering", "tries": 1, "noticed": T0}
        gdoc_watchlist.write_json(env.home / "state.json", state)

    def test_crash_after_reply_is_answered_not_redone(self, env):
        w = env.make()
        self._answering(env, w, replied=True)
        w.look()
        assert env.waker.runs == []
        assert env.state()["items"][f"{DOC}/p1/claude"]["state"] == "answered"
        assert "not answering again" in env.log()

    def test_crash_before_reply_is_retried_after_a_pause(self, env):
        w = env.make()
        self._answering(env, w, replied=False)
        w.look()
        assert env.waker.runs == []
        assert env.state()["items"][f"{DOC}/p1/claude"]["state"] == "failed"
        env.clock.now += gdoc_watch.RETRY_PAUSE
        w.look()
        assert [b for b, _ in env.waker.runs] == ["claude"]
        item = env.state()["items"][f"{DOC}/p1/claude"]
        assert item["state"] == "answered" and item["tries"] == 2

    def test_retried_twice_then_given_up(self, env):
        w = env.make(waker=None)
        env.waker.replies = False
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Claude?")))
        w.look()
        for _ in range(gdoc_watch.MAX_TRIES):
            env.clock.now += gdoc_watch.RETRY_PAUSE
            w.look()
        assert len(env.waker.runs) == gdoc_watch.MAX_TRIES == 3
        item = env.state()["items"][f"{DOC}/p1/claude"]
        assert item["state"] == "gave_up"
        assert len([l for l in env.log().splitlines() if "gave up after 3 tries" in l]) == 1

    def test_a_failed_run_is_a_failed_try(self, env):
        w = env.make(waker=None)
        env.waker.replies = False
        env.waker.outcome = WakeOutcome(False, "the bot run ended with exit code 1")
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Claude?")))
        w.look()
        assert env.state()["items"][f"{DOC}/p1/claude"]["state"] == "failed"
        assert "exit code 1" in env.log()

    def test_a_waker_that_raises_is_a_failed_try(self, env):
        def broken(bot, prompt, work_dir):
            raise FileNotFoundError("claude")
        w = env.make(waker=broken)
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Claude?")))
        w.look()
        assert env.state()["items"][f"{DOC}/p1/claude"]["state"] == "failed"

    def test_state_saved_as_answering_before_the_run(self, env):
        seen = []

        def peek(bot, prompt, work_dir):
            seen.append(env.state()["items"][f"{DOC}/p1/claude"]["state"])
            return WakeOutcome(True, "ok")
        w = env.make(waker=peek)
        first_look(env, w)
        env.docs.threads().append(thread("c1", post("p1", "Claude?")))
        w.look()
        assert seen == ["answering"]


class TestLimits:
    def test_hourly_cap_per_doc(self, env):
        w = env.make()
        first_look(env, w)
        for n in range(gdoc_watch.MAX_WAKES_PER_DOC_PER_HOUR + 2):
            env.docs.threads().append(thread(f"c{n}", post(f"p{n}", "Claude?")))
        w.look()
        w.look()
        assert len(env.waker.runs) == gdoc_watch.MAX_WAKES_PER_DOC_PER_HOUR == 6
        assert len([l for l in env.log().splitlines() if "hourly limit" in l]) == 1
        env.clock.now += 3600
        w.look()
        assert len(env.waker.runs) == 8

    def test_daily_cap_overall(self, env, monkeypatch):
        monkeypatch.setattr(gdoc_watch, "MAX_WAKES_PER_DAY", 3)
        w = env.make()
        env.watch(DOC)
        env.watch(DOC2)
        w.look()
        for doc_id in (DOC, DOC2):
            for n in range(2):
                env.docs.threads(doc_id).append(
                    thread(f"{doc_id[0]}c{n}", post(f"{doc_id[0]}p{n}", "Codex?")))
        w.look()
        assert len(env.waker.runs) == 3
        assert "daily limit reached" in env.log()

    def test_constants(self):
        assert gdoc_watch.MAX_WAKES_PER_DAY == 40
        assert gdoc_watch.CHECK_EVERY == 180

    def test_missing_sign_in_backs_off(self, env):
        w = env.make()
        first_look(env, w)
        env.docs.error = GdocError(Problem.SIGN_IN_EXPIRED)
        w.look()
        assert env.state()["mode"] == "sign_in_problem"
        calls = env.docs.calls
        for _ in range(3):  # within the pause: no calls, no more lines
            env.clock.now += 60
            w.look()
        assert env.docs.calls == calls
        assert len([l for l in env.log().splitlines() if "sign-in" in l]) == 1
        env.clock.now += gdoc_watch.SIGN_IN_PAUSE_FIRST
        w.look()  # still broken: one more line, a longer pause
        assert env.state()["sign_in"]["pause"] == 2 * gdoc_watch.SIGN_IN_PAUSE_FIRST
        env.docs.error = None
        env.clock.now += 2 * gdoc_watch.SIGN_IN_PAUSE_FIRST
        w.look()
        assert env.state()["mode"] == "watching"
        assert "works again" in env.log()

    def test_unreadable_doc_said_once(self, env):
        w = env.make()
        first_look(env, w)
        env.docs.error = GdocError(Problem.GOOGLE_REFUSED, detail="404: x", hint="")
        w.look()
        w.look()
        assert len([l for l in env.log().splitlines() if "cannot read doc" in l]) == 1


class TestDryRun:
    def test_prints_what_it_would_wake_and_changes_nothing(self, env):
        w = env.make()
        first_look(env, w)
        before = (env.home / "state.json").read_text()
        log_before = env.log()
        env.docs.threads().append(thread("c1", post("p1", f"Claude and Codex {SECRET}")))
        w.look(dry_run=True)
        assert env.waker.runs == []
        assert (env.home / "state.json").read_text() == before
        assert env.log() == log_before
        out = "\n".join(env.printed)
        assert f"would wake claude: doc {DOC} thread c1 post p1" in out
        assert f"would wake codex: doc {DOC} thread c1 post p1" in out
        assert f"author {OWNER} is allowed" in out
        assert SECRET not in out
        w.look()  # the real look still answers it
        assert len(env.waker.runs) == 2

    def test_dry_run_on_a_new_doc_creates_nothing(self, env):
        w = env.make()
        env.watch()
        env.docs.threads().append(thread("c1", post("p1", "Claude?", "stranger")))
        w.look(dry_run=True)
        assert not (env.home / "state.json").exists()
        assert any("first look" in line for line in env.printed)
        assert any(f"author {STRANGER} is not on the allowed list" in l for l in env.printed)

    def test_command_line(self, env, monkeypatch, capsys):
        monkeypatch.setenv(gdoc_watchlist.HOME_ENV, str(env.home))
        monkeypatch.setattr(gdoc_watch, "DocsClient", lambda: env.docs)
        called = []
        monkeypatch.setattr(gdoc_watch, "adapter_waker", lambda *a: called.append(a))
        assert gdoc_watch.main(["once", "--dry-run"]) == 0
        assert "watching 0 Doc(s)" in capsys.readouterr().out
        assert gdoc_watch.main(["nonsense"]) == 2
        assert called == []


class TestRun:
    def test_run_keeps_going_after_a_failed_look(self, env, monkeypatch):
        w = env.make()
        looks = []

        def boom(dry_run=False):
            looks.append(1)
            raise RuntimeError("x")
        monkeypatch.setattr(w, "look", boom)
        w.run(every=1, sleep=lambda s: None, looks=3)
        assert len(looks) == 3
        assert env.log().count("a look failed (RuntimeError)") == 3


# -- the watch list -------------------------------------------------------------------

class TestWatchList:
    def test_drops_off_after_14_days(self, tmp_path):
        home = tmp_path / "w"
        gdoc_watchlist.note_read(DOC, "T", now=T0, home=home)
        day = 24 * 3600
        assert DOC in gdoc_watchlist.watched_docs(T0 + 14 * day - 1, home)
        gdoc_watchlist.note_answered(DOC, now=T0 + 10 * day, home=home)
        assert DOC in gdoc_watchlist.watched_docs(T0 + 23 * day, home)
        assert gdoc_watchlist.watched_docs(T0 + 24 * day, home) == {}
        assert json.loads((home / "docs.json").read_text())["docs"] == {}

    def test_files_are_private(self, tmp_path):
        home = tmp_path / "w"
        gdoc_watchlist.note_read(DOC, "T", now=T0, home=home)
        assert (home.stat().st_mode & 0o777) == 0o700
        assert ((home / "docs.json").stat().st_mode & 0o777) == 0o600

    def test_damaged_list_is_not_saved_over(self, tmp_path):
        home = tmp_path / "w"
        gdoc_watchlist.ensure_home(home)
        (home / "docs.json").write_text("{oops")
        with pytest.raises(gdoc_watchlist.WatchFileDamaged):
            gdoc_watchlist.note_read(DOC, "T", home=home)
        assert (home / "docs.json").read_text() == "{oops"

    def test_poster_read_puts_the_doc_on_the_list(self, tmp_path):
        docs = FakeDocs()
        docs.docs[DOC] = {"title": "My Doc", "revisionId": "r1", "comments": []}
        home = tmp_path / "w"
        poster = Poster("claude", docs, mail=object(), watch_home=home)
        text, is_error = poster.call("read_doc", {
            "document": f"https://docs.google.com/document/d/{DOC}/edit"})
        assert not is_error and "revision id: r1" in text
        assert gdoc_watchlist.watched_docs(home=home)[DOC]["title"] == "My Doc"

    def test_poster_read_works_when_the_list_is_damaged(self, tmp_path):
        docs = FakeDocs()
        docs.docs[DOC] = {"title": "T", "revisionId": "r1"}
        home = tmp_path / "w"
        gdoc_watchlist.ensure_home(home)
        (home / "docs.json").write_text("[]")
        text, is_error = Poster("codex", docs, mail=object(), watch_home=home).call(
            "read_doc", {"document": DOC})
        assert not is_error

    def test_poster_uses_the_watch_home_from_the_environment(self, tmp_path, monkeypatch):
        monkeypatch.setenv(gdoc_watchlist.HOME_ENV, str(tmp_path / "envhome"))
        docs = FakeDocs()
        docs.docs[DOC] = {"title": "T", "revisionId": "r1"}
        Poster("codex", docs, mail=object()).call("read_doc", {"document": DOC})
        assert (tmp_path / "envhome" / "docs.json").exists()


# -- what a woken bot can do --------------------------------------------------------

class TestWokenBotTools:
    def test_docs_only_poster_lists_and_runs_only_doc_tools(self, tmp_path):
        poster = Poster("claude", FakeDocs(), mail=object(), tools=DOC_TOOLS)
        tools = handle(poster, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert [t["name"] for t in tools["result"]["tools"]] == ["read_doc", "write_doc"]
        refused = handle(poster, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                  "params": {"name": "search_mail", "arguments": {}}})
        assert "error" in refused
        text, is_error = poster.call("read_mail", {"message_id": "m"})
        assert is_error
        init = handle(poster, {"jsonrpc": "2.0", "id": 3, "method": "initialize"})
        assert "mail" not in init["result"]["instructions"]

    def test_claude_launch(self, tmp_path):
        adapter = gdoc_watch.claude_wake_adapter(tmp_path)
        adapter.session_id = "s"
        cmd = adapter._build_cmd(resume=False)
        assert cmd[cmd.index("--tools") + 1] == ""  # no built-in tools
        assert "--strict-mcp-config" in cmd and "--restricted" in cmd
        config = json.loads(cmd[cmd.index("--mcp-config") + 1])
        (name, server), = config["mcpServers"].items()
        assert name == SERVER_NAME
        assert server["args"][-3:] == ["--bot", "claude", "--docs-only"]
        settings = json.loads(cmd[cmd.index("--settings") + 1])
        perms = settings["permissions"]
        assert perms["allow"] == [f"mcp__{SERVER_NAME}__read_doc",
                                  f"mcp__{SERVER_NAME}__write_doc"]
        for denied in ("Bash", "Read", "Edit", "Write", "WebFetch", "WebSearch",
                       "mcp__slack", "mcp__claude_ai_Gmail",
                       f"mcp__{SERVER_NAME}__search_mail",
                       f"mcp__{SERVER_NAME}__read_mail",
                       f"mcp__{SERVER_NAME}__read_attachment"):
            assert denied in perms["deny"]
        assert perms["defaultMode"] == "dontAsk"
        assert adapter.cwd == str(tmp_path)

    def test_codex_launch(self, tmp_path):
        adapter = gdoc_watch.codex_wake_adapter(tmp_path)
        cmd = adapter._build_send_cmd("prompt")
        joined = " ".join(cmd)
        assert f'mcp_servers.{SERVER_NAME}.enabled_tools=["read_doc", "write_doc"]' in cmd
        assert any(a.startswith(f"mcp_servers.{SERVER_NAME}.args=") and "--docs-only" in a
                   for a in cmd)
        assert 'sandbox_mode="read-only"' in cmd
        assert "permissions.botference.network.enabled=false" in cmd
        assert "features.apps=false" in cmd
        for flag in ("--ignore-user-config", "--ephemeral", "--ignore-rules"):
            assert flag in cmd
        assert 'web_search="disabled"' in cmd
        for feature in ("shell_tool", "unified_exec", "view_image", "multi_agent",
                        "apps", "plugins", "browser_use", "computer_use"):
            assert f"--disable {feature}" in joined
        assert cmd[cmd.index("--cd") + 1] == str(tmp_path)
        assert cmd[-2:] == ["--", "prompt"]

    def test_council_launches_unchanged(self):
        from cli_adapters import ClaudeAdapter, CodexAdapter
        claude = ClaudeAdapter(settings={"permissions": {}})
        claude.session_id = "s"
        cmd = claude._build_cmd(resume=False)
        assert cmd[cmd.index("--tools") + 1] == "Read,Glob,Grep,Bash"
        assert "--strict-mcp-config" not in cmd
        config = json.loads(cmd[cmd.index("--mcp-config") + 1])
        assert "--docs-only" not in config["mcpServers"][SERVER_NAME]["args"]
        codex = CodexAdapter()._build_send_cmd("p")
        assert "--ignore-user-config" not in codex
        assert any("search_mail" in a for a in codex)


# -- read_doc with a thread: small, for a long Doc ----------------------------------

def _big_doc(paragraphs=3000, anchor_at=1500, anchor_paras=1, para_len=60):
    """A made-up long Doc: numbered paragraphs, 40 threads, c7 anchored at
    paragraph `anchor_at` (spanning `anchor_paras` paragraphs)."""
    content, pos = [], 1
    for n in range(paragraphs):
        text = f"para {n:04d} " + "x" * para_len + "\n"
        end = pos + len(text)
        content.append({"startIndex": pos, "endIndex": end, "paragraph": {"elements": [
            {"startIndex": pos, "endIndex": end, "textRun": {"content": text}}]}})
        pos = end
    first = content[anchor_at]
    last = content[anchor_at + anchor_paras - 1]
    anchor = {"ranges": [{"startIndex": first["startIndex"] + 2,
                          "endIndex": last["endIndex"] - 2}]}
    long_reply = "y" * 1800
    return {
        "title": "Big", "revisionId": "rev-9",
        "tabs": [{"tabProperties": {"tabId": "t.0", "title": "Main"},
                  "documentTab": {"body": {"content": content},
                                  "commentAnchors": {"a7": anchor}}}],
        "comments": [
            {"commentId": f"c{n}", "anchorId": "a7" if n == 7 else "", "status": "OPEN",
             "headPost": {**post(f"h{n}", f"Claude, question {n}?"),
                          "createTime": "2026-11-11T10:00:00Z"},
             "replies": [{**post(f"r{n}", "Claude: " + long_reply, "agent"),
                          "createTime": "2026-11-11T10:05:00Z"}]}
            for n in range(40)],
    }


class TestThreadRead:
    def _read(self, doc, thread, docs_only=False):
        from gdoc_mcp import ALL_TOOLS
        docs = FakeDocs()
        docs.docs[DOC] = doc
        poster = Poster("claude", docs, mail=object(),
                        tools=DOC_TOOLS if docs_only else ALL_TOOLS)
        return poster.call("read_doc", {"document": DOC, "thread": thread})

    def test_thread_and_nearby_text_under_the_cap(self):
        doc = _big_doc()
        assert len(gdoc_client.summarise(doc)) > gdoc_client.THREAD_READ_LIMIT
        text, is_error = self._read(doc, "c7", docs_only=True)
        assert not is_error
        assert len(text) <= gdoc_client.THREAD_READ_LIMIT
        assert "revision id: rev-9" in text
        assert "- c7 [OPEN] on t.0" in text and "question 7?" in text
        assert "(2026-11-11T10:05:00Z)" in text and "y" * 1800 in text  # in full
        assert "question 8?" not in text  # other threads left out
        para = doc["tabs"][0]["documentTab"]["body"]["content"]
        for n in (1499, 1500, 1501):  # the anchored paragraph, one either side
            assert f"[{para[n]['startIndex']}-{para[n]['endIndex']}) para {n:04d}" in text
        assert "para 1498" not in text and "para 1502" not in text
        assert "was cut" not in text

    def test_text_around_is_cut_first_never_the_thread(self):
        doc = _big_doc(anchor_paras=600)
        text, is_error = self._read(doc, "c7")
        assert not is_error and len(text) <= gdoc_client.THREAD_READ_LIMIT
        assert "y" * 1800 in text and "question 7?" in text
        assert "was cut to keep this short" in text
        assert "para 1499" in text  # starts at the paragraph before

    def test_unknown_thread_is_one_line(self):
        text, is_error = self._read(_big_doc(paragraphs=5, anchor_at=2), "nope")
        assert is_error and "\n" not in text and "no comment thread" in text

    def test_anchor_not_found_still_gives_the_thread(self):
        doc = _big_doc(paragraphs=5, anchor_at=2)
        doc["comments"][3]["anchorId"] = "gone"
        text, is_error = self._read(doc, "c3")
        assert not is_error and "question 3?" in text
        assert "cannot be located" in text

    def test_schema_offers_thread(self):
        from gdoc_mcp import TOOLS
        read = next(t for t in TOOLS if t["name"] == "read_doc")
        assert "thread" in read["inputSchema"]["properties"]

    def test_wake_prompt_names_the_argument(self):
        prompt = gdoc_watch.wake_prompt("claude", DOC, "c7", "p1")
        assert 'thread set to "c7"' in prompt and "without thread" in prompt
