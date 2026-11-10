"""Reading the agent account's mail: scopes, search, messages, threads,
attachments, hidden senders, the poster's mail tools and their wiring.

No network, no real sign-in: Google is a fake transport, and the sign-in
and attachment folders are temporary ones.
"""

from __future__ import annotations

import base64
import json
import os
import stat
import sys
import urllib.parse
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "core"
sys.path.insert(0, str(CORE))

import gdoc_client  # noqa: E402
import gmail_client  # noqa: E402
from cli_adapters import CodexAdapter, claude_plan_settings_for_work_dir  # noqa: E402
from gdoc_client import DocsClient, GdocError, Problem  # noqa: E402
from gdoc_mcp import (  # noqa: E402
    ALL_TOOLS,
    CLAUDE_TOOL_RULES,
    MAIL_TOOLS,
    READ_ATTACHMENT_TOOL,
    READ_MAIL_TOOL,
    READ_TOOL,
    SEARCH_MAIL_TOOL,
    SERVER_NAME,
    TOOLS,
    Poster,
    claude_sign_in_deny_rules,
    codex_config_overrides,
)
from gmail_client import (  # noqa: E402
    API,
    MAIL_HIDDEN_SENDERS,
    OUTSIDE_MATERIAL_LINE,
    Delivery,
    MailClient,
    delivery_for,
    safe_file_name,
)
from room_prompts import google_mail_note  # noqa: E402

ACCOUNT = "agent@example.com"
ACCESS = "tok-ACCESS-7f3a"
REFRESH = "tok-REFRESH-9c1b"
SECRET = "SECRET-MAIL-TEXT-42"
HIDDEN = MAIL_HIDDEN_SENDERS[0]
NOT_HIDDEN = " ".join(f"-from:{s}" for s in MAIL_HIDDEN_SENDERS)
BOTH = f"openid email {gdoc_client.DOCS_SCOPE} {gdoc_client.GMAIL_SCOPE}"
DOCS_ONLY = f"openid email {gdoc_client.DOCS_SCOPE}"


def b64(data) -> str:
    if isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


# -- fakes --------------------------------------------------------------------

class FakeGmail:
    """Stands in for Google: answers by path, records every call."""

    def __init__(self, messages=None, threads=None, attachments=None,
                 lists=None, fail=None):
        self.messages = messages or {}
        self.threads = threads or {}
        self.attachments = attachments or {}
        self.lists = lists or {}  # "plain" / "files" -> list of ids
        self.fail = fail  # (status, body) for every Gmail call
        self.calls = []

    def __call__(self, method, url, headers, data):
        self.calls.append((method, url, headers, data))
        assert method == "GET", "the mail reader only reads"
        if url.startswith(gdoc_client.API):
            return 200, json.dumps({"title": "doc", "revisionId": "r"}).encode()
        assert url.startswith(API), url
        if self.fail:
            status, body = self.fail
            return status, json.dumps(body).encode()
        parsed = urllib.parse.urlparse(url)
        path = parsed.path.split("/users/me/", 1)[1]
        query = urllib.parse.parse_qs(parsed.query)
        if path == "messages":
            kind = "files" if "has:attachment" in query["q"][0] else "plain"
            ids = self.lists.get(kind, [])[:int(query["maxResults"][0])]
            return 200, json.dumps({"messages": [{"id": i} for i in ids]}).encode()
        parts = path.split("/")
        if parts[0] == "messages" and len(parts) == 2 and parts[1] in self.messages:
            return 200, json.dumps(self.messages[parts[1]]).encode()
        if parts[0] == "messages" and len(parts) == 4 and parts[3] in self.attachments:
            return 200, json.dumps(self.attachments[parts[3]]).encode()
        if parts[0] == "threads" and parts[1] in self.threads:
            return 200, json.dumps(self.threads[parts[1]]).encode()
        return 404, json.dumps({"error": {"code": 404, "message": "Requested entity was not found."}}).encode()

    def gmail_calls(self):
        return [c for c in self.calls if c[1].startswith(API)]


def _home(tmp_path, scope=BOTH):
    home = tmp_path / "google"
    home.mkdir(mode=0o700)
    (home / "client.json").write_text(json.dumps(
        {"installed": {"client_id": "test-client", "client_secret": "s"}}))
    tok = {"account": ACCOUNT, "refresh_token": REFRESH, "access_token": ACCESS,
           "expires_at": 10**12}
    if scope is not None:
        tok["scope"] = scope
    (home / "token.json").write_text(json.dumps(tok))
    return home


