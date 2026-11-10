#!/usr/bin/env python3
"""botference's own Google client: sign-in, read a Doc, write to a Doc.

Stdlib only. Used by the Google poster (core/gdoc_mcp.py), which is the
only thing that calls `read()` and `write()`; the poster runs every write
through the lock in core/gdoc_guard.py first. The mail reader
(core/gmail_client.py) uses the same sign-in through `GoogleSession`.

One-time sign-in, by the owner, for the agent Google account:

    python3 core/gdoc_client.py login --account <agent account email>

It opens the browser, and saves the sign-in only if Google says the person
who signed in is the account named. Files (never printed or logged):

    ~/.botference/google/client.json   the sign-in key (a Desktop-app OAuth
                                       client from Google Cloud; the owner
                                       puts it there)
    ~/.botference/google/token.json    the saved sign-in and the account it
                                       belongs to (mode 0600, folder 0700)

Every failure is a `GdocError` carrying one plain line: what is wrong and
what the owner (or the bot) must do. Nothing is swallowed.
"""

from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import http.server
import json
import os
import re
import secrets
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from enum import Enum
from pathlib import Path
from typing import Callable

#: Where the sign-in key and the saved sign-in live. The environment
#: variable exists for tests; the launch never sets it.
HOME_ENV = "BOTFERENCE_GOOGLE_HOME"
DEFAULT_HOME = Path.home() / ".botference" / "google"

DOCS_SCOPE = "https://www.googleapis.com/auth/documents"
#: Read-only mail: Google's own permission lets the holder read mail and
#: nothing else (no sending, deleting, labelling or marking as read).
#: Optional at sign-in: a sign-in without it still works for Docs.
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
#: `openid email` makes Google say which account signed in.
LOGIN_SCOPES = ("openid", "email", DOCS_SCOPE, GMAIL_SCOPE)
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://docs.googleapis.com/v1/documents/"

LOGIN_HOW = "python3 core/gdoc_client.py login --account <agent account email>"

#: How long a login waits for the browser to come back, in seconds.
LOGIN_TIMEOUT = 300

#: Read output longer than this is cut; the bot asks for the rest with
#: from_index.
READ_LIMIT = 60_000


