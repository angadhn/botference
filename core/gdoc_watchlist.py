#!/usr/bin/env python3
"""The list of Google Docs the Doc-comment watcher looks at, and its files.

Stdlib only, so the poster (core/gdoc_mcp.py, started with `python3 -I`)
can use it. The poster's `read_doc` calls `note_read()`: every Doc a bot
reads is watched. The watcher (core/gdoc_watch.py) calls `note_answered()`
after a bot answered a comment there, and `watched_docs()` to get the list.
A Doc drops off the list `KEEP_DAYS` days after the later of the two.

Files, all in the watcher's own folder, outside the Google sign-in folder
(folder mode 0700, files 0600):

    ~/.botference/gdoc-watch/docs.json     the watch list: Doc id, title,
                                           last read, last answered
    ~/.botference/gdoc-watch/config.json   the owner's settings (allowed people)
    ~/.botference/gdoc-watch/state.json    what the watcher has seen and done

A file that cannot be read is never saved over: `WatchFileDamaged` names it.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
import time
from pathlib import Path

#: The watcher's folder. The environment variable exists for tests; the
#: launch never sets it.
HOME_ENV = "BOTFERENCE_GDOC_WATCH_HOME"
DEFAULT_HOME = Path.home() / ".botference" / "gdoc-watch"

#: A Doc is watched for this long after a bot last read it or last answered
#: a comment in it.
KEEP_DAYS = 14
KEEP_SECONDS = KEEP_DAYS * 24 * 3600


class WatchFileDamaged(Exception):
    """A watcher file exists but cannot be read. It is left as it is."""

    def __init__(self, path: Path, detail: str):
        self.path = path
        super().__init__(
            f"the Doc watcher's file {path} cannot be read ({detail}); it is "
            "left as it is. Fix it or delete it.")


def watch_home() -> Path:
    return Path(os.environ.get(HOME_ENV) or DEFAULT_HOME)


def ensure_home(home: Path) -> None:
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(home, 0o700)


@contextlib.contextmanager
def locked(home: Path, name: str):
    """One writer at a time for the file `name` (both bots' posters and the
    watcher write the watch list)."""
    ensure_home(home)
    with open(home / f".{name}.lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def read_json(path: Path, default: dict) -> dict:
    """The file's object; `default` if it does not exist. Raises
    WatchFileDamaged if it exists but is not a JSON object."""
    if not path.exists():
        return json.loads(json.dumps(default))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise WatchFileDamaged(path, type(e).__name__) from None
    if not isinstance(data, dict):
        raise WatchFileDamaged(path, "it is not a JSON object")
    return data


def write_json(path: Path, data: dict) -> None:
    """Write the file whole (temp file, then rename), mode 0600."""
    ensure_home(path.parent)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}-",
                               suffix=".json")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _docs_file(home: Path) -> Path:
    return home / "docs.json"


def _load_docs(home: Path) -> dict:
    data = read_json(_docs_file(home), {"docs": {}})
    if not isinstance(data.get("docs"), dict):
        raise WatchFileDamaged(_docs_file(home), "it has no 'docs' object")
    return data


def last_active(entry: dict) -> float:
    def num(key: str) -> float:
        value = entry.get(key)
        return float(value) if isinstance(value, (int, float)) else 0.0
    return max(num("last_read"), num("last_answered"))


def note_read(doc_id: str, title: str, now: float | None = None,
              home: Path | None = None) -> None:
    """A bot read this Doc through the poster: watch it (again)."""
    home = home or watch_home()
    now = time.time() if now is None else now
    with locked(home, "docs"):
        data = _load_docs(home)
        entry = data["docs"].setdefault(doc_id, {})
        entry["title"] = str(title or "")[:200]
        entry["last_read"] = now
        write_json(_docs_file(home), data)


def note_answered(doc_id: str, now: float | None = None,
                  home: Path | None = None) -> None:
    """A bot answered a comment in this Doc: keep watching it."""
    home = home or watch_home()
    now = time.time() if now is None else now
    with locked(home, "docs"):
        data = _load_docs(home)
        if doc_id in data["docs"]:
            data["docs"][doc_id]["last_answered"] = now
            write_json(_docs_file(home), data)


def watched_docs(now: float | None = None, home: Path | None = None,
                 save: bool = True) -> dict[str, dict]:
    """The Docs being watched now, by id. Docs whose time is up are dropped
    from the list (and the file, when `save`)."""
    home = home or watch_home()
    now = time.time() if now is None else now
    with locked(home, "docs"):
        data = _load_docs(home)
        keep = {doc_id: entry for doc_id, entry in data["docs"].items()
                if isinstance(entry, dict)
                and now - last_active(entry) < KEEP_SECONDS}
        if save and keep != data["docs"]:
            data["docs"] = keep
            write_json(_docs_file(home), data)
    return keep
