#!/usr/bin/env python3
"""The lock on the council Claude's Google Docs write tool.

Claude Code runs this script before every call to the Docs write tool (a
"PreToolUse hook": a check Claude Code runs before a tool call, which can
stop it). The script reads the call from stdin as JSON and lets it through
only when it can do no more than comment or suggest:

- the whole batch is sent in suggest mode (`writeControl.writeMode` is
  "SUGGEST", so text changes land as suggestions the owner accepts or
  rejects) and every request in it is one of five kinds: `insertText`,
  `deleteContentRange` and `replaceAllText` (the three text changes), or
  `insertComment` and `addCommentReply` (a comment, or a reply to one); or
- the batch is not in suggest mode and every request in it is
  `insertComment` or `addCommentReply`.

Any other request kind is refused, even in suggest mode, because we do not
know whether Google turns it into a suggestion or just applies it. That
covers deleting or editing a comment, deleting a tab, changing the page
style, named ranges, and any kind this script has never heard of. Input
this script cannot read is refused too (fail closed). A refusal exits with code 2 and one plain line on stderr;
Claude Code shows that line to the bot as the reason. An allowed call exits
0 with no output, which leaves it to the normal permission rules.

The launch settings also set `onFailure: "block"`, so if this script cannot
start, crashes or times out, the call is refused too.

Stdlib only: it runs under whatever Python launched the council.
"""

from __future__ import annotations

import json
import sys
from enum import Enum

#: The two Google Docs tools the council's Claude may use. Nothing else from
#: Google: the other Google connectors are signed in as the user's personal
#: account.
GDOC_READ_TOOL = "mcp__claude_ai_Google_Docs__read_doc"
GDOC_WRITE_TOOL = "mcp__claude_ai_Google_Docs__update_doc"
GDOC_TOOLS = (GDOC_READ_TOOL, GDOC_WRITE_TOOL)

#: The other Google connectors, denied by server name (a rule naming a
#: server covers all its tools). They are signed in as the user's personal
#: account and load in the bot's session even though nothing allows them.
GDOC_DENIED_SERVERS = (
    "mcp__claude_ai_Google_Drive",
    "mcp__claude_ai_Gmail",
    "mcp__claude_ai_Google_Calendar",
    "mcp__claude_ai_Google_Sheets",
    "mcp__claude_ai_Google_Slides",
)

#: Requests that only add a comment or a reply. Resolving or deleting a
#: comment is deliberately not here.
COMMENT_REQUESTS = frozenset({"insertComment", "addCommentReply"})

#: Requests that change the text. Allowed only in suggest mode, where each
#: lands as a suggestion the owner accepts or rejects.
TEXT_CHANGE_REQUESTS = frozenset(
    {"insertText", "deleteContentRange", "replaceAllText"})

#: Every request kind the guard lets through in suggest mode. Anything else
#: is refused there, since we do not know if Google makes it a suggestion.
SUGGEST_MODE_REQUESTS = TEXT_CHANGE_REQUESTS | COMMENT_REQUESTS


class Verdict(Enum):
    """Every outcome of a check: two ways through, the rest refusals.

    The value is the one line the bot sees when its call is refused.
    """

    ALLOW_SUGGESTIONS = "allowed: the batch is sent as suggestions"
    ALLOW_COMMENTS = "allowed: the batch only adds comments or replies"
    REFUSE_UNREADABLE = (
        "Refused by the botference Google Docs lock: the call could not be "
        "read, so it is blocked. Send a documents.batchUpdate call with a "
        "'requests' list."
    )
    REFUSE_WRONG_TOOL = (
        "Refused by the botference Google Docs lock: this check only "
        "covers the Google Docs write tool."
    )
    REFUSE_NO_REQUESTS = (
        "Refused by the botference Google Docs lock: the call has no "
        "requests. Send at least one comment or suggestion."
    )
    REFUSE_DIRECT_EDIT = (
        "Refused by the botference Google Docs lock: you may not change the "
        "text directly. Send wording changes with writeControl.writeMode "
        "\"SUGGEST\" (they become suggestions), or send only insertComment / "
        "addCommentReply requests."
    )
    REFUSE_REQUEST_KIND = (
        "Refused by the botference Google Docs lock: in suggest mode you may "
        "send only insertText, deleteContentRange, replaceAllText, "
        "insertComment and addCommentReply requests."
    )

    @property
    def allowed(self) -> bool:
        return self in (Verdict.ALLOW_SUGGESTIONS, Verdict.ALLOW_COMMENTS)


def _request_kind(request: object) -> str | None:
    """The one request type in a batch entry, or None if malformed."""
    if not isinstance(request, dict) or len(request) != 1:
        return None
    (kind,) = request.keys()
    return kind if isinstance(kind, str) else None


def judge(payload: object) -> Verdict:
    """Return exactly one verdict for a PreToolUse hook payload."""
    if not isinstance(payload, dict):
        return Verdict.REFUSE_UNREADABLE
    if payload.get("tool_name") != GDOC_WRITE_TOOL:
        return Verdict.REFUSE_WRONG_TOOL
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return Verdict.REFUSE_UNREADABLE
    requests = tool_input.get("requests")
    if requests is None or requests == []:
        return Verdict.REFUSE_NO_REQUESTS
    if not isinstance(requests, list):
        return Verdict.REFUSE_UNREADABLE
    kinds = [_request_kind(r) for r in requests]
    if any(k is None for k in kinds):
        return Verdict.REFUSE_UNREADABLE
    write_control = tool_input.get("writeControl")
    if write_control is not None and not isinstance(write_control, dict):
        return Verdict.REFUSE_UNREADABLE
    if (write_control or {}).get("writeMode") == "SUGGEST":
        if all(k in SUGGEST_MODE_REQUESTS for k in kinds):
            return Verdict.ALLOW_SUGGESTIONS
        return Verdict.REFUSE_REQUEST_KIND
    if all(k in COMMENT_REQUESTS for k in kinds):
        return Verdict.ALLOW_COMMENTS
    return Verdict.REFUSE_DIRECT_EDIT


def judge_text(raw: str) -> Verdict:
    """Judge the raw stdin text; anything that is not JSON is refused."""
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        return Verdict.REFUSE_UNREADABLE
    return judge(payload)


def main() -> int:
    try:
        verdict = judge_text(sys.stdin.read())
    except Exception:  # fail closed on anything unexpected
        verdict = Verdict.REFUSE_UNREADABLE
    if verdict.allowed:
        return 0
    print(verdict.value, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
