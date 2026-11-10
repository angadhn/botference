"""Google Docs review: the poster, its lock, sign-in, launch settings, rule text.

No network, no real sign-in key or token: Google is a fake transport, and
the sign-in folder is a temporary one.
"""

from __future__ import annotations

import base64
import json
import os
import stat
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

try:
    import tomllib
except ImportError:  # Python < 3.11: tomli is the same parser under its old name
    import tomli as tomllib

import pytest

CORE = Path(__file__).resolve().parent.parent / "core"
sys.path.insert(0, str(CORE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import gdoc_client  # noqa: E402
import summon  # noqa: E402
from cli_adapters import (  # noqa: E402
    ClaudeAdapter,
    CodexAdapter,
    claude_plan_settings_for_work_dir,
)
from gdoc_client import DocsClient, GdocError, Problem  # noqa: E402
from gdoc_guard import Verdict, judge, seal  # noqa: E402
from gdoc_mcp import (  # noqa: E402
    CLAUDE_DENIED_GOOGLE_SERVERS,
    CLAUDE_TOOL_RULES,
    READ_TOOL,
    SERVER_NAME,
    WRITE_TOOL,
    Poster,
    claude_sign_in_deny_rules,
    codex_config_overrides,
    handle,
)
from room_prompts import GDOC_REVIEW_BOTS, google_doc_review_note  # noqa: E402

DOC_ID = "D" * 30
LINK = f"https://docs.google.com/document/d/{DOC_ID}/edit"
REV = "rev-1"
ACCOUNT = "agent@example.com"

INSERT = {"insertText": {"text": "x", "location": {"index": 1}}}
DELETE = {"deleteContentRange": {"range": {"startIndex": 1, "endIndex": 4}}}
REPLACE = {"replaceAllText": {"replaceText": "b", "containsText": {"text": "a"}}}
COMMENT = {"insertComment": {"content": "why?",
                             "range": {"startIndex": 1, "endIndex": 4}}}
REPLY = {"addCommentReply": {"commentId": "c1", "post": {"content": "agreed"}}}
SUGGEST = {"writeMode": "SUGGEST", "requiredRevisionId": REV}
PLAIN = {"requiredRevisionId": REV}


def _body(requests, write_control=SUGGEST):
    body = {"requests": requests}
    if write_control is not None:
        body["writeControl"] = write_control
    return body


# -- fakes --------------------------------------------------------------------

class FakeGoogle:
    """Stands in for Google: records calls, answers from a script."""

    def __init__(self, answers=None):
        self.calls = []
        self.answers = answers or {}

    def __call__(self, method, url, headers, data):
        self.calls.append((method, url, headers, data))
        for prefix, answer in self.answers.items():
            if url.startswith(prefix):
                if isinstance(answer, Exception):
                    raise answer
                status, body = answer
                return status, json.dumps(body).encode()
        raise AssertionError(f"unexpected call {method} {url}")


def _home(tmp_path, key=True, token=True, expires_at=10**12):
    home = tmp_path / "google"
    home.mkdir(mode=0o700)
    if key:
        (home / "client.json").write_text(json.dumps(
            {"installed": {"client_id": "test-client", "client_secret": "s"}}))
    if token:
        (home / "token.json").write_text(json.dumps({
            "account": ACCOUNT, "refresh_token": "r", "access_token": "a",
            "expires_at": expires_at}))
    return home


def _client(tmp_path, answers=None, **home_kw):
    google = FakeGoogle(answers)
    return DocsClient(home=_home(tmp_path, **home_kw), transport=google,
                      clock=lambda: 1000.0), google


WRITE_OK = {"documentId": DOC_ID, "writeControl": {"requiredRevisionId": "rev-2"},
            "replies": [{}], "suggestionResponses": [
                {"createdSuggestionIds": ["s9"]}]}


# -- the lock, through the poster ----------------------------------------------

class TestLock:
    @pytest.mark.parametrize("request_", [INSERT, DELETE, REPLACE, COMMENT, REPLY])
    def test_suggest_mode_allows_each_listed_kind(self, request_):
        assert judge(_body([request_])) is Verdict.ALLOW_SUGGESTIONS

    def test_suggest_allows_text_and_comment_mixed(self):
        assert judge(_body([INSERT, COMMENT])) is Verdict.ALLOW_SUGGESTIONS

    def test_comment_only_allowed_without_suggest_mode(self):
        assert judge(_body([COMMENT, REPLY], PLAIN)) is Verdict.ALLOW_COMMENTS

    @pytest.mark.parametrize("kind", [
        "deleteComment", "updateCommentPost", "deleteCommentReply",
        "acceptSuggestion", "rejectSuggestion", "deleteSuggestion",
        "deleteTab", "updateTextStyle", "madeUpRequest",
    ])
    def test_suggest_refuses_other_kinds(self, kind):
        assert judge(_body([INSERT, {kind: {}}])) is Verdict.REFUSE_REQUEST_KIND

    @pytest.mark.parametrize("write_control", [
        PLAIN, {"writeMode": "EDIT", "requiredRevisionId": REV},
        {"writeMode": "WRITE_MODE_UNSPECIFIED", "requiredRevisionId": REV}])
    def test_text_change_outside_suggest_mode_refused(self, write_control):
        assert judge(_body([INSERT], write_control)) is Verdict.REFUSE_DIRECT_EDIT
        assert judge(_body([COMMENT, INSERT], write_control)) is Verdict.REFUSE_DIRECT_EDIT

    @pytest.mark.parametrize("write_control", [
        None, {}, {"writeMode": "SUGGEST"},
        {"writeMode": "SUGGEST", "requiredRevisionId": ""},
        {"writeMode": "SUGGEST", "requiredRevisionId": 7}])
    def test_write_without_revision_id_refused(self, write_control):
        assert judge(_body([INSERT], write_control)) is Verdict.REFUSE_NO_REVISION
        assert judge(_body([COMMENT], write_control)) is Verdict.REFUSE_NO_REVISION

    @pytest.mark.parametrize("request_", [
        # a reply that resolves or reopens the thread
        {"addCommentReply": {"commentId": "c1", "post": {
            "content": "done", "commentAction": "RESOLVE"}}},
        {"addCommentReply": {"commentId": "c1", "post": {
            "content": "", "commentAction": "REOPEN"}}},
        # assigning someone (Google emails them)
        {"insertComment": {"content": "x", "range": {"startIndex": 1, "endIndex": 2},
                           "assigneeEmailAddress": "someone@example.com"}},
        {"addCommentReply": {"commentId": "c1", "post": {
            "content": "x", "assigneeEmail": "someone@example.com"}}},
        # empty text, no thread, two threads, text in the wrong place
        {"insertComment": {"content": "  ", "range": {}}},
        {"addCommentReply": {"post": {"content": "x"}}},
        {"addCommentReply": {"commentId": "c1", "suggestionId": "s1",
                             "post": {"content": "x"}}},
        {"addCommentReply": {"commentId": "c1", "content": "x"}},
    ])
    def test_comment_shape_refused(self, request_):
        assert judge(_body([request_])) is Verdict.REFUSE_COMMENT_SHAPE
        assert judge(_body([request_], PLAIN)) is Verdict.REFUSE_COMMENT_SHAPE

    @pytest.mark.parametrize("write_control", [None, SUGGEST])
    def test_empty_refused(self, write_control):
        assert judge({}) is Verdict.REFUSE_NO_REQUESTS
        assert judge(_body([], write_control)) is Verdict.REFUSE_NO_REQUESTS

    @pytest.mark.parametrize("body", [
        None, "text", [], {"requests": "insertText"},
        {"requests": [INSERT], "writeControl": "SUGGEST"},
        {"requests": [{"insertComment": {}, **INSERT}], "writeControl": SUGGEST},
        {"requests": ["insertComment"], "writeControl": SUGGEST},
        {"requests": [{"insertText": "x"}], "writeControl": SUGGEST},
        {"requests": [INSERT], "writeControl": {**SUGGEST, "targetRevisionId": "r"}},
        {"requests": [INSERT], "writeControl": SUGGEST, "extra": 1},
    ])
    def test_unreadable_refused(self, body):
        assert judge(body) is Verdict.REFUSE_UNREADABLE

    def test_only_two_verdicts_let_a_write_through(self):
        assert {v for v in Verdict if v.allowed} == {
            Verdict.ALLOW_SUGGESTIONS, Verdict.ALLOW_COMMENTS}

    def test_refusals_are_one_plain_line(self):
        for v in Verdict:
            if not v.allowed:
                assert v.value.startswith("Refused by the botference Google Docs lock")
                assert "\n" not in v.value


class TestPoster:
    def _poster(self, tmp_path, bot="claude"):
        client, google = _client(tmp_path, {gdoc_client.API: (200, WRITE_OK)})
        return Poster(bot, client), google

    def _sent(self, google):
        (method, url, headers, data), = google.calls
        assert method == "POST" and url == f"{gdoc_client.API}{DOC_ID}:batchUpdate"
        assert headers["Authorization"] == "Bearer a"
        return json.loads(data)

    def test_allowed_write_goes_to_google(self, tmp_path):
        poster, google = self._poster(tmp_path)
        text, is_error = poster.call(WRITE_TOOL, {"document": LINK, **_body([INSERT])})
        assert not is_error and text.startswith("posted.")
        assert "s9" in text and "rev-2" in text
        assert self._sent(google) == _body([INSERT])

    @pytest.mark.parametrize("body, verdict", [
        (_body([INSERT], PLAIN), Verdict.REFUSE_DIRECT_EDIT),
        (_body([INSERT], {"writeMode": "SUGGEST"}), Verdict.REFUSE_NO_REVISION),
        (_body([{"deleteComment": {"commentId": "c1"}}]), Verdict.REFUSE_REQUEST_KIND),
        (_body([{"addCommentReply": {"commentId": "c1", "post": {
            "content": "x", "commentAction": "RESOLVE"}}}]), Verdict.REFUSE_COMMENT_SHAPE),
        (_body([]), Verdict.REFUSE_NO_REQUESTS),
        ({**_body([COMMENT]), "documentId": "other"}, Verdict.REFUSE_UNREADABLE),
    ])
    def test_refused_write_never_reaches_google(self, tmp_path, body, verdict):
        poster, google = self._poster(tmp_path)
        text, is_error = poster.call(WRITE_TOOL, {"document": LINK, **body})
        assert is_error and text == verdict.value
        assert google.calls == []

    def test_name_put_in_front_of_comments_and_replies(self, tmp_path):
        poster, google = self._poster(tmp_path)
        poster.call(WRITE_TOOL, {"document": LINK, **_body([COMMENT, REPLY, INSERT])})
        sent = self._sent(google)["requests"]
        assert sent[0]["insertComment"]["content"] == "Claude: why?"
        assert sent[0]["insertComment"]["range"] == COMMENT["insertComment"]["range"]
        assert sent[1]["addCommentReply"]["post"]["content"] == "Claude: agreed"
        assert sent[1]["addCommentReply"]["commentId"] == "c1"
        assert sent[2] == INSERT

    def test_codex_gets_its_own_name(self, tmp_path):
        poster, google = self._poster(tmp_path, bot="codex")
        poster.call(WRITE_TOOL, {"document": LINK, **_body([COMMENT], PLAIN)})
        assert self._sent(google)["requests"][0]["insertComment"]["content"] == "Codex: why?"

    @pytest.mark.parametrize("bot, given, sent", [
        ("claude", "Claude: already named", "Claude: already named"),
        ("claude", "Claude:tight", "Claude:tight"),
        ("claude", "Codex: pretending", "Claude: Codex: pretending"),
        ("codex", "Codex: fine", "Codex: fine"),
    ])
    def test_name_not_doubled_and_not_forged(self, bot, given, sent):
        body = _body([{"insertComment": {"content": given, "range": {}}}], PLAIN)
        verdict, sealed = seal(body, bot)
        assert verdict is Verdict.ALLOW_COMMENTS
        assert sealed["requests"][0]["insertComment"]["content"] == sent
        assert body["requests"][0]["insertComment"]["content"] == given  # not mutated

    def test_bot_is_fixed_at_launch(self):
        with pytest.raises(ValueError):
            Poster("gemini")
        with pytest.raises(ValueError):
            seal(_body([COMMENT]), "gemini")

    def test_read_returns_the_compact_text(self, tmp_path):
        client, google = _client(tmp_path, {gdoc_client.API: (200, _DOC)})
        text, is_error = Poster("codex", client).call(READ_TOOL, {"document": LINK})
        assert not is_error and "revision id: rev-7" in text
        ((method, url, _, _),) = google.calls
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        assert method == "GET" and url.startswith(gdoc_client.API + DOC_ID + "?")
        assert query["includeTabsContent"] == ["true"]
        assert query["commentsViewMode"] == ["COMMENTS_VIEW_MODE_INCLUDED"]
        assert query["suggestionsViewMode"] == ["SUGGESTIONS_INLINE"]

    def test_missing_document_is_one_line(self, tmp_path):
        poster, google = self._poster(tmp_path)
        text, is_error = poster.call(READ_TOOL, {})
        assert is_error and "\n" not in text and google.calls == []


# -- MCP over stdio ---------------------------------------------------------------

class TestProtocol:
    def test_lists_exactly_the_five_tools(self, tmp_path):
        poster = Poster("claude", DocsClient(home=tmp_path))
        init = handle(poster, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                               "params": {"protocolVersion": "2025-06-18"}})
        assert init["result"]["protocolVersion"] == "2025-06-18"
        assert handle(poster, {"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
        tools = handle(poster, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert [t["name"] for t in tools["result"]["tools"]] == [
            READ_TOOL, WRITE_TOOL, "search_mail", "read_mail", "read_attachment"]

    def test_unknown_tool_and_method(self, tmp_path):
        poster = Poster("claude", DocsClient(home=tmp_path))
        bad = handle(poster, {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                              "params": {"name": "delete_doc", "arguments": {}}})
        assert bad["error"]["code"] == -32602
        assert handle(poster, {"jsonrpc": "2.0", "id": 4, "method": "x"})["error"]["code"] == -32601

    def test_real_process_answers_with_the_no_key_line(self, tmp_path):
        msgs = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
             "params": {"name": READ_TOOL, "arguments": {"document": LINK}}},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": WRITE_TOOL, "arguments": {
                 "document": LINK, "requests": [INSERT]}}},
        ]
        env = {**os.environ, gdoc_client.HOME_ENV: str(tmp_path / "none")}
        p = subprocess.run(
            [sys.executable, "-I", str(CORE / "gdoc_mcp.py"), "--bot", "codex"],
            input="".join(json.dumps(m) + "\n" for m in msgs),
            capture_output=True, text=True, env=env, timeout=30)
        replies = [json.loads(line) for line in p.stdout.splitlines()]
        assert [r["id"] for r in replies] == [1, 2, 3]
        read, write = replies[1]["result"], replies[2]["result"]
        assert read["isError"] and read["content"][0]["text"].startswith(
            "Google Docs: botference has no Google sign-in key")
        assert write["isError"] and write["content"][0]["text"] == Verdict.REFUSE_NO_REVISION.value

    def test_refuses_to_start_for_an_unknown_bot(self):
        p = subprocess.run([sys.executable, "-I", str(CORE / "gdoc_mcp.py"), "--bot", "x"],
                           input="", capture_output=True, text=True, timeout=30)
        assert p.returncode == 2