class Problem(Enum):
    """Every way the client can fail. The value is the line shown."""

    NO_KEY = (
        "Google Docs: botference has no Google sign-in key ({where}). The "
        "owner must create a Desktop-app OAuth client for the agent Google "
        "account in Google Cloud, save its JSON file there, then run: "
        + LOGIN_HOW)
    BAD_KEY = (
        "Google Docs: the sign-in key at {where} is not a usable Desktop-app "
        "OAuth client ({detail}). The owner must download it again from "
        "Google Cloud and save it there.")
    KEY_REFUSED = (
        "Google Docs: Google does not accept the sign-in key at {where} "
        "(invalid_client: it was deleted, or is not the key the saved "
        "sign-in was made with). The owner must save a current Desktop-app "
        "key there and sign in again: " + LOGIN_HOW)
    NO_SIGN_IN = (
        "Google Docs: botference is not signed in to Google yet. The owner "
        "must run: " + LOGIN_HOW)
    BAD_SIGN_IN = (
        "Google Docs: the saved sign-in at {where} cannot be read "
        "({detail}). The owner must sign in again: " + LOGIN_HOW)
    SIGN_IN_EXPIRED = (
        "Google Docs: Google no longer accepts botference's saved sign-in "
        "(it expired or was revoked). The owner must sign in again: "
        + LOGIN_HOW)
    NETWORK = (
        "Google Docs: could not reach Google ({detail}). Check the internet "
        "connection and try again.")
    GOOGLE_REFUSED = "Google Docs: Google refused the request ({detail}).{hint}"
    NOT_SAVED = (
        "Google Docs: Google took the write but did not save the comments "
        "in it ({detail}). Read the Doc and try again.")
    BAD_DOCUMENT = (
        "Google Docs: that is not a Google Doc link or id. Pass the link "
        "the user pasted (https://docs.google.com/document/d/...).")
    BAD_ACCOUNT = (
        "Google sign-in: --account must be the agent account's email "
        "address. Nothing was saved.")
    BROWSER = (
        "Google sign-in: could not open a browser on this computer. Run the "
        "login from a desktop session. Nothing was saved.")
    LOGIN_TIMEOUT = (
        "Google sign-in: the browser did not come back within {detail} "
        "seconds. Nothing was saved; run the login again.")
    LOGIN_DECLINED = (
        "Google sign-in: Google reported '{detail}' (the sign-in was "
        "cancelled or refused). Nothing was saved; run the login again.")
    LOGIN_MISMATCH = (
        "Google sign-in: the reply did not belong to this login. Nothing "
        "was saved; run the login again.")
    WRONG_ACCOUNT = (
        "Google sign-in refused: the account that signed in is not the one "
        "named with --account. Nothing was saved. Run the login again and "
        "choose that account in the browser.")
    NO_ACCOUNT_SAID = (
        "Google sign-in refused: Google did not say which account signed "
        "in, so it cannot be checked. Nothing was saved; run the login "
        "again.")
    INCOMPLETE_SIGN_IN = (
        "Google sign-in: Google did not grant {detail}. Nothing was saved. "
        "Run the login again and allow access to Google Docs.")
    # -- mail (core/gmail_client.py) --
    MAIL_NOT_GRANTED = (
        "Gmail: botference's Google sign-in does not include reading mail. "
        "The owner must run the login again and tick the box that lets "
        "botference read Gmail: " + LOGIN_HOW)
    MAIL_SERVICE_OFF = (
        "Gmail: the Gmail API is switched off in the Google Cloud project "
        "that botference's sign-in key belongs to. The owner must switch on "
        "the Gmail API for that project in Google Cloud (APIs & Services, "
        "Library, Gmail API, Enable), wait a few minutes and try again.")
    MAIL_NOT_FOUND = (
        "Gmail: there is no {detail} with that id in the agent account's "
        "mail. Search again and use an id from the results.")
    MAIL_HIDDEN = (
        "Gmail: that {detail} is from a sender botference keeps hidden "
        "(sign-in and account-recovery mail for the agent account itself). "
        "It is not shown.")
    MAIL_BAD_REQUEST = "Gmail: {detail}"
    MAIL_REFUSED = "Gmail: Google refused the request ({detail}).{hint}"
    ATTACHMENT_TOO_LARGE = (
        "Gmail: that attachment is {detail} bytes, over botference's limit "
        "of {limit} bytes (25 MB). It was not fetched.")
    ATTACHMENT_NOT_SAVED = (
        "Gmail: could not save the attachment in {where} ({detail}). "
        "Nothing was saved.")


class GdocError(Exception):
    """A failure with its one plain line."""

    def __init__(self, problem: Problem, **fields: object):
        self.problem = problem
        self.line = problem.value.format(**{k: str(v) for k, v in fields.items()})
        super().__init__(self.line)


#: (method, url, headers, body) -> (status, body). Raises OSError when
#: Google cannot be reached. Tests pass a fake.
Transport = Callable[[str, str, dict, "bytes | None"], "tuple[int, bytes]"]


