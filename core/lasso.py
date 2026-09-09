"""lasso — bringing what you have already read and said into a chat.

The council's half of the feature the browser plugin owns (frontends/plugin/
lasso.mjs, and SPEC.md "lasso — bringing what you have read and said into a
chat"). `/lasso <words>` searches everything the reader has; the matches come
back as a card with attach buttons; nothing is attached until they press one;
and an attachment is a FILE the bots read on demand, named by path on every
turn, never a wall of text inlined into the conversation.

THE INDEX IS NOT DUPLICATED, and that is the whole design decision here. The
companion (Node) already indexes the reader's annotated pages, their council
chats and the folders they have named, lazily and cached against mtimes. This
module ASKS IT over HTTP rather than growing a second, differently-ranked
search of its own — because two searches over one machine that disagree is
worse than one search that is sometimes unavailable.

When the companion is not running it IS sometimes unavailable, so there is a
fallback: a plain search over this council's own session transcripts. It is
narrower on purpose (no pages, no watched folders — this process has never had
those), it says so in the card, and it uses the same weights so the ordering a
reader learns from one is the ordering they get from the other.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

#: How many matches a search offers. More than this is a list, not a choice.
LIMIT = 8
#: The matching line shown on a card row.
HIT_MAX = 160
#: How many attachments one chat may carry.
ATTACHMENTS_MAX = 20
#: The envelope block's whole budget; past it the summaries go and paths stay.
BLOCK_MAX = 2500
#: How long to wait on the companion before deciding it is not there.
COMPANION_TIMEOUT = 4.0
SUMMARY_MAX = 400
DIGEST_TEXT_MAX = 400_000

DEFAULT_COMPANION = "http://127.0.0.1:4189"


def companion_base() -> str:
    """Where the browser companion is, if it is anywhere.

    `BOTFERENCE_COMPANION` overrides; otherwise the port the companion has
    always used. Nothing here starts it and nothing here complains when it is
    absent — the fallback below is the answer to that.
    """
    raw = (os.environ.get("BOTFERENCE_COMPANION") or "").strip()
    return (raw or DEFAULT_COMPANION).rstrip("/")


# ── the search ─────────────────────────────────────────────


def _http_json(url: str, payload: Optional[dict] = None) -> Optional[dict]:
    """One request to the companion, or None if it is not there."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"content-type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=COMPANION_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:          # a refusal IS an answer
        try:
            return json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return {"ok": False, "error": f"the companion refused ({e.code})"}
    except Exception:                            # not running, wrong port, no route
        return None


def companion_search(query: str, limit: int = LIMIT) -> Optional[list[dict]]:
    """Ask the companion. None means it is not reachable — not "no matches"."""
    q = urllib.parse.urlencode({"q": query, "limit": limit})
    body = _http_json(f"{companion_base()}/lasso?{q}")
    if not isinstance(body, dict) or not body.get("ok"):
        return None
    rows = body.get("results")
    return rows if isinstance(rows, list) else []


def _terms(query: str) -> list[str]:
    """The words of a query, quotes honoured, deduplicated.

    Deliberately the same shape as lasso.mjs `terms`: two characters minimum,
    at most twelve, a quoted phrase kept whole.
    """
    out: list[str] = []
    for m in re.finditer(r'"([^"]+)"|(\S+)', (query or "").lower()):
        t = re.sub(r"^\W+|\W+$", "", m.group(1) or m.group(2) or "").strip()
        if len(t) >= 2 and t not in out:
            out.append(t)
    return out[:12]


def _count(hay: str, term: str) -> int:
    if not hay or not term:
        return 0
    n, i = 0, hay.find(term)
    while i >= 0 and n < 50:
        n += 1
        i = hay.find(term, i + len(term))
    return n


def score(title: str, body: str, words: list[str]) -> int:
    """Title ×3, body ×1, and every-term-found beats most-terms-found.

    The same weighting lasso.mjs uses (its `marks` class — quotes and comments
    — has no counterpart in a council transcript, so there are two classes here
    and three there). Explainable on purpose: a reader who cannot predict what
    a search will return stops using it.
    """
    if not words:
        return 0
    t, b = (title or "").lower(), (body or "").lower()
    total = matched = 0
    for w in words:
        s = _count(t, w) * 3 + _count(b, w)
        if s:
            matched += 1
        total += s
    if not matched:
        return 0
    return total + (1000 if matched == len(words) else matched * 10)


def _clip(s: str, n: int) -> str:
    t = re.sub(r"\s+", " ", str(s or "")).strip()
    return (t[: n - 1] + "…") if len(t) > n else t