# -- plain error lines ---------------------------------------------------------------

class TestErrorLines:
    def _read_error(self, client):
        with pytest.raises(GdocError) as e:
            client.read(LINK)
        assert "\n" not in e.value.line
        return e.value

    def test_no_key(self, tmp_path):
        client, google = _client(tmp_path, key=False)
        err = self._read_error(client)
        assert err.problem is Problem.NO_KEY and "client.json" in err.line
        assert "gdoc_client.py login --account" in err.line and google.calls == []

    def test_bad_key(self, tmp_path):
        client, _ = _client(tmp_path)
        (client.home / "client.json").write_text(json.dumps({"web": {"client_id": "x"}}))
        assert self._read_error(client).problem is Problem.BAD_KEY
        (client.home / "client.json").write_text("{not json")
        assert self._read_error(client).problem is Problem.BAD_KEY

    def test_no_sign_in(self, tmp_path):
        client, google = _client(tmp_path, token=False)
        err = self._read_error(client)
        assert err.problem is Problem.NO_SIGN_IN and "login --account" in err.line
        assert google.calls == []

    def test_unreadable_sign_in(self, tmp_path):
        client, _ = _client(tmp_path)
        (client.home / "token.json").write_text("garbage")
        assert self._read_error(client).problem is Problem.BAD_SIGN_IN

    def test_expired_sign_in_on_refresh(self, tmp_path):
        client, _ = _client(tmp_path, {gdoc_client.TOKEN_URL: (
            400, {"error": "invalid_grant"})}, expires_at=0)
        err = self._read_error(client)
        assert err.problem is Problem.SIGN_IN_EXPIRED and "login --account" in err.line

    def test_revoked_sign_in_on_call(self, tmp_path):
        client, _ = _client(tmp_path, {gdoc_client.API: (401, {"error": {"message": "x"}})})
        assert self._read_error(client).problem is Problem.SIGN_IN_EXPIRED

    def test_key_refused(self, tmp_path):
        client, _ = _client(tmp_path, {gdoc_client.TOKEN_URL: (
            401, {"error": "invalid_client"})}, expires_at=0)
        assert self._read_error(client).problem is Problem.KEY_REFUSED

    def test_no_network(self, tmp_path):
        client, _ = _client(tmp_path, {gdoc_client.API: OSError("no route")})
        err = self._read_error(client)
        assert err.problem is Problem.NETWORK and "no route" in err.line

    @pytest.mark.parametrize("status, hint", [
        (403, "share the Doc with the agent account"),
        (404, "No such Doc"),
        (400, "read it again"),
        (500, "try again"),
    ])
    def test_google_refusal_says_why_and_what_to_do(self, tmp_path, status, hint):
        client, _ = _client(tmp_path, {gdoc_client.API: (
            status, {"error": {"message": "Google's\nown words"}})})
        err = self._read_error(client)
        assert err.problem is Problem.GOOGLE_REFUSED
        assert f"{status}: Google's own words" in err.line and hint in err.line

    def test_comments_not_saved_is_reported(self, tmp_path):
        client, _ = _client(tmp_path, {gdoc_client.API: (
            200, {"commentUpdateState": "ALL_FAILED_UNKNOWN_REASON"})})
        text, is_error = Poster("claude", client).call(
            WRITE_TOOL, {"document": LINK, **_body([COMMENT], PLAIN)})
        assert is_error and text.startswith("Google Docs: Google took the write")

    def test_not_a_doc_link(self, tmp_path):
        client, google = _client(tmp_path)
        for bad in ("https://example.com/x", "../../etc", "short"):
            with pytest.raises(GdocError) as e:
                client.read(bad)
            assert e.value.problem is Problem.BAD_DOCUMENT
        assert google.calls == []

    def test_doc_id_from_link(self):
        assert gdoc_client.document_id(LINK) == DOC_ID
        assert gdoc_client.document_id(f"https://docs.google.com/document/u/1/d/{DOC_ID}/") == DOC_ID
        assert gdoc_client.document_id(DOC_ID) == DOC_ID

    def test_refresh_saves_the_new_sign_in_privately(self, tmp_path):
        client, google = _client(tmp_path, {
            gdoc_client.TOKEN_URL: (200, {"access_token": "new", "expires_in": 3600}),
            gdoc_client.API: (200, _DOC)}, expires_at=0)
        client.read(LINK)
        saved = json.loads((client.home / "token.json").read_text())
        assert saved["access_token"] == "new" and saved["refresh_token"] == "r"
        assert saved["account"] == ACCOUNT
        assert stat.S_IMODE((client.home / "token.json").stat().st_mode) == 0o600
        assert google.calls[-1][2]["Authorization"] == "Bearer new"


