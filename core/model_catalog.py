"""model_catalog.py — the one list of models botference offers.

Two parts:

1. ``BUILTIN``: the hand-kept table. For every model: its id, which bot runs
   it (``claude`` or ``codex``), the context window to assume when the CLI
   does not report one, and its price per million tokens — or ``None`` when
   we do not know the price. Every other table in the app (the context-window
   lookups in ``cli_adapters.py`` / ``providers.py``, ``tools/_pricing.py``,
   the ``/model`` pickers in ``botference.py``) is derived from this one.

2. Discovery: both CLIs keep their own fresh model list on disk
   (Claude Code under ``~/.claude/cache/model-catalog/``, Codex at
   ``~/.codex/models_cache.json``). Those files are other programs'
   undocumented internals, so they are read as untrusted, optional input.
   Each read ends in exactly one of ``SOURCE_STATES``; anything but ``ok``
   means "offer the built-in list only" plus one log line. Nothing here ever
   raises to the caller.

Settings (environment):
  BOTFERENCE_MODEL_DISCOVERY=0      turn discovery off (built-in list only)
  BOTFERENCE_CLAUDE_MODEL_CACHE     path of Claude Code's model list (a file,
                                    or a folder whose newest *.json is used)
  BOTFERENCE_CODEX_MODEL_CACHE      path of Codex's model list
  BOTFERENCE_MODELS_SEEN_FILE       the "already announced" record
                                    (default ~/.botference/models-seen.json)

Nothing in this module changes a bot's default model or switches a room to
a newly found one; it only widens what the pickers offer.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

BOTS = ("claude", "codex")

#: Fallback when neither the built-in table nor a CLI list knows a model.
DEFAULT_CONTEXT_WINDOW = 200_000


# ── Built-in table ───────────────────────────────────────────


@dataclass(frozen=True)
class Price:
    """US dollars per million tokens."""
    input: float
    output: float
    cache_read: float
    cache_create: float

    def as_dict(self) -> dict:
        return {
            "input": self.input, "output": self.output,
            "cache_read": self.cache_read, "cache_create": self.cache_create,
        }


@dataclass(frozen=True)
class ModelEntry:
    id: str
    bot: str                       # one of BOTS
    context_window: Optional[int]  # None: not known (lookup falls back to DEFAULT_CONTEXT_WINDOW)
    price: Optional[Price]         # None: price not known
    name: str = ""                 # display name (from the CLI list, when discovered)
    built_in: bool = True


def _m(id_, bot, window, price=None):
    return ModelEntry(id=id_, bot=bot, context_window=window,
                      price=Price(*price) if price else None)


# Order matters: it is the order the pickers show when no CLI list is read.
# Prices: Anthropic https://docs.anthropic.com/en/docs/about-claude/models,
#         OpenAI https://platform.openai.com/docs/pricing.
# A model with no price here has price "not known" — never guess one.
BUILTIN: tuple[ModelEntry, ...] = (
    # Fable 5.2 (2026-11-09): same tier, 20% cheaper; cache rates assumed at 5.1 ratios
    _m("claude-fable-5-2", "claude", 1_000_000, (8.0, 40.0, 0.2, 10.0)),
    _m("claude-fable-5-1", "claude", 1_000_000, (10.0, 50.0, 0.25, 12.5)),
    _m("claude-fable-5", "claude", 1_000_000, (10.0, 50.0, 1.0, 12.5)),
    # Opus 5.5 (2026-09-22): Fable-5.1-class, cheaper; default effort medium
    _m("claude-opus-5-5", "claude", 1_000_000),
    _m("claude-opus-5", "claude", 1_000_000),
    _m("claude-opus-4-8", "claude", 1_000_000, (15.0, 75.0, 1.5, 18.75)),
    _m("claude-opus-4-6", "claude", 1_000_000, (15.0, 75.0, 1.5, 18.75)),
    _m("claude-opus-4-7", "claude", 1_000_000, (15.0, 75.0, 1.5, 18.75)),
    _m("claude-sonnet-4-6", "claude", 1_000_000, (3.0, 15.0, 0.3, 3.75)),
    _m("claude-haiku-4-5", "claude", 200_000, (0.8, 4.0, 0.08, 1.0)),
    _m("gpt-5-latest", "codex", 272_000),
    _m("gpt-6-astra", "codex", 1_050_000),    # default Codex participant since 2026-09-04
    _m("gpt-6-sol", "codex", 1_050_000),      # GPT-6 Sol (2026-09-22): large; efforts low..max + ultra
    _m("gpt-6-luna", "codex", 1_050_000),     # GPT-6 Luna (2026-09-22): small; efforts low..max
    _m("gpt-5.6-sol", "codex", 1_050_000),
    _m("gpt-5.6-terra", "codex", 1_050_000),
    _m("gpt-5.6-luna", "codex", 1_050_000),
    _m("gpt-5.5", "codex", 258_000),
    # 272k standard; 1.05M experimental (not enabled). GPT-5.4 (high thinking) is the recommended API model
    _m("gpt-5.4", "codex", 272_000, (2.5, 15.0, 0.25, 0)),
    _m("gpt-4o", "codex", 128_000, (2.5, 10.0, 0, 0)),
    _m("gpt-4o-mini", "codex", 128_000, (0.15, 0.6, 0, 0)),
    _m("o3", "codex", 200_000, (10.0, 40.0, 0, 0)),
    _m("o4-mini", "codex", 200_000, (1.1, 4.4, 0, 0)),
)

_BUILTIN_BY_ID = {m.id: m for m in BUILTIN}


def builtin_context_windows() -> dict[str, int]:
    """id -> context window, built-in table only (what ``_CONTEXT_WINDOWS`` was)."""
    return {m.id: m.context_window for m in BUILTIN if m.context_window}


def builtin_prices() -> dict[str, dict]:
    """id -> price dict, only for models whose price is known (what ``PRICING`` was)."""
    return {m.id: m.price.as_dict() for m in BUILTIN if m.price is not None}


def builtin_ids(bot: str) -> list[str]:
    return [m.id for m in BUILTIN if m.bot == bot]


# ── Discovery ────────────────────────────────────────────────

#: What a read of one CLI's model list came to. Exactly one per read:
#:   missing    — no file there: built-in list only;
#:   ok         — parsed, right shape, at least one usable model;
#:   unreadable — there, but not JSON / wrong shape / no usable model.
SOURCE_STATES = ("missing", "ok", "unreadable")

#: An id is passed to a CLI as an argument and shown in the UI: keep it tame.
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]{2,63}$")
_DATED_RE = re.compile(r"^(.+)-(\d{8})$")
_NAME_MAX = 60


@dataclass(frozen=True)
class SourceRead:
    bot: str
    path: Optional[Path]
    state: str                          # one of SOURCE_STATES
    models: tuple[ModelEntry, ...] = ()  # in the CLI's own order; empty unless ok
    reason: str = ""

    def __post_init__(self) -> None:
        if self.state not in SOURCE_STATES:
            raise ValueError(f"unknown source state {self.state!r}")
        if self.state != "ok" and self.models:
            raise ValueError("only an ok read carries models")
        if self.state == "ok" and not self.models:
            raise ValueError("an ok read carries at least one model")


def discovery_enabled() -> bool:
    return os.environ.get("BOTFERENCE_MODEL_DISCOVERY", "").strip() != "0"


def claude_cache_path() -> Path:
    env = os.environ.get("BOTFERENCE_CLAUDE_MODEL_CACHE", "")
    if env:
        return Path(env).expanduser()
    base = os.environ.get("CLAUDE_CONFIG_DIR", "") or str(Path.home() / ".claude")
    return Path(base).expanduser() / "cache" / "model-catalog"


def codex_cache_path() -> Path:
    env = os.environ.get("BOTFERENCE_CODEX_MODEL_CACHE", "")
    if env:
        return Path(env).expanduser()
    base = os.environ.get("CODEX_HOME", "") or str(Path.home() / ".codex")
    return Path(base).expanduser() / "models_cache.json"


def _resolve_file(path: Path) -> Optional[Path]:
    """A file stays itself; a folder means its newest *.json (None if none)."""
    try:
        if path.is_dir():
            files = [p for p in path.glob("*.json") if p.is_file()]
            return max(files, key=lambda p: p.stat().st_mtime) if files else None
        return path if path.exists() else None
    except OSError:
        return None


def _read_json_state(path: Optional[Path]) -> tuple[str, object, str]:
    """(state, value, reason) — same three states as fsjson.mjs readJsonState."""
    if path is None:
        return "missing", None, "no file"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "missing", None, "no file"
    except (OSError, UnicodeDecodeError) as exc:
        return "unreadable", None, f"cannot read: {exc.__class__.__name__}"
    try:
        return "ok", json.loads(text), ""
    except ValueError as exc:
        return "unreadable", None, f"not JSON: {exc}"


def _clean_name(raw: object, fallback: str) -> str:
    if not isinstance(raw, str):
        return fallback
    name = "".join(ch for ch in raw if ch.isprintable()).strip()
    return name[:_NAME_MAX] if name else fallback


def _positive_int(raw: object) -> Optional[int]:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
        return None
    return raw


def _parse_claude(data: object) -> tuple[list[ModelEntry], str]:
    try:
        rows = data["catalog"]["config"]["models"]  # type: ignore[index]
    except (KeyError, TypeError):
        return [], "no catalog.config.models"
    if not isinstance(rows, list):
        return [], "catalog.config.models is not a list"
    raw_ids = [r.get("id") for r in rows if isinstance(r, dict)]
    listed = {i for i in raw_ids if isinstance(i, str)}
    out: list[ModelEntry] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        mid = row.get("id")
        if not isinstance(mid, str) or not _ID_RE.match(mid) or not mid.startswith("claude-"):
            continue
        dated = _DATED_RE.match(mid)
        # claude-haiku-4-5-20251001 is claude-haiku-4-5: offer one, not both
        if dated and (dated.group(1) in _BUILTIN_BY_ID or dated.group(1) in listed):
            mid = dated.group(1)
        if mid in seen:
            continue
        seen.add(mid)
        runtime = row.get("runtime") if isinstance(row.get("runtime"), dict) else {}
        out.append(ModelEntry(
            id=mid, bot="claude",
            context_window=_positive_int(runtime.get("max_input_tokens")),
            price=None, name=_clean_name(row.get("name"), mid), built_in=False,
        ))
    return out, "" if out else "no usable model in the list"


def _parse_codex(data: object) -> tuple[list[ModelEntry], str]:
    rows = data.get("models") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return [], "no models list"
    usable = []
    for pos, row in enumerate(rows):
        if not isinstance(row, dict) or row.get("visibility") != "list":
            continue
        mid = row.get("slug")
        if not isinstance(mid, str) or not _ID_RE.match(mid) or mid.startswith("claude-"):
            continue
        prio = row.get("priority")
        prio = prio if isinstance(prio, (int, float)) and not isinstance(prio, bool) else float("inf")
        usable.append((prio, pos, row, mid))
    usable.sort(key=lambda t: (t[0], t[1]))
    out: list[ModelEntry] = []
    seen: set[str] = set()
    for _prio, _pos, row, mid in usable:
        if mid in seen:
            continue
        seen.add(mid)
        out.append(ModelEntry(
            id=mid, bot="codex",
            context_window=_positive_int(row.get("context_window")),
            price=None, name=_clean_name(row.get("display_name"), mid), built_in=False,
        ))
    return out, "" if out else "no usable model in the list"


_PARSERS = {"claude": _parse_claude, "codex": _parse_codex}


def read_source(bot: str, path: Path) -> SourceRead:
    """Read one CLI's model list. Never raises."""
    try:
        file = _resolve_file(path)
        state, data, reason = _read_json_state(file)
        if state != "ok":
            return SourceRead(bot, file or path, state, (), reason)
        models, reason = _PARSERS[bot](data)
        if not models:
            return SourceRead(bot, file, "unreadable", (), reason)
        return SourceRead(bot, file, "ok", tuple(models))
    except Exception as exc:  # untrusted input: never take the app down
        return SourceRead(bot, path, "unreadable", (), f"{exc.__class__.__name__}: {exc}")


