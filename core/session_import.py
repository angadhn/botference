#!/usr/bin/env python3
"""
session_import.py — start a council chat that already has a conversation in it.

Why this exists
---------------
The browser plugin (Discuss) keeps its page chats in ITS OWN workspace: the
companion runs with the plugin workspace as its project root, so a page chat
is a session file under that workspace and is filed under "Plugin pages".
The council web UI runs against a DIFFERENT workspace (the reader's vault),
so a page chat never appears in the council's chat list at all.

"Continue in council" carries a page chat across that gap. It does NOT copy
the plugin's session file: that file's transcript is the plugin's wire
format (every user turn is a long envelope of page excerpts and length
rules), its system prompt is the margin-note one ("your reply IS the turn
text… short"), and its claude/codex native session ids belong to CLI
sessions started from another folder. Resuming any of that in the council
would give the bots the wrong role and point them at sessions they cannot
reach.

Instead the caller (frontends/plugin/council-handoff.mjs) hands this script a
CLEAN conversation — who said what, plus a note on where it came from — and
this script writes a brand-new council session that holds it:

  * transcript entries in the ordinary speakers (user / claude / codex /
    system), so on the reader's next message each bot is handed the whole
    carried-over conversation as its "room update" backfill
    (Transcript.context_since) — no bot runs until the reader writes;
  * room_history, the same entries, so the council web UI shows the chat when
    it is opened;
  * NO native model sessions and NO system prompt: the council bridge that
    resumes the chat brings its own, which is the whole point of moving it.

Writes go through SessionStore.save and ProjectStore.associate_session —
the same locked, atomic, index-publishing doors every council bridge uses —
so the council's shared .metadata-index.json and session-index.json pick the
chat up without any running council process being restarted.

Usage (JSON on stdin, JSON on stdout):

    BOTFERENCE_PROJECT_ROOT=<council root> python3 core/session_import.py < spec.json

    spec = {
      "title": "Do not conquer what you cannot defend",
      "project_id": "ai-futures",            # optional; "" = unfiled (Inbox)
      "entries": [ {"speaker": "system"|"user"|"claude"|"codex", "text": "…"} ]
    }

    → {"ok": true, "session_id": "…", "project_id": "…", "session_file": "…"}
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from paths import BotferencePaths  # noqa: E402
from project_store import ProjectStore  # noqa: E402
from session_store import SessionStore, iso_now  # noqa: E402

# The speakers a council transcript knows. Anything else is folded to
# "system" rather than refused: a carried-over note is still worth keeping.
SPEAKERS = ("user", "claude", "codex", "system")
TITLE_MAX = 80
# A page chat is a few dozen turns; this is a guard against a runaway caller,
# not a budget. The bots' backfill is bounded separately (context_since).
ENTRIES_MAX = 2000
TEXT_MAX = 200_000


def _clean_entries(raw: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if not isinstance(raw, list):
        return out
    for item in raw[:ENTRIES_MAX]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        speaker = str(item.get("speaker") or "system").strip().lower()
        if speaker not in SPEAKERS:
            speaker = "system"
        out.append({"speaker": speaker, "text": text[:TEXT_MAX]})
    return out


def build_payload(
    session_id: str, title: str, project_id: str, entries: list[dict[str, str]],
) -> dict[str, Any]:
    """A council session payload holding *entries* and nothing else.

    Only the keys the restore path needs to have a say are written; every
    other field falls back to the resuming bridge's own default, exactly as
    for a session saved before that field existed. In particular there is
    no "system_prompt" key (the council keeps its own), no model session ids
    and an empty models_initialized (both bots start fresh), and no
    last_seen (so both bots are owed the whole conversation as backfill).
    """
    now = iso_now()
    return {
        "version": 2,
        "session_id": session_id,
        "created_at": now,
        "updated_at": now,
        "custom_title": title,
        "auto_title": "",
        "title": title,
        "mode": "public",
        "project_id": project_id,
        "route": "@all",
        "room_history": [
            {"speaker": e["speaker"], "text": e["text"]} for e in entries
        ],
        "transcript": [
            {"speaker": e["speaker"], "text": e["text"],
             "turn_index": i, "tool_summaries": []}
            for i, e in enumerate(entries)
        ],
        "last_seen": {},
        "models_initialized": [],
    }


def import_chat(paths: BotferencePaths, spec: dict[str, Any]) -> dict[str, Any]:
    """Write one new council session from *spec*. Never touches an existing one."""
    title = " ".join(str(spec.get("title") or "").split())[:TITLE_MAX].strip()
    entries = _clean_entries(spec.get("entries"))
    if not entries:
        return {"ok": False, "error": "nothing to carry over — the chat is empty"}
    if not title:
        title = "From Discuss"

    project_id = str(spec.get("project_id") or "").strip()
    projects = ProjectStore(paths.project_root)
    if project_id:
        hit = projects.get(project_id)
        # an exact id only: a prefix match here would file the chat into a
        # project the caller never named
        if hit is None or hit.id != project_id:
            return {"ok": False, "error": f"no project '{project_id}' in that council"}

    sessions = SessionStore(paths)
    # Load the shared metadata index BEFORE saving: save() publishes its row
    # into the index only when the cache is live, and the index is what the
    # council's chat list reads.
    sessions.metadata_index()
    session_id = str(uuid.uuid4())
    payload = build_payload(session_id, title, project_id, entries)
    sessions.save(session_id, payload)
    if project_id:
        projects.associate_session(project_id, session_id)
    return {
        "ok": True,
        "session_id": session_id,
        "project_id": project_id,
        "title": title,
        "entries": len(entries),
        "session_file": str(paths.session_state_file(session_id)),
    }


def main(argv: list[str] | None = None) -> int:
    try:
        spec = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"bad JSON on stdin: {exc}"}))
        return 2
    if not isinstance(spec, dict):
        print(json.dumps({"ok": False, "error": "stdin must be a JSON object"}))
        return 2
    # BOTFERENCE_PROJECT_ROOT names the council; the caller scrubs every other
    # BOTFERENCE_* variable so the work dir resolves exactly as a council
    # bridge started in that root resolves it.
    paths = BotferencePaths.resolve()
    try:
        result = import_chat(paths, spec)
    except OSError as exc:
        result = {"ok": False, "error": f"could not write the chat: {exc}"}
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