# -- sign-in ----------------------------------------------------------------------------

def _id_token(email, verified=True):
    claims = base64.urlsafe_b64encode(json.dumps(
        {"email": email, "email_verified": verified}).encode()).decode().rstrip("=")
    return f"h.{claims}.sig"


def _token_reply(email, verified=True, scope=gdoc_client.DOCS_SCOPE + " openid email"):
    return {"access_token": "a", "refresh_token": "r", "expires_in": 3600,
            "scope": scope, "id_token": _id_token(email, verified)}


class TestSignIn:
    def test_right_account_accepted(self):
        saved = gdoc_client.accept_sign_in(_token_reply("Agent@Example.com"), ACCOUNT, 0)
        assert saved["account"] == ACCOUNT and saved["refresh_token"] == "r"

    @pytest.mark.parametrize("reply, problem", [
        (_token_reply("someone.else@example.com"), Problem.WRONG_ACCOUNT),
        (_token_reply(ACCOUNT, verified=False), Problem.NO_ACCOUNT_SAID),
        ({**_token_reply(ACCOUNT), "id_token": "junk"}, Problem.NO_ACCOUNT_SAID),
        (_token_reply(ACCOUNT, scope="openid email"), Problem.INCOMPLETE_SIGN_IN),
        ({**_token_reply(ACCOUNT), "refresh_token": ""}, Problem.INCOMPLETE_SIGN_IN),
    ])
    def test_refused(self, reply, problem):
        with pytest.raises(GdocError) as e:
            gdoc_client.accept_sign_in(reply, ACCOUNT, 0)
        assert e.value.problem is problem and "\n" not in e.value.line

    def _browser(self, code="the-code", state=None, error=None):
        """A fake browser: Google sends it straight back to the loopback port."""
        seen = {}

        def open_browser(url):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
            seen.update(q)
            back = {"state": state or q["state"]}
            back.update({"error": error} if error else {"code": code})
            target = q["redirect_uri"] + "/?" + urllib.parse.urlencode(back)
            threading.Thread(target=lambda: urllib.request.urlopen(target, timeout=10).read(),
                             daemon=True).start()
            return True
        return open_browser, seen

    def test_login_saves_only_for_the_named_account(self, tmp_path):
        home = _home(tmp_path, token=False)
        google = FakeGoogle({gdoc_client.TOKEN_URL: (200, _token_reply(ACCOUNT))})
        browser, seen = self._browser()
        assert gdoc_client.login(ACCOUNT, home=home, transport=google,
                                 open_browser=browser, timeout=10) == ACCOUNT
        assert seen["login_hint"] == ACCOUNT and seen["code_challenge_method"] == "S256"
        assert set(seen["scope"].split()) == {
            "openid", "email", gdoc_client.DOCS_SCOPE, gdoc_client.GMAIL_SCOPE}
        form = dict(urllib.parse.parse_qsl(google.calls[0][3].decode()))
        assert form["code"] == "the-code" and form["code_verifier"]
        saved = json.loads((home / "token.json").read_text())
        assert saved["account"] == ACCOUNT
        assert stat.S_IMODE((home / "token.json").stat().st_mode) == 0o600
        assert stat.S_IMODE(home.stat().st_mode) == 0o700

    def test_login_wrong_account_saves_nothing(self, tmp_path):
        home = _home(tmp_path, token=False)
        google = FakeGoogle({gdoc_client.TOKEN_URL: (
            200, _token_reply("personal@example.com"))})
        browser, _ = self._browser()
        with pytest.raises(GdocError) as e:
            gdoc_client.login(ACCOUNT, home=home, transport=google,
                              open_browser=browser, timeout=10)
        assert e.value.problem is Problem.WRONG_ACCOUNT
        assert not (home / "token.json").exists()

    @pytest.mark.parametrize("browser_kw, problem", [
        ({"state": "forged"}, Problem.LOGIN_MISMATCH),
        ({"error": "access_denied"}, Problem.LOGIN_DECLINED),
    ])
    def test_login_bad_redirect_saves_nothing(self, tmp_path, browser_kw, problem):
        home = _home(tmp_path, token=False)
        google = FakeGoogle()
        browser, _ = self._browser(**browser_kw)
        with pytest.raises(GdocError) as e:
            gdoc_client.login(ACCOUNT, home=home, transport=google,
                              open_browser=browser, timeout=10)
        assert e.value.problem is problem
        assert google.calls == [] and not (home / "token.json").exists()

    def test_login_needs_the_key_and_an_email(self, tmp_path):
        with pytest.raises(GdocError) as e:
            gdoc_client.login(ACCOUNT, home=tmp_path / "empty", transport=FakeGoogle(),
                              open_browser=lambda u: True)
        assert e.value.problem is Problem.NO_KEY
        with pytest.raises(GdocError) as e:
            gdoc_client.login("not-an-email", home=_home(tmp_path), transport=FakeGoogle(),
                              open_browser=lambda u: True)
        assert e.value.problem is Problem.BAD_ACCOUNT

    def test_login_times_out(self, tmp_path):
        with pytest.raises(GdocError) as e:
            gdoc_client.login(ACCOUNT, home=_home(tmp_path, token=False),
                              transport=FakeGoogle(), open_browser=lambda u: True,
                              timeout=0.2)
        assert e.value.problem is Problem.LOGIN_TIMEOUT