def _hit_line(body: str, words: list[str]) -> str:
    low = (body or "").lower()
    for w in words:
        i = low.find(w)
        if i < 0:
            continue
        start = max(0, i - 60)
        return _clip(("…" if start else "") + body[start:start + HIT_MAX + 20], HIT_MAX)
    return _clip(body, HIT_MAX)


def session_dirs(root: Path) -> list[Path]:
    """Both session layouts, exactly as botference.py and workspace.mjs read them."""
    return [d for d in (root / "work" / "sessions", root / "sessions") if d.is_dir()]


def _transcript_text(payload: dict) -> str:
    entries = payload.get("transcript") or payload.get("room_history") or []
    lines = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        speaker = str(e.get("speaker") or "").lower()
        text = str(e.get("text") or "").strip()
        if not text or speaker == "system":
            continue
        lines.append(f"{speaker or 'someone'}: {text}")
    return "\n".join(lines)


def local_search(root: Path, query: str, limit: int = LIMIT) -> list[dict]:
    """The fallback: this council's own chats, and nothing else.

    Narrower than the companion's search by construction — this process has
    never had the reader's annotated pages or their watched folders — and the
    card says so, because a search that quietly covered less than the reader
    expected is worse than one that admits its range.
    """
    words = _terms(query)
    if not words:
        return []
    rows: list[tuple[int, float, dict]] = []
    seen: set[str] = set()
    for d in session_dirs(Path(root)):
        try:
            names = sorted(p for p in d.iterdir() if p.suffix == ".json" and not p.name.startswith("."))
        except OSError:
            continue
        for p in names:
            sid = p.stem
            if sid in seen:
                continue
            seen.add(sid)
            try:
                payload = json.loads(p.read_text(encoding="utf-8", errors="replace"))
            except Exception:
                continue
            if not isinstance(payload, dict):
                continue
            body = _transcript_text(payload)
            if not body:
                continue
            title = str(payload.get("custom_title") or payload.get("title") or "").strip() \
                or "untitled chat"
            s = score(title, body, words)
            if not s:
                continue
            try:
                mtime = p.stat().st_mtime
            except OSError:
                mtime = 0.0
            rows.append((s, mtime, {
                "kind": "chat",
                "id": sid,
                "title": title,
                "url_or_path": str(p),
                "hit": _hit_line(body, words),
                "when": str(payload.get("updated_at") or payload.get("created_at") or ""),
            }))
    rows.sort(key=lambda r: (-r[0], -r[1]))
    return [r[2] for r in rows[:max(1, limit)]]


@dataclass
class SearchResult:
    query: str
    results: list[dict] = field(default_factory=list)
    #: "companion" — everything the reader has; "local" — this council's chats only.
    source: str = "local"

    @property
    def narrow(self) -> bool:
        return self.source != "companion"


def search(root: Path, query: str, limit: int = LIMIT) -> SearchResult:
    """The companion's index where it is running; this council's chats where not."""
    rows = companion_search(query, limit)
    if rows is not None:
        return SearchResult(query=query, results=rows, source="companion")
    return SearchResult(query=query, results=local_search(root, query, limit), source="local")


# ── a path the reader named ────────────────────────────────


def looks_like_path(s: str) -> bool:
    return bool(re.match(r"^\s*[~/]", str(s or "")))


def resolve_owner_path(raw: str) -> tuple[Optional[Path], str]:
    """`(path, "")` or `(None, why)`.

    The reader may attach any readable file they can name: this runs on their
    own machine at their own request, and a "must be under $HOME" rule would
    refuse the one paper on the external drive. What is refused is a `..` (never
    how a person names a file they are looking at) and anything that is not a
    file.
    """
    s = str(raw or "").strip()
    if not s:
        return None, "no path"
    if ".." in Path(s).parts:
        return None, "that path is not allowed"
    if not (s.startswith("/") or s.startswith("~")):
        return None, "give an absolute path"
    p = Path(s).expanduser()
    if not p.is_file():
        return None, "no such file"
    return p, ""


# ── attaching ──────────────────────────────────────────────