def _poster(tmp_path, google, scope=BOTH, now=1_000_000.0):
    home = _home(tmp_path, scope)
    mail = MailClient(home=home, transport=google, clock=lambda: now,
                      attachments_home=tmp_path / "mail-attachments")
    docs = DocsClient(home=home, transport=google, clock=lambda: now)
    return Poster("claude", docs, mail)


def _headers(**h):
    names = {"from_": "From", "to": "To", "cc": "Cc", "date": "Date",
             "subject": "Subject"}
    return [{"name": names[k], "value": v} for k, v in h.items()]


def _msg(mid, payload, sender="Pat <pat@example.com>", subject="Hello",
         internal=1000, thread="t1", snippet=""):
    payload = dict(payload)
    payload["headers"] = _headers(from_=sender, to=ACCOUNT, subject=subject,
                                  date="Mon, 9 Nov 2026 10:00:00 +0000") \
        + payload.get("headers", [])
    return {"id": mid, "threadId": thread, "internalDate": str(internal),
            "snippet": snippet, "payload": payload}


def _text(mime, text, part_id="0", charset=None):
    headers = []
    if charset:
        headers = [{"name": "Content-Type", "value": f'{mime}; charset="{charset}"'}]
        data = b64(text.encode(charset))
    else:
        data = b64(text)
    return {"partId": part_id, "mimeType": mime, "filename": "",
            "headers": headers, "body": {"size": len(text), "data": data}}


def _file(part_id, name, mime, size, attachment_id=None, data=None):
    body = {"size": size}
    if attachment_id:
        body["attachmentId"] = attachment_id
    if data is not None:
        body["data"] = b64(data)
    return {"partId": part_id, "mimeType": mime, "filename": name,
            "headers": [], "body": body}


PLAIN_AND_HTML = _msg("m1", {
    "partId": "", "mimeType": "multipart/alternative", "body": {"size": 0},
    "parts": [_text("text/plain", f"Plain body {SECRET}", "0"),
              _text("text/html", "<p>HTML body</p>", "1")]})

HTML_ONLY = _msg("m2", _text(
    "text/html", "<html><head><style>p{color:red}</style></head><body>"
    "<p>First &amp; best</p><script>alert(1)</script><div>Second<br>line</div>"
    "</body></html>"))

NESTED = _msg("m3", {
    "partId": "", "mimeType": "multipart/mixed", "body": {"size": 0},
    "parts": [
        {"partId": "0", "mimeType": "multipart/alternative", "body": {"size": 0},
         "parts": [_text("text/plain", "Café nested body", "0.0", charset="iso-8859-1"),
                   _text("text/html", "<b>no</b>", "0.1")]},
        _file("1", "report.pdf", "application/pdf", 9, attachment_id="att-pdf"),
        _file("2", "data.csv", "text/csv", 8, attachment_id="att-csv"),
        _file("3", "report.pdf", "application/pdf", 5, data=b"%PDF2"),
    ]})

FROM_HIDDEN = _msg("m9", _text("text/plain", f"Your code is {SECRET}"),
                   sender=f"Google <{HIDDEN.upper()}>")


# -- sign-in scope ------------------------------------------------------------