# -- the compact read ------------------------------------------------------------------------

_DOC = {
    "title": "Draft", "revisionId": "rev-7",
    "tabs": [{
        "tabProperties": {"tabId": "t.0", "title": "Main"},
        "documentTab": {
            "body": {"content": [
                {"startIndex": 0, "endIndex": 1, "sectionBreak": {}},
                {"startIndex": 1, "endIndex": 13, "paragraph": {"elements": [
                    {"startIndex": 1, "endIndex": 7, "textRun": {"content": "Hello "}},
                    {"startIndex": 7, "endIndex": 13, "textRun": {
                        "content": "world\n", "suggestedInsertionIds": ["s1"]}}]}},
                {"startIndex": 13, "endIndex": 20, "table": {"tableRows": [{"tableCells": [
                    {"content": [{"startIndex": 14, "endIndex": 19, "paragraph": {
                        "elements": [{"startIndex": 14, "endIndex": 19,
                                      "textRun": {"content": "cell\n"}}]}}]}]}]}},
            ]},
            "commentAnchors": {"a1": {"anchorId": "a1", "ranges": [
                {"startIndex": 1, "endIndex": 6, "tabId": "t.0"}]}},
        },
        "childTabs": [{"tabProperties": {"tabId": "t.1", "title": "Notes"},
                       "documentTab": {"body": {"content": [
                           {"startIndex": 1, "endIndex": 6, "paragraph": {"elements": [
                               {"startIndex": 1, "endIndex": 6,
                                "textRun": {"content": "note\n"}}]}}]}}}],
    }],
    "suggestions": [{"suggestionId": "s1", "status": "OPEN", "summaryText": "add world",
                     "headPost": {"author": {"displayName": "Owner"}}}],
    "comments": [{"commentId": "c1", "anchorId": "a1", "status": "OPEN",
                  "plainTextQuote": "Hello",
                  "headPost": {"author": {"displayName": "Owner"}, "content": "Too short?"},
                  "replies": [{"author": {"displayName": "Agent"}, "content": "Claude: yes"}]}],
}


