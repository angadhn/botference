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

from room_prompts import PROPORTIONATE_TESTS_RULE
from video_watch import _FENCE_RE, _unwrap_line

# `summon:` on a line of its own (light markdown tolerated), the brief after
# it. Continuation lines — indented, or plain text up to the first blank
# line — belong to the brief, so a bot may write a short paragraph.
_SUMMON_LINE_RE = re.compile(r"^summon\s*:\s*(.*)$", re.IGNORECASE)

# The default builder. Opus 5.5 is the model the reader asked for; `high`
# because its own default (`medium`) is tuned for conversation, not for a
# build that gets one shot. `timeout_s` 0 means NO cap: a build runs until it
# is done, the way a sub-agent does — the reader can always press stop.
DEFAULT_BUILDER = {
    "cli": "claude",
    "model": "claude-opus-5-5",
    "effort": "high",
    "timeout_s": 0,
    # Commands a build agent runs OUTSIDE its sandbox. The macOS sandbox hides
    # the GPU from everything inside it, and Blender's only GPU backend here
    # is Metal, so a render inside the sandbox crashes at start-up. Listing a
    # command here is the documented Claude Code way out (sandbox
    # excludedCommands); keep the list to tools that need the hardware.
    "unsandboxed_commands": ["blender *"],
}

#: One summon per bot per user turn. A bot that wants more should say so and
#: let the reader ask. Same shape as the Gemini question budget.
SUMMON_BUDGET = 1


#: Kind tags a brief may open with, and the task each one names. The tag
#: decides the builder whoever summoned it: `[ui]` (anything a person sees)
#: goes to Claude Code on Opus, `[logic]` (behaviour: controller code,
#: adapters, parsing, protocols, shell) to Codex. That is how the two
#: subscriptions share a long build. No tag keeps the summoner's own default.
_TASK_TAGS = ("imagegen", "ui", "logic")
_TASK_TAG_RE = re.compile(r"^\s*\[(imagegen|ui|logic)\](?:\s|$)", re.I)

#: The builder each tag runs when context-budgets.json says nothing about it
#: (`builder.tasks.<tag>` may change cli, model, effort and timeout_s).
#: "codex" as the model means the room's own Codex model.
_TASK_DEFAULTS = {
    "imagegen": {"cli": "codex", "model": "codex", "effort": "high"},
    "ui": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"},
    "logic": {"cli": "codex", "model": "codex", "effort": "high"},
}


def builder_task(brief: str) -> str:
    """The bot explicitly selects the capability; topic words do not route jobs."""
    m = _TASK_TAG_RE.match(brief or "")
    return m.group(1).lower() if m else "build"


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