_logged: set[tuple] = set()
_cache: dict[tuple, dict[str, SourceRead]] = {}


def _fingerprint(path: Path) -> tuple:
    f = _resolve_file(path)
    try:
        return (str(path), str(f), f.stat().st_mtime_ns if f else None)
    except OSError:
        return (str(path), str(f), None)


def discover() -> dict[str, SourceRead]:
    """Read both CLI lists (cached while the files are unchanged).

    Returns {} when discovery is turned off. Never raises.
    """
    if not discovery_enabled():
        return {}
    paths = {"claude": claude_cache_path(), "codex": codex_cache_path()}
    key = tuple(_fingerprint(p) for p in paths.values())
    reads = _cache.get(key)
    if reads is None:
        reads = {bot: read_source(bot, p) for bot, p in paths.items()}
        _cache.clear()
        _cache[key] = reads
    for r in reads.values():
        if r.state != "ok" and (r.bot, str(r.path), r.state) not in _logged:
            _logged.add((r.bot, str(r.path), r.state))
            log.warning(
                "model discovery: %s model list is %s (%s)%s; offering the built-in list only",
                r.bot, r.state, r.path, f": {r.reason}" if r.reason else "",
            )
    return reads


def offered_models(bot: str) -> list[ModelEntry]:
    """What the pickers offer for *bot*, in order.

    Built-in entries always win (their numbers stay). When the CLI's list was
    read ok: the CLI's own order first, then built-ins it does not list.
    Otherwise: the built-in order.
    """
    builtins = [m for m in BUILTIN if m.bot == bot]
    read = discover().get(bot)
    if read is None or read.state != "ok":
        return builtins
    out: list[ModelEntry] = []
    seen: set[str] = set()
    for m in read.models:
        builtin = _BUILTIN_BY_ID.get(m.id)
        if builtin is not None and builtin.bot != bot:
            continue  # another bot's model: never offer it here
        # a built-in keeps its own numbers; only the CLI's display name is borrowed
        out.append(replace(builtin, name=m.name) if builtin else m)
        seen.add(m.id)
    out.extend(m for m in builtins if m.id not in seen)
    return out


