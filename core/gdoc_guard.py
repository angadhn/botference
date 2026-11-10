#!/usr/bin/env python3
"""The lock on every Google Docs write the council's bots make.

The Google Docs poster (core/gdoc_mcp.py) runs every write through
`seal()` before anything goes to Google. A write is the body of one
`documents.batchUpdate` call: a `requests` list (a batch: the changes, in
order) and a `writeControl` (how Google applies them). It gets through in
only two shapes:

- suggest mode: `writeControl.writeMode` is "SUGGEST" (so text changes land
  as suggestions the owner accepts or rejects) and every request is one of
  `insertText`, `deleteContentRange`, `replaceAllText` (the three text
  changes), `insertComment` or `addCommentReply` (a comment, or a reply to
  one); or
- comment only: not in suggest mode, and every request is `insertComment`
  or `addCommentReply`.

And always:

- `writeControl.requiredRevisionId` is set (the revision id from the bot's
  last read; Google refuses the write if the Doc changed since), and
- a comment carries only its text and the stretch of text it is on, and a
  reply only the thread it answers and its text. That keeps out a reply
  that resolves or reopens a thread (`post.commentAction`) and a comment
  that assigns someone (which emails them).

Any other request kind is refused, even in suggest mode, because we do not
know whether Google turns it into a suggestion or just applies it: deleting
or editing a comment, accepting or rejecting a suggestion, deleting a tab,
page style, named ranges, and any kind this module has never heard of.
Input it cannot read is refused too (fail closed).

`seal()` then puts the bot's name in front of every comment and reply
("Claude: " / "Codex: "), unless the text already starts with it.

Stdlib only.
"""

from __future__ import annotations

from enum import Enum

#: The bots that may post, and the name each one's comments start with.
BOT_NAMES = {"claude": "Claude", "codex": "Codex"}

#: Requests that only add a comment or a reply. Resolving or deleting a
#: comment is deliberately not here.
COMMENT_REQUESTS = frozenset({"insertComment", "addCommentReply"})

#: Requests that change the text. Allowed only in suggest mode, where each
#: lands as a suggestion the owner accepts or rejects.
TEXT_CHANGE_REQUESTS = frozenset(
    {"insertText", "deleteContentRange", "replaceAllText"})

#: Every request kind the lock lets through in suggest mode.
SUGGEST_MODE_REQUESTS = TEXT_CHANGE_REQUESTS | COMMENT_REQUESTS

#: The only fields a write body, its writeControl, a comment, a reply and a
#: reply's post may carry. Anything else is refused: an unknown field may do
#: something we have not checked.
_BODY_FIELDS = frozenset({"requests", "writeControl"})
_WRITE_CONTROL_FIELDS = frozenset({"writeMode", "requiredRevisionId"})
_COMMENT_FIELDS = frozenset({"content", "range"})
_REPLY_THREAD_FIELDS = frozenset({"commentId", "suggestionId"})
_REPLY_FIELDS = _REPLY_THREAD_FIELDS | {"post"}
_POST_FIELDS = frozenset({"content"})

_REFUSED = "Refused by the botference Google Docs lock: "


class Verdict(Enum):
    """Every outcome of a check: two ways through, the rest refusals.

    The value is the one line the bot sees when its write is refused.
    """

    ALLOW_SUGGESTIONS = "allowed: the batch is sent as suggestions"
    ALLOW_COMMENTS = "allowed: the batch only adds comments or replies"
    REFUSE_UNREADABLE = (
        _REFUSED + "the write could not be read, so it is blocked. Send a "
        "'requests' list and a 'writeControl' with nothing else in them."
    )
    REFUSE_NO_REQUESTS = (
        _REFUSED + "the write has no requests. Send at least one comment or "
        "suggestion."
    )
    REFUSE_NO_REVISION = (
        _REFUSED + "the write has no writeControl.requiredRevisionId. Read "
        "the Doc again and send the revision id from that read, so Google "
        "refuses the write if the Doc changed since."
    )
    REFUSE_COMMENT_SHAPE = (
        _REFUSED + "a comment may carry only 'content' and 'range'; a reply "
        "only 'commentId' or 'suggestionId' and 'post': {'content': ...}, "
        "with non-empty text. Resolving, reopening and assigning are not "
        "allowed."
    )
    REFUSE_DIRECT_EDIT = (
        _REFUSED + "you may not change the text directly. Send wording "
        "changes with writeControl.writeMode \"SUGGEST\" (they become "
        "suggestions), or send only insertComment / addCommentReply requests."
    )
    REFUSE_REQUEST_KIND = (
        _REFUSED + "in suggest mode you may send only insertText, "
        "deleteContentRange, replaceAllText, insertComment and "
        "addCommentReply requests."
    )

    @property
    def allowed(self) -> bool:
        return self in (Verdict.ALLOW_SUGGESTIONS, Verdict.ALLOW_COMMENTS)


