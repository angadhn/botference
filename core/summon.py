"""Summoning a build agent on a bot's behalf.

The bots in a botference chat talk with the reader and shape the work; they
do not build the deliverable themselves. When one of them decides it has
enough, its reply ends with a brief on a line of its own::

    summon: build the landing page from the outline above — one HTML file,
      dark theme, save it under projects/acta/artifacts/

Botference reads that line and starts a fresh agent (by default Claude Code
on Opus 5.5) in the project folder with the brief and the room's recent
history. The agent reports back; the summoner is woken with the report.

This module is the pure part: parsing the line, resolving which agent to
run from ``context-budgets.json``, and composing the agent's prompt. The
running and the room events live in ``botference.py``.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Optional

from video_watch import _FENCE_RE, _unwrap_line

# `summon:` on a line of its own (light markdown tolerated), the brief after
# it. Continuation lines — indented, or plain text up to the first blank
# line — belong to the brief, so a bot may write a short paragraph.
_SUMMON_LINE_RE = re.compile(r"^summon\s*:\s*(.*)$", re.IGNORECASE)

# The default builder. Opus 5.5 is the model the reader asked for; `high`
# because its own default (`medium`) is tuned for conversation, not for a
# build that gets one shot.
DEFAULT_BUILDER = {
    "cli": "claude",
    "model": "claude-opus-5-5",
    "effort": "high",
    "timeout_s": 900,
}

#: One summon per bot per user turn. A bot that wants more should say so and
#: let the reader ask. Same shape as the Gemini question budget.
SUMMON_BUDGET = 1


def parse_summon_request(text: str) -> Optional[str]:
    """The brief a bot's reply asked to have built, or None.

    The first ``summon:`` line wins (a reply is one decision, not several),
    a line inside a code fence is code, and a brief that says nothing is no
    brief.
    """
    body = _FENCE_RE.sub(" ", text or "")
    lines = body.splitlines()
    for i, raw in enumerate(lines):
        m = _SUMMON_LINE_RE.match(_unwrap_line(raw))
        if not m:
            continue
        parts = [m.group(1).strip()]
        for cont in lines[i + 1:]:
            if not cont.strip():
                break
            stripped = _unwrap_line(cont)
            # a footer, a new request, or another marker line ends the brief
            if stripped.startswith("{") or re.match(
                r"^(summon|watch|ask gemini|lasso|artifact)\s*:", stripped, re.I
            ):
                break
            parts.append(stripped)
        brief = " ".join(p for p in parts if p).strip().strip("`*_")
        return brief or None
    return None


def strip_summon_line(text: str) -> str:
    """The reply with its ``summon:`` line left in place.

    Kept as a function so the display policy has one home: the line stays,
    because it is honest about what was asked for (the same rule as
    ``watch:``). The agent card under the message shows what came of it.
    """
    return text


def _load_budgets(botference_home: Path | None) -> dict:
    if botference_home is None:
        return {}
    path = Path(botference_home) / "context-budgets.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def builder_spec(summoner: str, botference_home: Path | None = None) -> dict:
    """Which agent to run for a summon from *summoner*.

    ``context-budgets.json`` may carry::

        "builder": {"cli": "claude", "model": "claude-opus-5-5",
                    "effort": "high", "timeout_s": 900,
                    "for": {"codex": {"cli": "codex", "model": "gpt-6-sol",
                                      "effort": "xhigh"}}}

    The per-summoner entry under ``for`` overrides the top level, so Codex's
    summons can go to a Codex builder while Claude's go to Opus. Environment
    overrides (``BOTFERENCE_BUILDER_MODEL`` / ``_EFFORT`` / ``_CLI``) win over
    the file, for a one-off run.
    """
    spec = dict(DEFAULT_BUILDER)
    cfg = _load_budgets(botference_home).get("builder")
    if isinstance(cfg, dict):
        spec.update({k: v for k, v in cfg.items() if k != "for" and v})
        per = cfg.get("for")
        if isinstance(per, dict) and isinstance(per.get(summoner), dict):
            spec.update({k: v for k, v in per[summoner].items() if v})
    for key, env in (("cli", "BOTFERENCE_BUILDER_CLI"),
                     ("model", "BOTFERENCE_BUILDER_MODEL"),
                     ("effort", "BOTFERENCE_BUILDER_EFFORT")):
        val = os.environ.get(env, "").strip()
        if val:
            spec[key] = val
    spec["cli"] = "codex" if str(spec.get("cli", "")).lower() == "codex" else "claude"
    try:
        spec["timeout_s"] = int(spec.get("timeout_s") or DEFAULT_BUILDER["timeout_s"])
    except (TypeError, ValueError):
        spec["timeout_s"] = DEFAULT_BUILDER["timeout_s"]
    return spec


def builder_label(spec: dict) -> str:
    """`Claude Opus 5.5 (high)` — what the reader sees in the card header."""
    model = str(spec.get("model", ""))
    pretty = model
    m = re.match(r"^claude-([a-z]+)-(\d+)(?:-(\d+))?$", model)
    if m:
        pretty = f"Claude {m.group(1).capitalize()} {m.group(2)}" + (
            f".{m.group(3)}" if m.group(3) else "")
    m = re.match(r"^gpt-([\d.]+)-([a-z]+)$", model)
    if m:
        pretty = f"GPT-{m.group(1)} {m.group(2).capitalize()}"
    effort = str(spec.get("effort", "")).strip()
    return f"{pretty} ({effort})" if effort else pretty


def builder_prompt(
    *, brief: str, summoner: str, history: str, artifacts_dir: str,
    project_root: str, deliverables_note: str = "",
) -> str:
    """The whole of what the build agent is told.

    It is one turn with no follow-up, so everything it needs is here: who
    asked and why, the brief, where the deliverable goes, how to report.
    """
    who = summoner.capitalize()
    return "\n\n".join(p for p in [
        "--- You are a build agent ---",
        f"You were summoned by {who}, one of two bots discussing a piece of "
        "work with a human reader in a botference chat. They shaped the idea; "
        "you build it. You have one turn and nobody will answer questions, so "
        "decide and proceed. Do not summon anyone yourself.",
        f"--- The brief (from {who}) ---\n{brief}",
        "--- Where things go ---\n"
        f"Working directory: {project_root}\n"
        f"Save the deliverable under `{artifacts_dir}/` (create it if needed). "
        "One self-contained file where that is possible — an HTML page carries "
        "its own styles and scripts, reads well in light and dark, and sets its "
        "own background. Never start a server or a tunnel.",
        deliverables_note,
        "--- How to report ---\n"
        "When you are done, reply in at most eight short lines: what you built, "
        "where it is, what you left out or could not do. Then END with one line "
        "of its own reading `artifact: <path relative to the workspace root>` "
        "for each file the reader should open — a path that names no file on "
        "disk is ignored. No JSON footer.",
        f"--- The room, most recent turns ---\n{history}" if history else "",
    ] if p)