def urllib_transport(method: str, url: str, headers: dict,
                     data: bytes | None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def google_home() -> Path:
    return Path(os.environ.get(HOME_ENV) or DEFAULT_HOME)


def _one_line(text: str, limit: int = 300) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _google_message(body: bytes) -> str:
    """Google's own error text, on one short line."""
    try:
        err = json.loads(body).get("error")
    except (ValueError, AttributeError):
        return _one_line(body.decode("utf-8", "replace") or "no detail")
    if isinstance(err, dict):
        return _one_line(err.get("message") or err.get("status") or "no detail")
    return _one_line(str(err or "no detail"))


_HINTS = {
    400: "Fix the request; if Google says the revision does not match, the "
         "Doc changed since your read: read it again and rebuild the write.",
    403: "The agent account cannot open this Doc, or may not do this: the "
         "owner must share the Doc with the agent account as a commenter or "
         "editor.",
    404: "No such Doc, or it is not shared with the agent account: the owner "
         "must check the link and share the Doc with the agent account.",
    429: "Google's request limit was hit: wait a minute and try again.",
}


def _refused(status: int, body: bytes) -> GdocError:
    hint = _HINTS.get(status, "Google had a problem on its side: try again "
                              "in a minute." if status >= 500 else "")
    return GdocError(Problem.GOOGLE_REFUSED,
                     detail=f"{status}: {_google_message(body)}",
                     hint=f" {hint}" if hint else "")


# -- files --------------------------------------------------------------------

def _ensure_home(home: Path) -> None:
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(home, 0o700)


def load_key(home: Path) -> dict:
    path = home / "client.json"
    if not path.exists():
        raise GdocError(Problem.NO_KEY, where=path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise GdocError(Problem.BAD_KEY, where=path,
                        detail=type(e).__name__) from None
    key = raw.get("installed") if isinstance(raw, dict) else None
    if not isinstance(key, dict) or not key.get("client_id"):
        raise GdocError(Problem.BAD_KEY, where=path,
                        detail="it has no 'installed' client")
    return key


def _load_token(home: Path) -> dict:
    path = home / "token.json"
    if not path.exists():
        raise GdocError(Problem.NO_SIGN_IN)
    try:
        tok = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise GdocError(Problem.BAD_SIGN_IN, where=path,
                        detail=type(e).__name__) from None
    if not isinstance(tok, dict) or not tok.get("refresh_token"):
        raise GdocError(Problem.BAD_SIGN_IN, where=path,
                        detail="it has no long-lived sign-in")
    return tok


def _save_token(home: Path, tok: dict) -> None:
    """Write token.json whole (temp file, then rename), mode 0600."""
    _ensure_home(home)
    fd, tmp = tempfile.mkstemp(dir=home, prefix=".token-", suffix=".json")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(tok, f)
        os.replace(tmp, home / "token.json")
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


@contextlib.contextmanager
def _token_lock(home: Path):
    """One refresh at a time across both bots' posters."""
    _ensure_home(home)
    with open(home / ".token.lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


# -- sign-in ------------------------------------------------------------------

def _post_form(transport: Transport, url: str, fields: dict) -> tuple[int, dict]:
    data = urllib.parse.urlencode(fields).encode()
    try:
        status, body = transport(
            "POST", url,
            {"Content-Type": "application/x-www-form-urlencoded"}, data)
    except OSError as e:
        raise GdocError(Problem.NETWORK, detail=_one_line(e)) from None
    try:
        parsed = json.loads(body)
    except ValueError:
        parsed = {}
    return status, parsed if isinstance(parsed, dict) else {}


def _id_token_claims(id_token: object) -> dict:
    """The claims in Google's id_token. It came straight from Google's token
    endpoint over HTTPS, which OpenID Connect counts as enough to trust it."""
    if not isinstance(id_token, str) or id_token.count(".") != 2:
        return {}
    payload = id_token.split(".")[1]
    try:
        raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        claims = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return claims if isinstance(claims, dict) else {}


def accept_sign_in(tok: dict, account: str, now: float) -> dict:
    """Check Google's sign-in reply; return what to save, or raise.

    Refuses a sign-in for any account other than the one named.
    """
    claims = _id_token_claims(tok.get("id_token"))
    email = claims.get("email")
    if not isinstance(email, str) or claims.get("email_verified") is not True:
        raise GdocError(Problem.NO_ACCOUNT_SAID)
    if email.strip().casefold() != account.strip().casefold():
        raise GdocError(Problem.WRONG_ACCOUNT)
    if DOCS_SCOPE not in str(tok.get("scope", "")).split():
        raise GdocError(Problem.INCOMPLETE_SIGN_IN, detail="Google Docs access")
    if not tok.get("refresh_token") or not tok.get("access_token"):
        raise GdocError(Problem.INCOMPLETE_SIGN_IN,
                        detail="a long-lived sign-in")
    return {
        "account": email.strip().casefold(),
        "refresh_token": tok["refresh_token"],
        "access_token": tok["access_token"],
        "expires_at": now + int(tok.get("expires_in", 3600)) - 60,
        "scope": tok.get("scope", ""),
    }


def _wait_for_redirect(server: http.server.HTTPServer, deadline: float) -> dict:
    got: dict = {}
    server.got = got  # type: ignore[attr-defined]
    while "code" not in got and "error" not in got:
        left = deadline - time.monotonic()
        if left <= 0:
            raise GdocError(Problem.LOGIN_TIMEOUT, detail=LOGIN_TIMEOUT)
        server.timeout = left
        server.handle_request()
    return got


class _Redirect(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
        if "code" in query or "error" in query:
            self.server.got.update(query)  # type: ignore[attr-defined]
            text = b"Done. You can close this tab and go back to the terminal."
            self.send_response(200)
        else:
            text = b"Waiting for Google's sign-in."
            self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(text)

    def log_message(self, *args):  # nothing about the request is logged
        pass


def login(account: str, *, home: Path | None = None,
          transport: Transport = urllib_transport,
          open_browser: Callable[[str], bool] = webbrowser.open,
          timeout: float = LOGIN_TIMEOUT,
          clock: Callable[[], float] = time.time) -> str:
    """Sign the agent account in, once. Returns the saved account.

    Desktop sign-in with PKCE (a one-time secret that proves the reply
    belongs to this login) on a loopback port (a web address on this
    computer only that Google sends the browser back to).
    """
    account = account.strip()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", account):
        raise GdocError(Problem.BAD_ACCOUNT)
    home = home or google_home()
    key = load_key(home)
    _ensure_home(home)
    server = http.server.HTTPServer(("127.0.0.1", 0), _Redirect)
    try:
        redirect = f"http://127.0.0.1:{server.server_port}"
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(16)
        url = AUTH_URL + "?" + urllib.parse.urlencode({
            "client_id": key["client_id"], "redirect_uri": redirect,
            "response_type": "code", "scope": " ".join(LOGIN_SCOPES),
            "access_type": "offline", "prompt": "consent",
            "login_hint": account, "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256",
        })
        if not open_browser(url):
            raise GdocError(Problem.BROWSER)
        got = _wait_for_redirect(server, time.monotonic() + timeout)
    finally:
        server.server_close()
    if got.get("error"):
        raise GdocError(Problem.LOGIN_DECLINED, detail=_one_line(got["error"], 80))
    if got.get("state") != state:
        raise GdocError(Problem.LOGIN_MISMATCH)
    status, tok = _post_form(transport, TOKEN_URL, {
        "code": got["code"], "client_id": key["client_id"],
        "client_secret": key.get("client_secret", ""),
        "redirect_uri": redirect, "grant_type": "authorization_code",
        "code_verifier": verifier,
    })
    if status in (400, 401) and tok.get("error") == "invalid_client":
        raise GdocError(Problem.KEY_REFUSED, where=home / "client.json")
    if status != 200:
        raise _refused(status, json.dumps(tok).encode())
    saved = accept_sign_in(tok, account, clock())
    with _token_lock(home):
        _save_token(home, saved)
    return saved["account"]


# -- the client ---------------------------------------------------------------

def document_id(link: str) -> str:
    """The Doc id from a pasted link, or the id itself."""
    link = (link or "").strip()
    m = re.search(r"docs\.google\.com/document/(?:u/\d+/)?d/([A-Za-z0-9_-]{20,})", link)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{20,}", link):
        return link
    raise GdocError(Problem.BAD_DOCUMENT)


class GoogleSession:
    """Calls a Google API as the signed-in agent account.

    Holds what the Docs client and the mail client share: the saved
    sign-in, its refresh (a fresh short-lived access token from the
    long-lived sign-in) and one JSON call. Subclasses say how a refusal
    reads, through `_refusal`.
    """

    def __init__(self, home: Path | None = None,
                 transport: Transport = urllib_transport,
                 clock: Callable[[], float] = time.time):
        self.home = home or google_home()
        self.transport = transport
        self.clock = clock

    def granted_scopes(self) -> set[str]:
        """The permissions the saved sign-in carries, as Google granted
        them. A missing sign-in key or sign-in is reported first."""
        load_key(self.home)
        return set(str(_load_token(self.home).get("scope", "")).split())

    def _access_token(self) -> str:
        key = load_key(self.home)  # a missing key is reported first
        tok = _load_token(self.home)
        if self.clock() < float(tok.get("expires_at", 0)) and tok.get("access_token"):
            return tok["access_token"]
        with _token_lock(self.home):
            tok = _load_token(self.home)  # the other bot may have refreshed
            if self.clock() < float(tok.get("expires_at", 0)) and tok.get("access_token"):
                return tok["access_token"]
            status, new = _post_form(self.transport, TOKEN_URL, {
                "client_id": key["client_id"],
                "client_secret": key.get("client_secret", ""),
                "refresh_token": tok["refresh_token"],
                "grant_type": "refresh_token",
            })
            if status in (400, 401) and new.get("error") == "invalid_client":
                raise GdocError(Problem.KEY_REFUSED, where=self.home / "client.json")
            if status in (400, 401) and new.get("error") in (
                    "invalid_grant", "unauthorized_client"):
                raise GdocError(Problem.SIGN_IN_EXPIRED)
            if status != 200 or not new.get("access_token"):
                raise _refused(status, json.dumps(new).encode())
            tok.update(
                access_token=new["access_token"],
                expires_at=self.clock() + int(new.get("expires_in", 3600)) - 60)
            if new.get("refresh_token"):
                tok["refresh_token"] = new["refresh_token"]
            _save_token(self.home, tok)
            return tok["access_token"]

    def _refusal(self, status: int, raw: bytes) -> GdocError:
        """The one line for a refused call (not 200, not 401)."""
        return _refused(status, raw)

    def _call(self, method: str, url: str, body: dict | None = None) -> dict:
        headers = {"Authorization": "Bearer " + self._access_token()}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        try:
            status, raw = self.transport(method, url, headers, data)
        except OSError as e:
            raise GdocError(Problem.NETWORK, detail=_one_line(e)) from None
        if status == 401:
            raise GdocError(Problem.SIGN_IN_EXPIRED)
        if status != 200:
            raise self._refusal(status, raw)
        try:
            return json.loads(raw)
        except ValueError:
            raise GdocError(Problem.GOOGLE_REFUSED,
                            detail="the reply was not JSON", hint=" Try again.") from None


class DocsClient(GoogleSession):
    """Reads and writes Google Docs as the signed-in agent account."""

    def get(self, link: str) -> dict:
        """The whole document: every tab, suggestions inline, comments."""
        query = urllib.parse.urlencode({
            "includeTabsContent": "true",
            "suggestionsViewMode": "SUGGESTIONS_INLINE",
            "commentsViewMode": "COMMENTS_VIEW_MODE_INCLUDED",
        })
        return self._call("GET", f"{API}{document_id(link)}?{query}")

    def read(self, link: str, from_tab: str = "", from_index: int = 0) -> str:
        return summarise(self.get(link), from_tab=from_tab, from_index=from_index)

    def batch_update(self, link: str, body: dict) -> dict:
        """Send a write as given. Only the poster calls this, after the lock."""
        return self._call("POST", f"{API}{document_id(link)}:batchUpdate", body)

    def write(self, link: str, body: dict) -> str:
        return summarise_write(self.batch_update(link, body))


# -- compact text for the bot -------------------------------------------------

def _paragraphs(content: list) -> list[dict]:
    """Every paragraph in a body, tables and contents included, in order."""
    out: list[dict] = []
    for el in content or []:
        if "paragraph" in el:
            out.append(el)
        elif "table" in el:
            for row in el["table"].get("tableRows", []):
                for cell in row.get("tableCells", []):
                    out.extend(_paragraphs(cell.get("content", [])))
        elif "tableOfContents" in el:
            out.extend(_paragraphs(el["tableOfContents"].get("content", [])))
    return out


def _element_text(pe: dict) -> str:
    if "textRun" in pe:
        return pe["textRun"].get("content", "")
    if "person" in pe:
        return "@" + str(pe["person"].get("personProperties", {}).get("name", "person"))
    if "richLink" in pe:
        return "[" + str(pe["richLink"].get("richLinkProperties", {}).get("title", "link")) + "]"
    end, start = pe.get("endIndex", 0), pe.get("startIndex", 0)
    return "" * max(0, end - start)  # Google's stand-in for an object


def _post(post: dict) -> str:
    who = (post.get("author") or {}).get("displayName") or "someone"
    if post.get("deleted"):
        return f"{who}: (deleted)"
    return f"{who}: {_one_line(post.get('content', ''), 1000)}"


def _tabs(tabs: list) -> list[dict]:
    out = []
    for tab in tabs or []:
        out.append(tab)
        out.extend(_tabs(tab.get("childTabs", [])))
    return out


def summarise(doc: dict, from_tab: str = "", from_index: int = 0,
              limit: int = READ_LIMIT) -> str:
    """The Doc as compact text: positions, tabs, suggestions, comments.

    A long Doc is cut; the cut names the tab and position to read on from
    (positions start again in each tab). Comments and suggestions are
    always listed in full.
    """
    lines = [
        f"title: {doc.get('title', '')}",
        f"revision id: {doc.get('revisionId', '')} (send it as "
        "writeControl.requiredRevisionId)",
        "positions are UTF-16 indexes (as Google counts): [start-end) per "
        "paragraph. Suggested insertions are shown as {+text+}, suggested "
        "deletions as {-text-}, each tagged with its suggestion id.",
    ]
    anchors: dict[str, list] = {}
    suggestions: dict[str, list[str]] = {}
    tabs = _tabs(doc.get("tabs", []))
    if not tabs and "body" in doc:  # read without tabs
        tabs = [{"tabProperties": {"tabId": "", "title": ""},
                 "documentTab": {"body": doc["body"]}}]
    cut_at = None
    size = sum(len(x) + 1 for x in lines)
    tab_ids = [t.get("tabProperties", {}).get("tabId", "") for t in tabs]
    first = tab_ids.index(from_tab) if from_tab in tab_ids else 0
    for number, tab in enumerate(tabs):
        props = tab.get("tabProperties", {})
        dtab = tab.get("documentTab") or {}
        tab_id = props.get("tabId", "")
        skip_to = from_index if number == first else 0
        lines.append(f"\n== tab {tab_id or '(only)'}: {props.get('title', '')}")
        size += len(lines[-1]) + 1
        for anchor_id, anchor in (dtab.get("commentAnchors") or {}).items():
            anchors[anchor_id] = [(tab_id, r.get("startIndex"), r.get("endIndex"))
                                  for r in anchor.get("ranges", [])]
        for el in _paragraphs((dtab.get("body") or {}).get("content", [])):
            start, end = el.get("startIndex", 0), el.get("endIndex", 0)
            parts = []
            for pe in el["paragraph"].get("elements", []):
                text = _element_text(pe).replace("\n", "")  # paragraph end
                run = pe.get("textRun") or pe.get("person") or {}
                ins, dels = run.get("suggestedInsertionIds"), run.get("suggestedDeletionIds")
                where = f"{tab_id or 'tab'} {pe.get('startIndex')}-{pe.get('endIndex')}"
                if ins:
                    for sid in ins:
                        suggestions.setdefault(sid, []).append(f"insert at {where}: {_one_line(text, 200)!r}")
                    text = "{+" + text + "+}[" + ",".join(ins) + "]"
                elif dels:
                    for sid in dels:
                        suggestions.setdefault(sid, []).append(f"delete {where}: {_one_line(text, 200)!r}")
                    text = "{-" + text + "-}[" + ",".join(dels) + "]"
                parts.append(text)
            text = "".join(parts)
            if number < first or end <= skip_to or not text.strip():
                continue
            line = f"[{start}-{end}) {text}"
            size += len(line) + 1
            if size > limit:
                cut_at = start
                break
            lines.append(line)
        if cut_at is not None:
            lines.append(f"\n(cut here to keep this short: read again with "
                         f"from_tab \"{tab_id}\" and from_index {cut_at} for "
                         "the rest)")
            break

    threads = doc.get("suggestions") or []
    lines.append("\n== pending suggestions")
    shown = False
    for t in threads:
        if t.get("status") not in (None, "OPEN", "STATUS_UNSPECIFIED"):
            continue
        sid = t.get("suggestionId", "")
        head = _post(t.get("headPost") or {})
        summary = _one_line(t.get("summaryText", ""), 300)
        lines.append(f"- {sid} by {head.split(':', 1)[0]}: {summary}")
        for where in suggestions.pop(sid, []):
            lines.append(f"    {where}")
        for reply in t.get("replies", []):
            lines.append(f"    reply {_post(reply)}")
        shown = True
    for sid, wheres in suggestions.items():  # marked in the text, no thread
        lines.append(f"- {sid}: " + "; ".join(wheres))
        shown = True
    if not shown:
        lines.append("(none)")

    lines.append("\n== comments (reply with addCommentReply and the comment id)")
    comments = doc.get("comments") or []
    for c in comments:
        cid = c.get("commentId", "")
        where = "; ".join(f"{t or 'tab'} {s}-{e}" for t, s, e in anchors.get(c.get("anchorId", ""), []))
        quote = _one_line(c.get("plainTextQuote", ""), 200)
        lines.append(f"- {cid} [{c.get('status', 'OPEN')}] on {where or 'the whole Doc'}"
                     + (f" quoting {quote!r}" if quote else ""))
        lines.append(f"    {_post(c.get('headPost') or {})}")
        for reply in c.get("replies", []):
            lines.append(f"    reply {_post(reply)}")
    if not comments:
        lines.append("(none)")
    return "\n".join(lines)


def summarise_write(resp: dict) -> str:
    """What Google did with a write, in a few lines."""
    state = resp.get("commentUpdateState")
    if state == "ALL_FAILED_UNKNOWN_REASON":
        raise GdocError(Problem.NOT_SAVED, detail=state)
    created_suggestions: list[str] = []
    for s in resp.get("suggestionResponses") or []:
        created_suggestions.extend((s or {}).get("createdSuggestionIds") or [])
    comments, replies = [], []
    for r in resp.get("replies") or []:
        r = r or {}
        if "insertComment" in r:
            comments.append(((r["insertComment"].get("commentThread") or {})
                             .get("commentId", "?")))
        if "addCommentReply" in r:
            replies.append(((r["addCommentReply"].get("post") or {})
                            .get("postId", "?")))
    revision = (resp.get("writeControl") or {}).get("requiredRevisionId", "")
    return "\n".join([
        "posted.",
        f"suggestions created: {', '.join(created_suggestions) or 'none'}",
        f"comments created: {', '.join(comments) or 'none'}",
        f"replies created: {', '.join(replies) or 'none'}",
        f"new revision id: {revision or 'not given'} (read again before the "
        "next write)",
    ])


# -- command line -------------------------------------------------------------

def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[0] != "login" or argv[1] != "--account":
        print("usage: python3 core/gdoc_client.py login --account <agent account email>",
              file=sys.stderr)
        return 2
    print("Opening the browser. Sign in as the account you named.")
    try:
        login(argv[2])
    except GdocError as e:
        print(e.line, file=sys.stderr)
        return 1
    print("Signed in and saved for the account you named. The council's bots "
          "can now read and comment on Docs shared with it, and read its "
          "mail if you ticked the Gmail box.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