def _request_kind(request: object) -> str | None:
    """The one request type in a batch entry, or None if malformed."""
    if not isinstance(request, dict) or len(request) != 1:
        return None
    (kind,) = request.keys()
    if not isinstance(kind, str) or not isinstance(request[kind], dict):
        return None
    return kind


def _text(value: object) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _comment_shape_ok(kind: str, body: dict) -> bool:
    """A comment or reply carries only its text and where it goes."""
    if kind == "insertComment":
        return set(body) <= _COMMENT_FIELDS and _text(body.get("content"))
    threads = [f for f in body if f in _REPLY_THREAD_FIELDS]
    post = body.get("post")
    return (set(body) <= _REPLY_FIELDS
            and len(threads) == 1 and _text(body[threads[0]])
            and isinstance(post, dict) and set(post) <= _POST_FIELDS
            and _text(post.get("content")))


def judge(body: object) -> Verdict:
    """Return exactly one verdict for a documents.batchUpdate body."""
    if not isinstance(body, dict) or not set(body) <= _BODY_FIELDS:
        return Verdict.REFUSE_UNREADABLE
    requests = body.get("requests")
    if requests is None or requests == []:
        return Verdict.REFUSE_NO_REQUESTS
    if not isinstance(requests, list):
        return Verdict.REFUSE_UNREADABLE
    kinds = [_request_kind(r) for r in requests]
    if any(k is None for k in kinds):
        return Verdict.REFUSE_UNREADABLE
    write_control = body.get("writeControl")
    if write_control is None:
        write_control = {}
    if (not isinstance(write_control, dict)
            or not set(write_control) <= _WRITE_CONTROL_FIELDS):
        return Verdict.REFUSE_UNREADABLE
    for kind, request in zip(kinds, requests):
        if kind in COMMENT_REQUESTS and not _comment_shape_ok(kind, request[kind]):
            return Verdict.REFUSE_COMMENT_SHAPE
    if not _text(write_control.get("requiredRevisionId")):
        return Verdict.REFUSE_NO_REVISION
    if write_control.get("writeMode") == "SUGGEST":
        if all(k in SUGGEST_MODE_REQUESTS for k in kinds):
            return Verdict.ALLOW_SUGGESTIONS
        return Verdict.REFUSE_REQUEST_KIND
    if all(k in COMMENT_REQUESTS for k in kinds):
        return Verdict.ALLOW_COMMENTS
    return Verdict.REFUSE_DIRECT_EDIT


def _named(text: str, name: str) -> str:
    prefix = f"{name}:"
    return text if text.startswith(prefix) else f"{prefix} {text}"


def stamp(body: dict, bot: str) -> dict:
    """A copy of an allowed body with the bot's name on every comment/reply."""
    name = BOT_NAMES[bot]
    requests = []
    for request in body["requests"]:
        ((kind, fields),) = request.items()
        if kind == "insertComment":
            fields = {**fields, "content": _named(fields["content"], name)}
        elif kind == "addCommentReply":
            post = {**fields["post"],
                    "content": _named(fields["post"]["content"], name)}
            fields = {**fields, "post": post}
        requests.append({kind: fields})
    return {"requests": requests, "writeControl": dict(body["writeControl"])}


def seal(body: object, bot: str) -> tuple[Verdict, dict | None]:
    """Judge a write; if allowed, return it with the bot's name stamped on.

    The poster sends only the returned body, never the one the bot gave.
    """
    if bot not in BOT_NAMES:
        raise ValueError(f"unknown bot {bot!r}")
    verdict = judge(body)
    if not verdict.allowed:
        return verdict, None
    return verdict, stamp(body, bot)  # type: ignore[arg-type]