class TestScope:
    def test_login_asks_for_read_only_mail(self):
        assert gdoc_client.GMAIL_SCOPE == "https://www.googleapis.com/auth/gmail.readonly"
        assert gdoc_client.GMAIL_SCOPE in gdoc_client.LOGIN_SCOPES
        assert gdoc_client.DOCS_SCOPE in gdoc_client.LOGIN_SCOPES

    def _reply(self, scope):
        claims = b64(json.dumps({"email": ACCOUNT, "email_verified": True}))
        return {"access_token": ACCESS, "refresh_token": REFRESH, "expires_in": 3600,
                "scope": scope, "id_token": f"h.{claims}.sig"}

    def test_docs_only_sign_in_still_saved_and_scope_kept(self):
        saved = gdoc_client.accept_sign_in(self._reply(DOCS_ONLY), ACCOUNT, 0)
        assert saved["scope"] == DOCS_ONLY
        saved = gdoc_client.accept_sign_in(self._reply(BOTH), ACCOUNT, 0)
        assert gdoc_client.GMAIL_SCOPE in saved["scope"].split()

    def test_mail_alone_is_not_enough(self):
        with pytest.raises(GdocError) as e:
            gdoc_client.accept_sign_in(
                self._reply(f"openid email {gdoc_client.GMAIL_SCOPE}"), ACCOUNT, 0)
        assert e.value.problem is Problem.INCOMPLETE_SIGN_IN

    @pytest.mark.parametrize("scope", [DOCS_ONLY, None])
    def test_old_sign_in_works_for_docs_but_not_mail(self, tmp_path, scope):
        google = FakeGmail(messages={"m1": PLAIN_AND_HTML})
        poster = _poster(tmp_path, google, scope=scope)
        text, is_error = poster.call(READ_TOOL, {"document": "D" * 30})
        assert not is_error and "revision id: r" in text
        for name, args in ((SEARCH_MAIL_TOOL, {}),
                           (READ_MAIL_TOOL, {"message_id": "m1"}),
                           (READ_ATTACHMENT_TOOL, {"message_id": "m1", "part": "1"})):
            text, is_error = poster.call(name, args)
            assert is_error and text == Problem.MAIL_NOT_GRANTED.value
            assert "\n" not in text and "tick" in text
        assert google.gmail_calls() == []

    def test_google_saying_scope_insufficient_gives_the_same_line(self, tmp_path):
        google = FakeGmail(fail=(403, {"error": {
            "code": 403, "message": "Request had insufficient authentication scopes.",
            "details": [{"reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}))
        text, is_error = _poster(tmp_path, google).call(SEARCH_MAIL_TOOL, {})
        assert is_error and text == Problem.MAIL_NOT_GRANTED.value

    def test_no_sign_in_reported_first(self, tmp_path):
        home = tmp_path / "google"
        home.mkdir()
        (home / "client.json").write_text(json.dumps({"installed": {"client_id": "c"}}))
        mail = MailClient(home=home, transport=FakeGmail())
        text, is_error = Poster("codex", DocsClient(home=home), mail).call(SEARCH_MAIL_TOOL, {})
        assert is_error and text.startswith("Google Docs: botference is not signed in")


# -- search -------------------------------------------------------------------

class TestSearch:
    def _google(self):
        msgs = {
            "m1": _msg("m1", {}, subject="Older", internal=1000, snippet="it&#39;s old"),
            "m2": _msg("m2", {}, subject="Newer", internal=3000, snippet="new one"),
            "m9": FROM_HIDDEN,
        }
        return FakeGmail(messages=msgs, lists={"plain": ["m1", "m9", "m2"],
                                                "files": ["m2"]})

    def test_rows_newest_first_hidden_dropped(self, tmp_path):
        google = self._google()
        text, is_error = _poster(tmp_path, google).call(SEARCH_MAIL_TOOL, {})
        assert not is_error
        lines = text.splitlines()
        assert lines[0] == OUTSIDE_MATERIAL_LINE
        rows = [x for x in lines if x.startswith("- message")]
        assert [r.split()[2] for r in rows] == ["m2", "m1"]
        assert "subject: Newer" in rows[0] and "attachments: yes" in rows[0]
        assert "attachments: no" in rows[1] and "from: Pat <pat@example.com>" in rows[1]
        assert "thread t1" in rows[0]
        assert "    it's old" in lines
        assert SECRET not in text and "m9" not in text

    def test_query_excludes_hidden_senders_and_defaults(self, tmp_path):
        google = self._google()
        _poster(tmp_path, google).call(SEARCH_MAIL_TOOL, {})
        first = urllib.parse.parse_qs(urllib.parse.urlparse(google.calls[0][1]).query)
        assert first["q"] == [f"(in:inbox) {NOT_HIDDEN}"]
        assert first["maxResults"] == ["20"]
        assert google.calls[0][2]["Authorization"] == "Bearer " + ACCESS

    @pytest.mark.parametrize("given, sent", [(500, "50"), (0, "1"), (5, "5"),
                                             ("7", "20"), (True, "20")])
    def test_count_capped(self, tmp_path, given, sent):
        google = self._google()
        _poster(tmp_path, google).call(SEARCH_MAIL_TOOL, {"query": "from:pat@example.com",
                                                          "max_results": given})
        q = urllib.parse.parse_qs(urllib.parse.urlparse(google.calls[0][1]).query)
        assert q["maxResults"] == [sent]
        assert q["q"] == [f"(from:pat@example.com) {NOT_HIDDEN}"]

    def test_nothing_found(self, tmp_path):
        text, is_error = _poster(tmp_path, FakeGmail()).call(SEARCH_MAIL_TOOL, {"query": "x"})
        assert not is_error and text.startswith(OUTSIDE_MATERIAL_LINE + "\n")
        assert "(no mail found)" in text


# -- reading ------------------------------------------------------------------

class TestRead:
    def _read(self, tmp_path, msg, **kw):
        google = FakeGmail(messages={msg["id"]: msg})
        return _poster(tmp_path, google).call(READ_MAIL_TOOL, {"message_id": msg["id"]})

    def test_plain_part_preferred(self, tmp_path):
        text, is_error = self._read(tmp_path, PLAIN_AND_HTML)
        assert not is_error and text.startswith(OUTSIDE_MATERIAL_LINE + "\n")
        assert f"Plain body {SECRET}" in text and "HTML body" not in text
        for head in ("From: Pat <pat@example.com>", f"To: {ACCOUNT}",
                     "Subject: Hello", "Date: Mon, 9 Nov 2026"):
            assert head in text
        assert "attachments: none" in text

    def test_html_only_stripped(self, tmp_path):
        text, _ = self._read(tmp_path, HTML_ONLY)
        body = text.split("body:\n", 1)[1]
        assert "First & best" in body and "Second\nline" in body
        assert "<" not in body and "alert" not in body and "color" not in body

    def test_nested_parts_and_attachments(self, tmp_path):
        text, _ = self._read(tmp_path, NESTED)
        assert "Café nested body" in text and "<b>" not in text
        assert "- part 1: report.pdf (application/pdf, 9 bytes)" in text
        assert "- part 2: data.csv (text/csv, 8 bytes)" in text
        assert "- part 3: report-3.pdf (application/pdf, 5 bytes)" in text

    def test_cc_shown(self, tmp_path):
        msg = _msg("m5", _text("text/plain", "hi"))
        msg["payload"]["headers"] += _headers(cc="Lee <lee@example.com>")
        text, _ = self._read(tmp_path, msg)
        assert "Cc: Lee <lee@example.com>" in text

    def test_long_body_cut_and_said(self, tmp_path, monkeypatch):
        monkeypatch.setattr(gmail_client, "BODY_LIMIT", 50)
        text, _ = self._read(tmp_path, _msg("m6", _text("text/plain", "x" * 200)))
        assert "x" * 50 in text and "x" * 51 not in text
        assert "cut here: the body is 200 characters" in text

    def test_needs_exactly_one_id(self, tmp_path):
        poster = _poster(tmp_path, FakeGmail())
        for args in ({}, {"message_id": "a", "thread_id": "b"}):
            text, is_error = poster.call(READ_MAIL_TOOL, args)
            assert is_error and "\n" not in text

    @pytest.mark.parametrize("bad", ["../x", "a/b", "", "x" * 300, 7, "a b"])
    def test_bad_ids_refused_before_google(self, tmp_path, bad):
        google = FakeGmail()
        text, is_error = _poster(tmp_path, google).call(READ_MAIL_TOOL, {"message_id": bad})
        assert is_error and google.gmail_calls() == []

    def test_not_found(self, tmp_path):
        text, is_error = _poster(tmp_path, FakeGmail()).call(
            READ_MAIL_TOOL, {"message_id": "nope"})
        assert is_error and text == Problem.MAIL_NOT_FOUND.value.format(
            detail="message or thread")


class TestThread:
    def test_hidden_messages_dropped_and_counted(self, tmp_path):
        thread = {"id": "t1", "messages": [
            _msg("a1", _text("text/plain", "first")), FROM_HIDDEN,
            _msg("a2", _text("text/plain", "second"))]}
        google = FakeGmail(threads={"t1": thread})
        text, is_error = _poster(tmp_path, google).call(READ_MAIL_TOOL, {"thread_id": "t1"})
        assert not is_error and text.startswith(OUTSIDE_MATERIAL_LINE + "\n")
        assert "2 message(s)" in text and "(1 message(s) from a hidden sender left out)" in text
        assert "first" in text and "second" in text
        assert SECRET not in text and HIDDEN not in text.lower()

    def test_all_hidden_refused(self, tmp_path):
        google = FakeGmail(threads={"t2": {"id": "t2", "messages": [FROM_HIDDEN]}})
        text, is_error = _poster(tmp_path, google).call(READ_MAIL_TOOL, {"thread_id": "t2"})
        assert is_error and text == Problem.MAIL_HIDDEN.value.format(detail="thread")


# -- hidden senders -----------------------------------------------------------

class TestHiddenSenders:
    def test_the_list(self):
        assert MAIL_HIDDEN_SENDERS == ("no-reply@accounts.google.com",
                                       "noreply@google.com")

    @pytest.mark.parametrize("header, hidden", [
        (f"Google <{HIDDEN}>", True),
        (HIDDEN.upper(), True),
        (f'"Google Accounts" <No-Reply@Accounts.Google.Com>', True),
        (f'"{HIDDEN}" <pat@example.com>', False),  # only the display name
        ("pat@example.com", False),
        ("", False),
    ])
    def test_parsed_address_compared(self, header, hidden):
        assert gmail_client.is_hidden_sender(header) is hidden

    def test_message_refused(self, tmp_path):
        google = FakeGmail(messages={"m9": FROM_HIDDEN})
        poster = _poster(tmp_path, google)
        text, is_error = poster.call(READ_MAIL_TOOL, {"message_id": "m9"})
        assert is_error and text == Problem.MAIL_HIDDEN.value.format(detail="message")
        assert SECRET not in text
        text, is_error = poster.call(READ_ATTACHMENT_TOOL, {"message_id": "m9", "part": "0"})
        assert is_error and SECRET not in text


# -- attachments --------------------------------------------------------------

class TestDelivery:
    @pytest.mark.parametrize("mime, name, size, want", [
        ("text/plain", "a.txt", 10, Delivery.INLINE_TEXT),
        ("text/csv", "a.csv", 10, Delivery.INLINE_TEXT),
        ("application/json", "a.json", 10, Delivery.INLINE_TEXT),
        ("application/ld+json", "a", 10, Delivery.INLINE_TEXT),
        ("application/xml", "a.xml", 10, Delivery.INLINE_TEXT),
        ("text/markdown; charset=utf-8", "a.md", 10, Delivery.INLINE_TEXT),
        ("application/octet-stream", "notes.md", 10, Delivery.INLINE_TEXT),
        ("application/pdf", "a.pdf", 10, Delivery.SAVED_FILE),
        ("image/png", "a.png", 10, Delivery.SAVED_FILE),
        ("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
         "a.docx", 10, Delivery.SAVED_FILE),
        ("application/octet-stream", "a.bin", 10, Delivery.SAVED_FILE),
        ("text/plain", "a.txt", 25 * 1024 * 1024 + 1, Delivery.REFUSED_TOO_LARGE),
        ("application/pdf", "a.pdf", 25 * 1024 * 1024, Delivery.SAVED_FILE),
    ])
    def test_one_rule(self, mime, name, size, want):
        assert delivery_for(mime, name, size) is want


class TestFileNames:
    @pytest.mark.parametrize("given, want", [
        ("report.pdf", "report.pdf"),
        ("../../x", "x"),
        ("/etc/passwd", "passwd"),
        ("..\\..\\win.ini", "win.ini"),
        ("", "attachment-3"),
        (None, "attachment-3"),
        ("..", "attachment-3"),
        ("...", "attachment-3"),
        ("/", "attachment-3"),
        (".hidden", "hidden"),
        ("a\x00b\nc.txt", "a_b_c.txt"),
        ("rés umé (1).pdf", "r_s um_ _1_.pdf"),
        ("___", "attachment-3"),
    ])
    def test_sanitised(self, given, want):
        assert safe_file_name(given, 3) == want

    def test_long_name_capped_extension_kept(self):
        name = safe_file_name("a" * 500 + ".pdf", 1)
        assert len(name) == gmail_client.FILE_NAME_LIMIT and name.endswith(".pdf")
        assert len(safe_file_name("b" * 500, 1)) == gmail_client.FILE_NAME_LIMIT


class TestAttachments:
    def _google(self, msg=NESTED, **atts):
        attachments = {"att-pdf": {"size": 9, "data": b64(b"%PDF-1.7\n")},
                       "att-csv": {"size": 8, "data": b64("a,b\n1,2\n")}}
        attachments.update(atts)
        return FakeGmail(messages={msg["id"]: msg}, attachments=attachments)

    def test_text_comes_back_inline(self, tmp_path):
        google = self._google()
        text, is_error = _poster(tmp_path, google).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m3", "part": "2"})
        assert not is_error and text.startswith(OUTSIDE_MATERIAL_LINE + "\n")
        assert "a,b\n1,2" in text and "data.csv" in text
        assert not (tmp_path / "mail-attachments").exists()

    def test_inline_text_cut(self, tmp_path, monkeypatch):
        monkeypatch.setattr(gmail_client, "ATTACHMENT_TEXT_LIMIT", 4)
        google = self._google(**{"att-csv": {"size": 8, "data": b64("a,b\n1,2\n")}})
        text, _ = _poster(tmp_path, google).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m3", "part": "2"})
        assert "cut here: the attachment is 8 characters" in text

    def test_binary_saved_to_a_file(self, tmp_path):
        google = self._google()
        text, is_error = _poster(tmp_path, google).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m3", "part": "1"})
        assert not is_error and text.startswith(OUTSIDE_MATERIAL_LINE + "\n")
        root = (tmp_path / "mail-attachments").resolve()
        path = root / "m3" / "report.pdf"
        assert f"saved to: {path}" in text and "application/pdf" in text
        assert path.read_bytes() == b"%PDF-1.7\n"
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE((root / "m3").stat().st_mode) == 0o700
        assert stat.S_IMODE(root.stat().st_mode) == 0o700

    def test_small_attachment_carried_in_the_message(self, tmp_path):
        google = self._google()
        text, _ = _poster(tmp_path, google).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m3", "part": "3"})
        assert (tmp_path / "mail-attachments" / "m3" / "report-3.pdf").read_bytes() == b"%PDF2"
        assert not any("/attachments/" in c[1] for c in google.calls)

    @pytest.mark.parametrize("name", ["../../x", "/abs/path/evil.sh", "", "." * 9,
                                      "a/" * 50 + "z" * 400])
    def test_names_cannot_escape(self, tmp_path, name):
        msg = _msg("m7", {"partId": "", "mimeType": "multipart/mixed", "body": {},
                          "parts": [_file("1", name, "application/pdf", 3,
                                          attachment_id="att-x")]})
        google = FakeGmail(messages={"m7": msg},
                           attachments={"att-x": {"size": 3, "data": b64(b"abc")}})
        text, is_error = _poster(tmp_path, google).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m7", "part": "1"})
        assert not is_error
        folder = (tmp_path / "mail-attachments" / "m7").resolve()
        files = list(folder.iterdir())
        assert len(files) == 1 and files[0].resolve().parent == folder
        assert len(files[0].name) <= gmail_client.FILE_NAME_LIMIT
        assert sorted(p.name for p in (tmp_path / "mail-attachments").iterdir()) == ["m7"]

    @pytest.mark.parametrize("part", ["1/../2", "../1", "x", "", None])
    def test_bad_part_refused(self, tmp_path, part):
        google = self._google()
        text, is_error = _poster(tmp_path, google).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m3", "part": part})
        assert is_error and "\n" not in text and google.gmail_calls() == []

    def test_unknown_part(self, tmp_path):
        text, is_error = _poster(tmp_path, self._google()).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m3", "part": "0.0"})
        assert is_error and text == Problem.MAIL_NOT_FOUND.value.format(detail="attachment")

    def test_too_large_refused_before_download(self, tmp_path):
        big = gmail_client.ATTACHMENT_MAX_BYTES + 1
        msg = _msg("m8", {"partId": "", "mimeType": "multipart/mixed", "body": {},
                          "parts": [_file("1", "big.pdf", "application/pdf", big,
                                          attachment_id="att-big")]})
        google = FakeGmail(messages={"m8": msg})
        text, is_error = _poster(tmp_path, google).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m8", "part": "1"})
        assert is_error and text.startswith("Gmail: that attachment is")
        assert str(big) in text and "\n" not in text
        assert not any("/attachments/" in c[1] for c in google.calls)

    def test_too_large_after_download_refused(self, tmp_path, monkeypatch):
        monkeypatch.setattr(gmail_client, "ATTACHMENT_MAX_BYTES", 5)
        msg = _msg("m4", {"partId": "", "mimeType": "multipart/mixed", "body": {},
                          "parts": [_file("1", "small.pdf", "application/pdf", 1,
                                          attachment_id="att-lies")]})
        google = FakeGmail(messages={"m4": msg},
                           attachments={"att-lies": {"size": 1, "data": b64(b"x" * 9)}})
        text, is_error = _poster(tmp_path, google).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m4", "part": "1"})
        assert is_error and text.startswith("Gmail: that attachment is 9 bytes")
        assert any("/attachments/att-lies" in c[1] for c in google.calls)
        assert not (tmp_path / "mail-attachments").exists()

    def test_old_folders_pruned_on_save(self, tmp_path):
        now = 1_000_000_000.0
        root = tmp_path / "mail-attachments"
        old, fresh = root / "old1", root / "fresh1"
        for folder, age_days in ((old, 31), (fresh, 29)):
            folder.mkdir(parents=True)
            (folder / "f.pdf").write_bytes(b"x")
            t = now - age_days * 86400
            os.utime(folder, (t, t))
        google = self._google()
        _poster(tmp_path, google, now=now).call(
            READ_ATTACHMENT_TOOL, {"message_id": "m3", "part": "1"})
        assert not old.exists() and fresh.exists() and (root / "m3").exists()
        assert gmail_client.ATTACHMENT_KEEP_DAYS == 30

    def test_folder_is_outside_the_sign_in_folder(self):
        root = gmail_client.ATTACHMENTS_HOME.resolve()
        home = gdoc_client.DEFAULT_HOME.resolve()
        assert root != home and home not in root.parents
        assert root == (Path.home() / ".botference" / "mail-attachments").resolve()


# -- failures -----------------------------------------------------------------

class TestFailures:
    @pytest.mark.parametrize("body", [
        {"error": {"code": 403, "message": "Gmail API has not been used in project "
                   "123 before or it is disabled.", "status": "PERMISSION_DENIED",
                   "details": [{"reason": "SERVICE_DISABLED"}]}},
        {"error": {"code": 403, "message": "Gmail API has not been used in project 123"}},
        {"error": {"code": 403, "message": "x", "errors": [{"reason": "accessNotConfigured"}]}},
    ])
    def test_service_switched_off(self, tmp_path, body):
        google = FakeGmail(fail=(403, body))
        text, is_error = _poster(tmp_path, google).call(SEARCH_MAIL_TOOL, {})
        assert is_error and text == Problem.MAIL_SERVICE_OFF.value
        assert "switch on the Gmail API" in text

    def test_other_refusal_is_one_gmail_line(self, tmp_path):
        google = FakeGmail(fail=(500, {"error": {"code": 500, "message": "Backend Error"}}))
        text, is_error = _poster(tmp_path, google).call(SEARCH_MAIL_TOOL, {})
        assert is_error and text.startswith("Gmail: Google refused the request (500")
        assert "\n" not in text

    def test_network_down(self, tmp_path):
        def down(method, url, headers, data):
            raise OSError("no route")
        text, is_error = _poster(tmp_path, down).call(SEARCH_MAIL_TOOL, {})
        assert is_error and "could not reach Google" in text

    def test_no_error_line_holds_mail_or_tokens(self, tmp_path):
        failures = []
        msgs = {"m1": PLAIN_AND_HTML, "m9": FROM_HIDDEN, "m3": NESTED}
        cases = [
            (FakeGmail(messages=msgs), READ_MAIL_TOOL, {"message_id": "m9"}),
            (FakeGmail(messages=msgs), READ_MAIL_TOOL, {"message_id": "zz"}),
            (FakeGmail(threads={"t": {"id": "t", "messages": [FROM_HIDDEN]}}),
             READ_MAIL_TOOL, {"thread_id": "t"}),
            (FakeGmail(messages=msgs), READ_ATTACHMENT_TOOL, {"message_id": "m1", "part": "9"}),
            (FakeGmail(messages=msgs), READ_ATTACHMENT_TOOL, {"message_id": "m9", "part": "0"}),
            (FakeGmail(fail=(403, {"error": {"details": [{"reason": "SERVICE_DISABLED"}]}})),
             SEARCH_MAIL_TOOL, {}),
            (FakeGmail(fail=(401, {})), SEARCH_MAIL_TOOL, {}),
        ]
        for n, (google, name, args) in enumerate(cases):
            sub = tmp_path / str(n)
            sub.mkdir()
            text, is_error = _poster(sub, google).call(name, args)
            assert is_error, (name, args)
            failures.append(text)
        for text in failures:
            assert "\n" not in text
            for secret in (SECRET, ACCESS, REFRESH, "Plain body", "test-client",
                           "Your code is"):
                assert secret not in text

    def test_every_problem_is_one_line(self):
        for p in Problem:
            assert "\n" not in p.value


# -- the poster's tools and their wiring --------------------------------------

class TestTools:
    def test_names_in_one_place(self):
        assert MAIL_TOOLS == ("search_mail", "read_mail", "read_attachment")
        assert ALL_TOOLS[-3:] == MAIL_TOOLS
        assert [t["name"] for t in TOOLS] == list(ALL_TOOLS)

    def test_mail_tools_are_read_only(self):
        for tool in TOOLS:
            if tool["name"] in MAIL_TOOLS:
                assert tool["annotations"]["readOnlyHint"] is True
                assert tool["inputSchema"]["type"] == "object"
        attach = next(t for t in TOOLS if t["name"] == READ_ATTACHMENT_TOOL)
        assert attach["inputSchema"]["required"] == ["message_id", "part"]

    def test_server_renamed(self):
        assert SERVER_NAME == "botference_google"
        assert CLAUDE_TOOL_RULES == tuple(f"mcp__botference_google__{t}" for t in ALL_TOOLS)

    def test_no_old_server_name_left(self):
        old = "botference" + "_gdoc"
        places = [ROOT / "README.md", ROOT / "core", ROOT / "docs", ROOT / "tests"]
        for place in places:
            files = [place] if place.is_file() else [
                p for p in place.rglob("*") if p.is_file() and p.suffix in (".py", ".md", ".1")]
            for f in files:
                assert old not in f.read_text(encoding="utf-8", errors="replace"), f

    def test_claude_allow_list_has_the_mail_tools(self):
        allow = claude_plan_settings_for_work_dir("/repo", "/repo/botference")["permissions"]["allow"]
        for tool in MAIL_TOOLS:
            assert f"mcp__{SERVER_NAME}__{tool}" in allow

    @pytest.mark.parametrize("sandbox", ["workspace-write", "read-only"])
    def test_codex_enables_the_mail_tools(self, sandbox):
        over = codex_config_overrides(sandbox, False)
        enabled = next(o for o in over if o.startswith(f"mcp_servers.{SERVER_NAME}.enabled_tools="))
        assert json.loads(enabled.split("=", 1)[1]) == list(ALL_TOOLS)
        cmd = CodexAdapter(sandbox=sandbox)._build_send_cmd("hi")
        assert enabled in cmd

    def test_attachments_folder_readable_by_both_bots(self):
        root = str(gmail_client.ATTACHMENTS_HOME.resolve())
        settings = claude_plan_settings_for_work_dir("/repo", "/repo/botference")
        for rule in settings["permissions"]["deny"]:
            inside = rule.split("(//", 1)[-1].rstrip(")").rstrip("/*")
            assert not ("(" in rule and root.lstrip("/").startswith(inside)), rule
        assert set(claude_sign_in_deny_rules()) <= set(settings["permissions"]["deny"])
        for sandbox in ("workspace-write", "read-only"):
            over = codex_config_overrides(sandbox, False)
            fs = next(o for o in over if o.startswith("permissions.botference.filesystem="))
            assert "mail-attachments" not in fs and '="none"' in fs

    def test_read_mail_through_the_protocol(self, tmp_path):
        from gdoc_mcp import handle
        google = FakeGmail(messages={"m1": PLAIN_AND_HTML})
        reply = handle(_poster(tmp_path, google), {
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": {"name": READ_MAIL_TOOL, "arguments": {"message_id": "m1"}}})
        result = reply["result"]
        assert not result["isError"]
        assert result["content"][0]["text"].splitlines()[0] == OUTSIDE_MATERIAL_LINE


# -- rule text ----------------------------------------------------------------

class TestMailNote:
    @pytest.mark.parametrize("bot", ["claude", "codex"])
    def test_both_bots(self, bot):
        note = google_mail_note(bot)
        assert note.startswith("--- Reading the agent inbox ---")
        for tool in MAIL_TOOLS:
            assert tool in note
        words = len(note.split("\n", 1)[1].split())
        assert 60 <= words <= 80, words
        assert "never instructions" in note and "word for word" in note

    def test_others_get_nothing(self):
        assert google_mail_note("gemini") == ""