def offered_ids(bot: str) -> list[str]:
    return [m.id for m in offered_models(bot)]


def lookup(model: str) -> Optional[ModelEntry]:
    """The entry for *model*: built-in first, then a discovered one."""
    if model in _BUILTIN_BY_ID:
        return _BUILTIN_BY_ID[model]
    for read in discover().values():
        for m in read.models:
            if m.id == model:
                return m
    return None


def context_window(model: str, default: int = DEFAULT_CONTEXT_WINDOW) -> int:
    entry = lookup(model)
    return entry.context_window if entry and entry.context_window else default


def price_of(model: str) -> Optional[Price]:
    """The price, or None when not known (never a stand-in model's price)."""
    entry = _BUILTIN_BY_ID.get(model)
    return entry.price if entry else None


def context_disagreements() -> list[tuple[str, int, int]]:
    """(id, built-in window, CLI window) wherever a CLI list disagrees."""
    out = []
    for read in discover().values():
        for m in read.models:
            b = _BUILTIN_BY_ID.get(m.id)
            if b and m.context_window and b.context_window and m.context_window != b.context_window:
                out.append((m.id, b.context_window, m.context_window))
    return out


# ── "New model on offer" record ──────────────────────────────


def models_seen_file() -> Path:
    env = os.environ.get("BOTFERENCE_MODELS_SEEN_FILE", "")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".botference" / "models-seen.json"