def builder_spec(summoner: str, botference_home: Path | None = None, *,
                 task: str = "build", codex_model: str = "gpt-6-astra") -> dict:
    """Which agent to run for a summon from *summoner*.

    ``context-budgets.json`` may carry::

        "builder": {"cli": "claude", "model": "claude-opus-5-5",
                    "effort": "high", "timeout_s": 900,
                    "for": {"codex": {"cli": "codex", "model": "gpt-6-sol",
                                      "effort": "xhigh"}}}

    The per-summoner entry under ``for`` overrides the top level, so Codex's
    summons can go to a Codex builder while Claude's go to Opus. Environment
    overrides (``BOTFERENCE_BUILDER_MODEL`` / ``_EFFORT`` / ``_CLI``) win over
    the file, for a one-off run. The explicit ``imagegen`` task uses Codex and
    the room's Codex model, with separate optional ``builder.tasks.imagegen``
    overrides for model/effort/timeout; general Opus settings do not apply.
    The ``ui`` and ``logic`` tasks work the same way: ``[ui]`` runs Claude
    Code on Opus 5.5 and ``[logic]`` runs Codex on the room's Codex model,
    each overridable (cli too) under ``builder.tasks.ui`` / ``.logic``.
    """
    spec = dict(DEFAULT_BUILDER)
    cfg = _load_budgets(botference_home).get("builder")
    if task in _TASK_TAGS:
        # A tagged brief names its builder. General builder settings and the
        # per-summoner `for` entries must not silently defeat the route (an
        # Opus override would turn every [logic] build back into Claude), so
        # only `builder.tasks.<tag>` may change it. Image generation is a
        # Codex-only tool, so its cli is not open to change.
        base = _TASK_DEFAULTS[task]
        spec = {"cli": base["cli"], "model": base["model"], "effort": base["effort"],
                "timeout_s": 0, "task": task,
                "unsandboxed_commands": list(DEFAULT_BUILDER["unsandboxed_commands"])
                if base["cli"] == "claude" else []}
        tasks = cfg.get("tasks", {}) if isinstance(cfg, dict) else {}
        own = tasks.get(task, {}) if isinstance(tasks, dict) else {}
        keys = ("model", "effort", "timeout_s") if task == "imagegen" else (
            "cli", "model", "effort", "timeout_s")
        if isinstance(own, dict):
            spec.update({k: own[k] for k in keys if own.get(k) is not None})
        spec["cli"] = "codex" if str(spec.get("cli", "")).lower() == "codex" else "claude"
        if spec["model"] == "codex":
            spec["model"] = codex_model
        if spec["cli"] == "codex":
            spec["unsandboxed_commands"] = []
        try:
            spec["timeout_s"] = max(0, int(spec.get("timeout_s") or 0))
        except (TypeError, ValueError):
            spec["timeout_s"] = 0
        return spec
    if isinstance(cfg, dict):
        spec.update({k: v for k, v in cfg.items() if k not in ("for", "tasks") and v})
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
        spec["timeout_s"] = max(0, int(spec.get("timeout_s") or 0))
    except (TypeError, ValueError):
        spec["timeout_s"] = 0
    raw = spec.get("unsandboxed_commands")
    spec["unsandboxed_commands"] = [str(x) for x in raw if str(x).strip()] if isinstance(raw, list) else []
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
    project_root: str, deliverables_note: str = "", unsandboxed: list[str] | None = None,
    artifacts_link: str = "", task: str = "build",
) -> str:
    """The whole of what the build agent is told.

    It is one turn with no follow-up, so everything it needs is here: who
    asked and why, the brief, where the deliverable goes, how to report.

    An absolute *artifacts_dir* is a browser-plugin blog or book lane: the
    folder is the site's own scratch, *deliverables_note* carries the
    placement rule (a finished picture goes into the page's image folder,
    scratch goes here, nothing is left for the reader to copy), and a file is
    reported by its absolute path and linked under *artifacts_link*.
    """
    who = summoner.capitalize()
    absolute = Path(artifacts_dir).is_absolute()
    report_as = ("its absolute path" if absolute
                 else "<path relative to the workspace root>")
    link_line = (f" Link a file of `{artifacts_dir}/` in your report as "
                 f"`{artifacts_link}/<name>`." if absolute and artifacts_link else "")
    return "\n\n".join(p for p in [
        "--- You are a build agent ---",
        f"You were summoned by {who}, one of two bots discussing a piece of "
        "work with a human reader in a botference chat. They shaped the idea; "
        "you build it. You have one turn and nobody will answer questions, so "
        "decide and proceed. Do not summon anyone yourself.",
        f"--- The brief (from {who}) ---\n{brief}",
        ("--- Generative image task ---\n"
         "Use $imagegen and the built-in image_gen tool to create or edit the "
         "requested raster artwork. Read the imagegen skill if available. "
         "Do not substitute SVG, hand-drawn code, stock images, or an API-key "
         "workflow for the requested generative image. If the built-in tool "
         "is unavailable, report that blocker and stop. For a local reference "
         "image, view it before editing. Copy the actual generated output into "
         "the destination specified below; do not leave a project asset only "
         "under Codex's generated_images directory. Verify that the final file "
         "exists and inspect it before reporting its path. Preserve existing "
         "assets unless replacement was requested. Image generation is not a "
         "way to recreate measurements, redraw a published chart, or bypass "
         "an unavailable source image. Do not generate substitutes for those."
         if task == "imagegen" else ""),
        ("--- Hardware ---\n"
         "These commands run outside your sandbox, with the GPU: "
         + ", ".join(f"`{c}`" for c in unsandboxed) + ". Call them directly "
         "(not through a shell script or `sh run.sh`, which stays sandboxed "
         "and sees no GPU). Everything else is sandboxed as usual."
         if unsandboxed else ""),
        ("--- Where things go ---\n"
         f"Working directory: {project_root}\n"
         "This is a change to the project's own code: edit its files in place "
         "and run its tests. Put scratch, if any, under "
         f"`{artifacts_dir}/`. Never start a server or a tunnel, and never "
         "commit or push unless the brief asks."
         if task in ("ui", "logic") else
        "--- Where things go ---\n"
        f"Working directory: {project_root}\n"
        + (f"Save scratch and anything that is not a finished picture for a page "
           f"under `{artifacts_dir}/` (create it if needed). " if absolute else
           f"Save the deliverable under `{artifacts_dir}/` (create it if needed). ")
        + "One self-contained file where that is possible — an HTML page carries "
        "its own styles and scripts, reads well in light and dark, and sets its "
        "own background. Never start a server or a tunnel."),
        deliverables_note,
        ("--- Tests ---\n" + PROPORTIONATE_TESTS_RULE if task != "imagegen" else ""),
        "--- How to report ---\n"
        "When you are done, reply in at most eight short lines: what you built, "
        "where it is, what you left out or could not do. Then END with one line "
        f"of its own reading `artifact: {report_as}` "
        "for each file the reader should open — a path that names no file on "
        "disk is ignored. No JSON footer." + link_line,
        f"--- The room, most recent turns ---\n{history}" if history else "",
    ] if p)
