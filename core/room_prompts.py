"""
room_prompts.py — Prompt templates for botference mode.

Layered prompt composition (per plan Prompt Composition):
1. Base room preamble — "You are {name} in a shared planning room..."
2. Free-form room protocol — footer-driven handoffs between the bots
3. Writer preamble — lead drafting to temp artifact
4. Reviewer preamble — review/critique instructions
"""

from __future__ import annotations

from pathlib import Path

# -- Skills -----------------------------------------------------------------

_SKILL_DIRS_BY_MODEL = {
    "claude": (".claude/skills", ".agents/skills"),
    "codex": (".agents/skills", ".claude/skills"),
}


def _frontmatter_fields(path: Path) -> dict[str, str]:
    """Parse the small SKILL.md frontmatter subset used for discovery."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}

    fields: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if not sep:
            continue
        key = key.strip()
        if key in {"name", "description"}:
            fields[key] = value.strip().strip("'\"")
    return fields


def project_skill_context(model: str, roots: list[str | Path]) -> str:
    """Return prompt text listing repo-local skills available to a model."""
    model_key = model.lower()
    skill_dirs = _SKILL_DIRS_BY_MODEL.get(
        model_key,
        (".agents/skills", ".claude/skills"),
    )
    seen: set[str] = set()
    entries: list[tuple[str, str, Path]] = []

    for root in roots:
        root_path = Path(root).resolve()
        for skill_dir in skill_dirs:
            base = root_path / skill_dir
            if not base.is_dir():
                continue
            for skill_md in sorted(base.glob("*/SKILL.md")):
                fields = _frontmatter_fields(skill_md)
                name = fields.get("name") or skill_md.parent.name
                if name in seen:
                    continue
                seen.add(name)
                entries.append((name, fields.get("description", ""), skill_md))

    if not entries:
        return ""

    lines = [
        "--- Project Skills ---",
        "Repo-local skills are available. When the user explicitly names a skill "
        "or their request matches a skill description, read that SKILL.md before "
        "responding and follow it for the current turn.",
    ]
    for name, description, path in entries:
        detail = f": {description}" if description else ""
        lines.append(f"- {name}{detail} Read `{path}`.")
    return "\n".join(lines)


# -- Free-form room protocol -------------------------------------------------

FREE_FORM_FOOTER_SCHEMA = (
    '{"status": "continuing|converged|blocked", '
    '"next": "@claude|@codex|@user", '
    '"writer": "@claude|@codex (optional)", '
    '"summary": "one-line state update"}'
)


def free_form_protocol(name: str, other: str) -> str:
    """Room-preamble extension for free-form (mention-driven) mode.

    In free-form mode a bot's reply can hand the floor to the other bot,
    who then replies in the same room, recursively, until someone hands
    the floor back to the user or the thread budget runs out.
    """
    return (
        "--- Free-form room protocol ---\n"
        f"This room is free-form: you and {other} may talk directly to each "
        "other without waiting for the user.\n"
        f"End EVERY response with a JSON footer on its own line:\n"
        f"{FREE_FORM_FOOTER_SCHEMA}\n"
        f'- "next": "@{other.lower()}" hands the floor to {other}, who will '
        "reply to you immediately. Use it when their input would genuinely "
        "improve the plan.\n"
        '- "next": "@user" (or omitting the footer) returns the floor to the '
        "user. Use it when you need a human decision or the thread has "
        "converged.\n"
        '- "status": "converged" when you both agree, "blocked" when you '
        'cannot make progress without the user, otherwise "continuing".\n'
        '- "writer": include it only once you have a view on who should '
        "draft the implementation plan. When you both name the same writer, "
        "the lead is set automatically (the user can override with /lead).\n"
        "Discussion discipline:\n"
        f"- Do not agree with {other} without adding something new — if you "
        "have nothing to add, mark converged and hand to @user.\n"
        f"- Before accepting {other}'s proposal, name its weakest point.\n"
        "- Keep each turn terse and precise: your position, the reason, and "
        "one open question. No restating what was already said.\n"
        "- The bot-to-bot thread has a turn and token budget shown to you "
        "each turn; pace the discussion so it converges within it."
    )


def adopt_room_note(name: str, other: str, writable_roots: str) -> str:
    """Transcript note for a native CLI chat adopted into the council.

    The adopted session never saw the botference initial prompt, so this
    note carries the room context, the free-form protocol, and the
    handoff request that briefs the other participant.
    """
    return (
        f"[This conversation has been connected to a shared planning room "
        f"(botference). You are {name}; the room also has {other} (another "
        f"AI) and the human user you have been talking to.\n"
        f"{free_form_protocol(name, other)}\n"
        f"Room write rules now apply: only write inside these roots: "
        f"{writable_roots}.\n"
        f"First task: write a concise handoff so {other} can join this "
        "conversation mid-stream — the goal, decisions made, current "
        "state, and open questions. Then hand the floor back to @user.]"
    )


def free_form_resume_note() -> str:
    """One-time transcript note for sessions resumed into free-form mode.

    Resumed chats keep their native CLI sessions, so the models never saw
    the free-form section of the initial prompt — this note reaches them
    through the shared transcript instead.
    """
    return (
        "[Free-form mode is active. You and the other AI participant may "
        "hand each other the floor: end EVERY response with a JSON footer "
        f"{FREE_FORM_FOOTER_SCHEMA} — "
        '"next": "@claude" or "@codex" gives the other bot the floor '
        'immediately; "@user" (or no footer) returns it to the user. '
        "Keep turns terse; bot-to-bot threads are budgeted.]"
    )


def free_form_turn_status(
    turns_used: int,
    max_turns: int,
    tokens_used: int,
    token_budget: int,
    *,
    last_turn_tokens: int = 0,
    nudge_threshold: int = 0,
) -> str:
    """Per-turn budget countdown injected before each bot-to-bot dispatch."""
    lines = [
        f"[Free-form thread: bot turn {turns_used} of {max_turns}, "
        f"~{tokens_used} of {token_budget} output tokens used. "
        "When the budget is exhausted the floor returns to the user.]"
    ]
    if nudge_threshold and last_turn_tokens > nudge_threshold:
        lines.append(
            f"[Your last reply was ~{last_turn_tokens} output tokens; "
            f"cap this one at ~{int(nudge_threshold * 0.75)}.]"
        )
    lines.append(
        f"[End your reply with the room footer: {FREE_FORM_FOOTER_SCHEMA}]"
    )
    return "\n".join(lines)


# -- Web access fallback ------------------------------------------------------


def web_access_note(model: str) -> str:
    """Model-specific web-access guidance for the initial prompt.

    Claude Code's WebFetch is blocked by some sites (e.g. Wikimedia returns
    403 / anti-bot errors, or domain verification fails); the Codex CLI
    fetches the same URLs fine, so only the Claude participant needs the
    curl fallback.
    """
    if model.lower() != "claude":
        return ""
    return (
        "--- Web access fallback ---\n"
        "If WebFetch fails on a URL (403, anti-bot block, or a domain "
        "verification error), do not give up: fetch it via Bash with "
        '`curl -sL -A "botference/1.0 (planning council)" <url>` '
        "(truncate long pages, e.g. `| head -c 20000`). "
        "Use WebSearch when you only need to discover sources."
    )


# -- Subagents (user-gated) ---------------------------------------------------


def subagents_note(model: str) -> str:
    """Tell the Claude participant subagents exist but are user-gated.

    The Task tool is deliberately absent from Claude's default tool list;
    the user grants it per-chat with /agents on. Codex has no subagent
    facility, so it gets no note.
    """
    if model.lower() != "claude":
        return ""
    return (
        "--- Subagents ---\n"
        "You start WITHOUT the Task (subagent) tool. If a piece of work "
        "would genuinely benefit from parallel subagents, say so and ask "
        "the user to grant them with `/agents on` — never assume the "
        "grant. Once granted, Task appears in your tools on your next "
        "turn; the user can revoke it with `/agents off`."
    )


# -- Room role --------------------------------------------------------------

ROOM_ROLE_SUFFIX = "\nRespond in your planning room role."


def room_preamble(name: str, other: str, writable_roots: str = "(unspecified)") -> str:
    """Shared planning room context for model initialization."""
    return (
        f"You are {name} in a shared planning room with {other} "
        f"and a human user.\n"
        f"You are collaborating on creating an implementation plan.\n"
        "You may create or update files inside the Botference work directory "
        "(project-local `botference/` or self-hosted `work/`) when the user "
        "explicitly asks for it, but do not modify project source files outside that area.\n"
        f"Current writable roots for this session: {writable_roots}.\n"
        "If you need write access outside those roots, do not continue with the task yet. "
        "Respond with only this exact tag format, using the narrowest directory you need: "
        "<write-access-request path=\"relative/path\" reason=\"short reason\" />\n"
        "If your work produces rendered or visual output (HTML, plots, charts, PDFs, "
        "web UI, or images), follow `specs/visual-verification.md`: do not claim "
        "\"done\" or \"verified\" unless you rendered and inspected the output, and "
        "use `visual_check_html` for HTML when available.\n"
        f"Be concise and constructive. Focus on architecture and "
        f"design decisions."
    )


# -- Writer -----------------------------------------------------------------

PLAN_ONLY_SUFFIX = (
    "\nReturn only the document markdown — do not append the room footer; "
    "your response is written to a file verbatim."
)

WRITER_PREAMBLE = (
    "You are the designated plan writer. Draft a complete "
    "implementation plan based on the discussion so far.\n"
    "Format as clean markdown. This is a draft for review — "
    "no files will be written yet."
    + PLAN_ONLY_SUFFIX
)

def reviewer_preamble(lead_name: str, draft_text: str) -> str:
    """Review/critique instructions for the non-lead model."""
    return (
        f"Review this implementation plan draft from {lead_name}:\n\n"
        f"{draft_text}\n\n"
        f"Identify gaps, risks, or misalignments with the discussion. "
        f"Be constructive and specific. Do not rewrite the plan. "
        f"Return review comments as markdown, then end with the room footer:\n"
        f"{FREE_FORM_FOOTER_SCHEMA}\n"
        '- "status": "converged" if the plan is sound as-is and needs no '
        "revision (your comments will be recorded but no revise turn runs).\n"
        '- "status": "blocked" with "next": "@user" if a decision only the '
        "user can make is required before revising.\n"
        f'- otherwise "continuing" with "next": "@{lead_name.lower()}".'
    )
def revision_from_plan_preamble(current_plan: str, reviewer_name: str,
                                review_text: str, round_number: int) -> str:
    """Revise an existing plan using reviewer feedback."""
    return (
        f"You are revising round {round_number} of the implementation plan.\n\n"
        f"Current implementation plan:\n\n{current_plan}\n\n"
        f"{reviewer_name} left these review comments:\n\n{review_text}\n\n"
        "Rewrite the implementation plan as a complete markdown document. "
        "Address all valid reviewer comments, preserve good existing structure, "
        "and keep the thread metadata and task list coherent."
        + PLAN_ONLY_SUFFIX
    )


def finalize_plan_preamble(current_plan: str, review_bundle: str) -> str:
    """Finalize the plan after draft rounds and reviewer comments."""
    return (
        "Produce the final implementation plan as a complete markdown document.\n\n"
        f"Current implementation plan:\n\n{current_plan}\n\n"
        "Reviewer comments collected during draft rounds:\n\n"
        f"{review_bundle}\n\n"
        "Ensure every reviewer comment is either addressed in the plan or "
        "explicitly resolved by the plan structure. Return only the final "
        "implementation plan markdown."
        + PLAN_ONLY_SUFFIX
    )


def checkpoint_preamble(final_plan_text: str) -> str:
    """Generate checkpoint markdown from the finalized plan."""
    return (
        "Generate checkpoint.md for the finalized implementation plan below.\n\n"
        f"{final_plan_text}\n\n"
        "Return clean markdown matching the checkpoint template structure:\n"
        "- Thread\n"
        "- Last updated\n"
        "- Last agent\n"
        "- Status\n"
        "- Knowledge State table\n"
        "- Last Reflection\n"
        "- Next Task\n"
        "Be concise and derive the next task from the current plan."
        + PLAN_ONLY_SUFFIX
    )