def _write_atomic(path: Path, payload: dict) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2)
                fh.write("\n")
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return True
    except OSError as exc:
        log.warning("could not write %s: %s", path, exc)
        return False


def _label(m: ModelEntry) -> str:
    return f"{m.name} ({m.id})" if m.name and m.name != m.id else m.id


def new_model_notice() -> str:
    """One plain sentence naming models on offer that were never announced,
    or "" when there is nothing new. Records what it announces.

    No record yet: seed it silently with everything on offer (first run says
    nothing). Record unreadable: say nothing and leave it alone. Never raises.
    """
    try:
        offered = [m for bot in BOTS for m in offered_models(bot)]
        path = models_seen_file()
        state, data, reason = _read_json_state(path)
        if state == "ok" and not (
            isinstance(data, dict) and isinstance(data.get("seen"), list)
            and all(isinstance(x, str) for x in data["seen"])
        ):
            state, reason = "unreadable", "wrong shape"
        if state == "unreadable":
            log.warning("model notice: %s is unreadable (%s); not announcing, not overwriting",
                        path, reason)
            return ""
        if state == "missing":
            _write_atomic(path, {"version": 1, "seen": [m.id for m in offered]})
            return ""
        seen = list(data["seen"])  # type: ignore[index]
        known = set(seen)
        new = [m for m in offered if m.id not in known]
        if not new:
            return ""
        if not _write_atomic(path, {"version": 1, "seen": seen + [m.id for m in new]}):
            return ""  # could not record it: stay quiet rather than repeat it every start
        labels = [_label(m) for m in new]
        if len(labels) == 1:
            return f"New model on offer: {labels[0]}. Pick it from the model menu."
        listed = ", ".join(labels[:-1]) + f" and {labels[-1]}"
        return f"New models on offer: {listed}. Pick them from the model menu."
    except Exception as exc:  # never let a notice take start-up down
        log.warning("model notice skipped: %s", exc)
        return ""