class TestSummary:
    def test_compact_text_has_what_the_bot_needs(self):
        text = gdoc_client.summarise(_DOC)
        assert "title: Draft" in text and "revision id: rev-7" in text
        assert "== tab t.0: Main" in text and "== tab t.1: Notes" in text
        assert "[1-13) Hello {+world+}[s1]" in text
        assert "[14-19) cell" in text
        assert "- s1 by Owner: add world" in text and "insert at t.0 7-13" in text
        assert "- c1 [OPEN] on t.0 1-6 quoting 'Hello'" in text
        assert "Owner: Too short?" in text and "reply Agent: Claude: yes" in text

    def test_long_doc_is_cut_with_a_way_on(self):
        full = gdoc_client.summarise(_DOC)
        text = gdoc_client.summarise(_DOC, limit=full.index("[14-19)") + 5)
        assert 'from_tab "t.0" and from_index 14' in text
        assert "[1-13) Hello" in text and "note" not in text
        later = gdoc_client.summarise(_DOC, from_tab="t.0", from_index=14)
        assert "[1-13)" not in later and "[14-19) cell" in later
        assert "[1-6) note" in later  # positions start again in the next tab
        last = gdoc_client.summarise(_DOC, from_tab="t.1", from_index=0)
        assert "cell" not in last and "[1-6) note" in last
        assert "- c1 [OPEN]" in last  # comments always listed


