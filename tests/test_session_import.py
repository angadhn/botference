"""core/session_import.py — a council chat that starts with a conversation in it.

The browser plugin's "continue in council" hands this script a clean
conversation and expects back a council session that (a) the council lists,
(b) resumes like any other chat, and (c) gives both bots the whole carried-over
conversation on the reader's first message, under the COUNCIL's own system
prompt — never the plugin's margin-note one.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

CORE = Path(__file__).resolve().parent.parent / "core"
sys.path.insert(0, str(CORE))

from paths import BotferencePaths  # noqa: E402
from session_import import build_payload, import_chat  # noqa: E402
from session_store import SessionStore  # noqa: E402

from test_botference import _make_botference  # noqa: E402


def _council(tmp_path: Path) -> BotferencePaths:
    root = tmp_path / "council"
    (root / "projects" / "blog-ideas").mkdir(parents=True)
    (root / "projects" / "portfolio.json").write_text(json.dumps({
        "version": 1,
        "projects": [{"id": "blog-ideas", "title": "Blog Ideas",
                      "status": "active", "priority": 1, "root": "projects/blog-ideas"}],
    }))
    (root / "project.json").write_text("{}")
    return BotferencePaths.resolve(project_root=root, project_dir=root, work_dir=root)


ENTRIES = [
    {"speaker": "system", "text": "Carried over from Discuss: “Do not conquer” (https://x.test/p)"},
    {"speaker": "system", "text": "The reader's margin comments on the page (1 thread):\n1. comment, open"},
    {"speaker": "user", "text": "but what was conquered?"},
    {"speaker": "claude", "text": "It's a metaphor."},
    {"speaker": "codex", "text": "Influence, mostly."},
]


def test_import_writes_a_listed_resumable_session(tmp_path):
    paths = _council(tmp_path)
    out = import_chat(paths, {"title": "Do not conquer", "entries": ENTRIES})
    assert out["ok"] is True
    sid = out["session_id"]
    assert Path(out["session_file"]).is_file()
    store = SessionStore(paths)
    payload = store.load(sid)
    assert payload["title"] == "Do not conquer"
    assert [e["speaker"] for e in payload["transcript"]] == [e["speaker"] for e in ENTRIES]
    assert [e["turn_index"] for e in payload["transcript"]] == list(range(len(ENTRIES)))
    # the shared metadata index — what the council's chat list reads — has it
    assert sid in store.metadata_index()
    assert out["project_id"] == ""


def test_import_files_into_a_named_project_and_refuses_an_unknown_one(tmp_path):
    paths = _council(tmp_path)
    out = import_chat(paths, {"title": "t", "project_id": "blog-ideas", "entries": ENTRIES})
    assert out["ok"] and out["project_id"] == "blog-ideas"
    index = json.loads((paths.project_root / "projects" / "session-index.json").read_text())
    assert {"session_id": out["session_id"], "project": "blog-ideas"} in index["sessions"]
    # a prefix is not a name: nothing gets filed into a project nobody named
    bad = import_chat(paths, {"title": "t", "project_id": "blog", "entries": ENTRIES})
    assert bad["ok"] is False and "no project" in bad["error"]


def test_import_refuses_an_empty_conversation(tmp_path):
    paths = _council(tmp_path)
    out = import_chat(paths, {"title": "t", "entries": [{"speaker": "user", "text": "   "}]})
    assert out["ok"] is False


def test_restored_chat_keeps_the_councils_prompt_and_backfills_both_bots(tmp_path):
    payload = build_payload("abc-123", "Do not conquer", "", ENTRIES)
    assert "system_prompt" not in payload
    c, _, _, _ = _make_botference(tmp_path=tmp_path)
    c._restore_from_payload(payload)
    # the resuming bridge's own prompt survives (the plugin's would have said
    # "your reply is a margin note")
    assert c.system_prompt == "Plan an app"
    assert c.custom_title == "Do not conquer"
    assert c._models_initialized == set()
    # on the reader's first message each bot is owed the whole conversation
    ctx = c.transcript.context_since("claude", "so, a blog post?")
    assert "but what was conquered?" in ctx
    assert "Influence, mostly." in ctx           # codex's turn, which claude never saw
    assert "Carried over from Discuss" in ctx
    assert "It's a metaphor." not in ctx          # claude's own words are not news to claude
    ctx_codex = c.transcript.context_since("codex", "so, a blog post?")
    assert "It's a metaphor." in ctx_codex


def test_cli_resolves_the_council_from_its_root(tmp_path):
    """The companion runs the script with every BOTFERENCE_* scrubbed but the
    root: the sessions must land where a council bridge in that root reads."""
    root = tmp_path / "council"
    (root / "projects").mkdir(parents=True)
    (root / "work").mkdir()
    (root / "project.json").write_text("{}")
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOTFERENCE_")}
    env["BOTFERENCE_PROJECT_ROOT"] = str(root)
    r = subprocess.run(
        [sys.executable, str(CORE / "session_import.py")],
        input=json.dumps({"title": "t", "entries": ENTRIES}),
        capture_output=True, text=True, env=env, check=False,
    )
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["ok"], r.stderr
    # a root holding project.json IS the state dir (core/paths.py): its
    # sessions/ is the store, exactly where the council web reads
    assert Path(out["session_file"]).parent.resolve() == (root / "sessions").resolve()


@pytest.mark.parametrize("bad", ["not json", "[1, 2]"])
def test_cli_rejects_bad_input(tmp_path, bad):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOTFERENCE_")}
    env["BOTFERENCE_PROJECT_ROOT"] = str(tmp_path)
    r = subprocess.run(
        [sys.executable, str(CORE / "session_import.py")],
        input=bad, capture_output=True, text=True, env=env, check=False,
    )
    assert r.returncode == 2
    assert json.loads(r.stdout)["ok"] is False