def _slug(s: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")[:60]
    return out or "attachment"


def attachments_dir(root: Path, sid: str) -> Path:
    return Path(root) / ".botference" / "lasso" / re.sub(r"[^\w.-]", "", str(sid))


def _pdftotext(src: Path, chars: int) -> str:
    if not shutil.which("pdftotext"):
        return ""
    try:
        out = subprocess.run(
            ["pdftotext", "-q", "-enc", "UTF-8", "-l", "20", str(src), "-"],
            capture_output=True, text=True, timeout=20,
        ).stdout
    except Exception:
        return ""
    return re.sub(r"\s+", " ", out or "").strip()[:chars]


def local_chat_digest(root: Path, sid: str, dest: Path) -> Optional[dict]:
    """One of this council's own chats, written out as a file the bots can read."""
    for d in session_dirs(Path(root)):
        p = d / f"{sid}.json"
        if not p.is_file():
            continue
        try:
            payload = json.loads(p.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            return None
        title = str(payload.get("custom_title") or payload.get("title") or "").strip() \
            or "untitled chat"
        lines = [f"# {title}", ""]
        pid = str(payload.get("project_id") or "")
        if pid:
            lines.append(f"- project: {pid}")
        lines.append(f"- chat: {payload.get('session_id') or sid}")
        if payload.get("updated_at"):
            lines.append(f"- last spoke: {payload['updated_at']}")
        lines += ["", "## The conversation", ""]
        n = 0
        for e in (payload.get("transcript") or payload.get("room_history") or []):
            if not isinstance(e, dict):
                continue
            text = str(e.get("text") or "").strip()
            if not text:
                continue
            n += 1
            lines += [f"**{str(e.get('speaker') or 'someone').lower()}:** {text}", ""]
        dest.mkdir(parents=True, exist_ok=True)
        out = dest / f"{_slug('chat-' + title)}.md"
        out.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
        return {
            "kind": "chat", "id": sid, "title": title, "path": str(out),
            "summary": _clip(f"A council chat: “{title}”, {n} message{'' if n == 1 else 's'}.",
                             SUMMARY_MAX),
        }
    return None


def local_file_digest(src: Path, dest: Path) -> dict:
    """A file of the reader's own, copied — with its text beside it where a PDF allows."""
    dest.mkdir(parents=True, exist_ok=True)
    slug = _slug("file-" + src.stem)
    copy = dest / f"{slug}{src.suffix.lower()}"
    shutil.copyfile(src, copy)
    sidecar = ""
    if src.suffix.lower() == ".pdf":
        text = _pdftotext(src, DIGEST_TEXT_MAX)
        if text:
            side = dest / f"{slug}.txt"
            side.write_text(text, encoding="utf-8")
            sidecar = str(side)
    try:
        kb = max(1, round(src.stat().st_size / 1024))
    except OSError:
        kb = 1
    tail = (f" Its extracted text is beside it at {sidecar}." if sidecar
            else " Its text could not be extracted on this machine."
            if src.suffix.lower() == ".pdf" else "")
    row = {"kind": "file", "id": str(src), "title": src.name, "path": str(copy),
           "summary": _clip(f"A file of the reader's own: {src.name} ({kb} KB), "
                            f"copied from {src}.{tail}", SUMMARY_MAX)}
    if sidecar:
        row["text_path"] = sidecar
    return row


def companion_attach(sid: str, kind: str, ident: str) -> Optional[dict]:
    """Ask the companion to build the digest, so there is ONE digest writer.

    None when it is not reachable; `{"error": …}` when it refused. A page (an
    annotated document of the reader's) can ONLY come this way — the companion
    is the only thing on this machine that holds those records.
    """
    body = _http_json(f"{companion_base()}/attach",
                      {"sid": sid, "kind": kind, "id": ident})
    if body is None:
        return None
    if not body.get("ok"):
        return {"error": str(body.get("error") or "the companion refused that")}
    att = body.get("attachment")
    return att if isinstance(att, dict) else {"error": "the companion sent nothing back"}


def attach(root: Path, sid: str, kind: str, ident: str) -> dict:
    """Build one attachment for this chat. `{...row}` or `{"error": …}`.

    The companion first, so a page and a chat and a file are all written the
    same way by the same code. Falling back only when it is not there — and a
    PAGE has no fallback, because nothing in this process has ever held the
    reader's annotated documents.
    """
    if kind not in ("page", "chat", "file"):
        return {"error": "unknown kind"}
    if kind == "file":
        p, why = resolve_owner_path(ident)
        if p is None:
            return {"error": why}
        ident = str(p)
    built = companion_attach(sid, kind, ident)
    if built is not None:
        return built
    if kind == "page":
        return {"error": "that page lives in the browser companion, which is not running"}
    dest = attachments_dir(root, sid)
    if kind == "chat":
        row = local_chat_digest(root, str(ident), dest)
        return row or {"error": "no such chat in this council"}
    try:
        return local_file_digest(Path(ident), dest)
    except OSError as e:
        return {"error": f"that file could not be copied ({e.strerror or 'error'})"}


def add_attachment(existing: list[dict], row: dict) -> tuple[list[dict], str]:
    """The record's own rule: no duplicates, at most twenty, oldest first."""
    rows = [a for a in (existing or []) if isinstance(a, dict) and a.get("path")]
    for a in rows:
        if a.get("kind") == row.get("kind") and str(a.get("id")) == str(row.get("id")):
            return rows, ""          # already here; the click has happened
    if len(rows) >= ATTACHMENTS_MAX:
        return rows, (f"this chat already carries {ATTACHMENTS_MAX} attachments "
                      "— detach one first")
    return rows + [row], ""


def detach(existing: list[dict], path_or_index: str) -> tuple[list[dict], Optional[dict]]:
    """Take one off by path or by its 1-based position. The ORIGINAL is never touched."""
    rows = [a for a in (existing or []) if isinstance(a, dict) and a.get("path")]
    want = str(path_or_index or "").strip()
    hit = None
    if want.isdigit():
        i = int(want) - 1
        if 0 <= i < len(rows):
            hit = rows[i]
    if hit is None:
        hit = next((a for a in rows if str(a.get("path")) == want), None)
    if hit is None:
        return rows, None
    # only ever the digest WE wrote: a copy under .botference/lasso is ours to
    # delete, and the reader's own file it came from is not
    p = Path(str(hit.get("path")))
    for candidate in (p, Path(str(hit.get("text_path") or ""))):
        try:
            if candidate.name and ".botference" in candidate.parts and candidate.is_file():
                candidate.unlink()
        except OSError:
            pass
    return [a for a in rows if a is not hit], hit


# ── the envelope ───────────────────────────────────────────

ATTACH_HEADER = (
    "[Attached for this chat — read with your file tool when relevant, "
    "never inline them back:]"
)


def attachments_block(attachments: list[dict], budget: int = BLOCK_MAX) -> str:
    """One line per attachment; past the budget the summaries go, the paths stay.

    Never the contents. An attachment is a FILE the bots open when it matters —
    the same discipline the plugin's page snapshot keeps, and for the same
    reason: a forty-page digest inlined into every turn buries the turn.
    """
    rows = [a for a in (attachments or [])
            if isinstance(a, dict) and a.get("path") and a.get("title")][:ATTACHMENTS_MAX]
    if not rows:
        return ""
    def line(a: dict, with_summary: bool) -> str:
        s = f" — {a['summary']}" if with_summary and a.get("summary") else ""
        return f"- {a['title']} ({a.get('kind', 'file')}) — {a['path']}{s}"
    full = ATTACH_HEADER + "\n" + "\n".join(line(a, True) for a in rows) + "\n"
    if len(full) <= budget:
        return full
    return ATTACH_HEADER + "\n" + "\n".join(line(a, False) for a in rows) + "\n"


# ── a bot asking for a search ──────────────────────────────

LASSO_MARK = "lasso:"
QUERY_MAX = 120
_LASSO_LINE_RE = re.compile(r"^\s*(?:[-*>]\s*)?lasso:\s*(.+)$", re.IGNORECASE)
_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)


def _unwrap(raw: str) -> str:
    line = (raw or "").strip().strip("`").strip()
    line = re.sub(r"^[-*>]\s+", "", line).strip()
    line = re.sub(r"^\*\*(.*)\*\*$", r"\1", line).strip()
    return line


def parse_lasso_request(text: str) -> Optional[str]:
    """The search a bot's reply asked for, or None.

    Same three rules as `watch:` and `file-in:`: a line of its own, the LAST
    one wins, a line inside a code fence is code. It is a request for a SEARCH
    and never for an attachment — the reader gets the matches and decides.
    """
    body = _FENCE_RE.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text or "")
    found: Optional[str] = None
    for raw in body.splitlines():
        m = _LASSO_LINE_RE.match(_unwrap(raw))
        if not m:
            continue
        q = m.group(1).strip().strip("`*_").strip()[:QUERY_MAX]
        if q and _terms(q):
            found = q
    return found


def lasso_note() -> str:
    """What the bots are told about it, in the initial prompt (room_prompts)."""
    return (
        "--- What the user has already read and said ---\n"
        "The user keeps annotated pages, past council chats and papers in "
        "folders of their own. You cannot see any of it, and they have "
        "usually not thought to mention it. If an earlier discussion, a page "
        "they have marked up or a paper of theirs would genuinely settle what "
        "is being asked, END your reply with ONE line of its own reading:\n"
        f"  {LASSO_MARK} <what to look for>\n"
        "A few words, not a sentence; the last such line in a reply wins; a "
        "line inside a code fence is code, not a request. Nothing is read and "
        "nothing is attached by asking — the user gets the matches and "
        "decides. Anything they attach is named on every later turn by its "
        "PATH, and you READ that file with your own tools when it matters; "
        "never ask for its contents to be pasted in. Say nothing at all if "
        "what you need is already in front of you: an unwanted search is a "
        "card the user has to dismiss. They can also search themselves with "
        "/lasso <words>."
    )