# -- launch settings ----------------------------------------------------------------------------

class TestClaudeLaunch:
    def _settings(self):
        return claude_plan_settings_for_work_dir("/repo", "/repo/botference")

    def test_allows_exactly_the_posters_tools(self):
        allow = self._settings()["permissions"]["allow"]
        assert [r for r in allow if r.startswith("mcp__")] == [
            f"mcp__{SERVER_NAME}__{tool}" for tool in (
                READ_TOOL, WRITE_TOOL, "search_mail", "read_mail", "read_attachment")]
        assert SERVER_NAME == "botference_google"
        assert list(CLAUDE_TOOL_RULES) == [r for r in allow if r.startswith("mcp__")]

    def test_every_claude_ai_google_connector_denied(self):
        deny = self._settings()["permissions"]["deny"]
        for server in ("Google_Docs", "Google_Drive", "Gmail", "Google_Calendar",
                       "Google_Sheets", "Google_Slides"):
            assert f"mcp__claude_ai_{server}" in deny
        assert set(CLAUDE_DENIED_GOOGLE_SERVERS) <= set(deny)

    def test_bot_cannot_read_the_saved_sign_in(self):
        deny = self._settings()["permissions"]["deny"]
        home = str(gdoc_client.google_home().resolve()).lstrip("/")
        assert f"Read(//{home}/**)" in deny and f"Edit(//{home}/**)" in deny
        assert set(claude_sign_in_deny_rules()) <= set(deny)

    def test_no_hook_any_more(self):
        assert "hooks" not in self._settings()

    def _mcp(self, cmd):
        config = json.loads(cmd[cmd.index("--mcp-config") + 1])
        (name, server), = config["mcpServers"].items()
        assert name == SERVER_NAME
        return server

    def test_council_claude_starts_the_poster(self):
        a = ClaudeAdapter(settings=self._settings())
        a.session_id = str(uuid.uuid4())
        server = self._mcp(a._build_cmd(resume=False))
        assert server["args"] == ["-I", str(CORE / "gdoc_mcp.py"), "--bot", "claude"]
        assert self._mcp(a._build_cmd(resume=True)) == server

    def test_no_poster_without_botference_settings(self):
        a = ClaudeAdapter()
        a.session_id = "s"
        assert "--mcp-config" not in a._build_cmd(resume=False)

    def test_summoned_claude_agent_inherits_it(self, tmp_path, monkeypatch):
        from test_botference import _make_botference
        monkeypatch.setenv("BOTFERENCE_BUILDER_CLI", "claude")
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        spec = summon.builder_spec("claude", tmp_path)
        assert spec["cli"] == "claude"
        for extra in ([], ["python3"]):
            agent = c._make_builder({**spec, "unsandboxed_commands": extra})
            agent.session_id = "s"
            cmd = agent._build_cmd(resume=False)
            assert self._mcp(cmd)["args"][-2:] == ["--bot", "claude"]
            settings = json.loads(cmd[cmd.index("--settings") + 1])
            assert set(CLAUDE_TOOL_RULES) <= set(settings["permissions"]["allow"])
            assert set(CLAUDE_DENIED_GOOGLE_SERVERS) <= set(settings["permissions"]["deny"])
            assert set(claude_sign_in_deny_rules()) <= set(settings["permissions"]["deny"])


class TestCodexLaunch:
    def _overrides(self, cmd):
        return [cmd[i + 1] for i, a in enumerate(cmd) if a == "-c"]

    @pytest.mark.parametrize("sandbox, base, extra", [
        ("workspace-write", ":workspace",
         ',":project_roots"={".git"="read",".codex"="read",".agents"="read"}'),
        ("read-only", ":read-only", "")])
    def test_poster_in_apps_out_sign_in_hidden(self, sandbox, base, extra):
        x = CodexAdapter(sandbox=sandbox, network_access=True)
        x.thread_id = "tid"
        home = json.dumps(str(gdoc_client.google_home().resolve()))
        for cmd in (x._build_send_cmd("hi"), x._build_resume_cmd("again")):
            over = self._overrides(cmd)
            assert "--sandbox" not in cmd
            assert f'mcp_servers.{SERVER_NAME}.default_tools_approval_mode="approve"' in over
            args = next(o for o in over if o.startswith(f"mcp_servers.{SERVER_NAME}.args="))
            assert json.loads(args.split("=", 1)[1]) == [
                "-I", str(CORE / "gdoc_mcp.py"), "--bot", "codex"]
            assert "features.apps=false" in over
            assert f'sandbox_mode="{sandbox}"' in over
            assert f'permissions.botference.extends="{base}"' in over
            fs = next(o for o in over if o.startswith("permissions.botference.filesystem="))
            assert fs == f"permissions.botference.filesystem={{{home}=\"none\"{extra}}}"
            want = {json.loads(home): "none"}
            if sandbox == "workspace-write":
                want[":project_roots"] = {".git": "read", ".codex": "read", ".agents": "read"}
            assert tomllib.loads(fs.replace("permissions.botference.filesystem", "fs", 1))["fs"] == want
            assert "permissions.botference.network.enabled=true" in over
            assert 'default_permissions="botference"' in over

    def test_network_follows_the_room(self):
        over = self._overrides(CodexAdapter(sandbox="workspace-write")._build_send_cmd("hi"))
        assert "permissions.botference.network.enabled=false" in over

    def test_unknown_sandbox_is_loud(self):
        with pytest.raises(ValueError):
            codex_config_overrides("danger-full-access", False)

    def test_summoned_codex_agent_inherits_it(self, tmp_path):
        from test_botference import _make_botference
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        spec = summon.builder_spec("claude", tmp_path, task="imagegen")
        agent = c._make_builder(spec)
        over = self._overrides(agent._build_send_cmd("build"))
        assert "features.apps=false" in over and 'default_permissions="botference"' in over


# -- rule text ----------------------------------------------------------------------------------

class TestRuleText:
    def test_both_bots_get_it(self):
        assert GDOC_REVIEW_BOTS == ("claude", "codex")

    @pytest.mark.parametrize("bot, name, other", [
        ("claude", "Claude", "Codex"), ("codex", "Codex", "Claude")])
    def test_each_bot_gets_its_own_name(self, bot, name, other):
        note = google_doc_review_note(bot)
        assert note.startswith("--- Reviewing a Google Doc ---")
        assert f'"{name}:"' in note and f"in {other}'s lane" in note
        assert READ_TOOL in note and WRITE_TOOL in note and SERVER_NAME in note
        assert "requiredRevisionId" in note
        assert "puts your name" in note
        assert "infer it from the prompt, and ask if unsure" in note
        assert "Claude covers argument, structure and wording" in note
        assert "Codex covers facts, numbers, sources and technical claims" in note
        assert "roles the user states in the prompt win" in note
        assert "tell the user that line in the council chat" in note

    def test_other_bots_get_nothing(self):
        assert google_doc_review_note("gemini") == ""
