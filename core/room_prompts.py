"""
room_prompts.py — Prompt templates for botference mode.

Layered prompt composition (per plan Prompt Composition):
1. Base room preamble — "You are {name} in a shared planning room..."
2. Caucus preamble — private coordination with footer schema
3. Writer preamble — lead drafting to temp artifact
4. Reviewer preamble — review/critique instructions
5. Footer schema — JSON format instruction for caucus turns
"""

from __future__ import annotations

# -- Footer schema ----------------------------------------------------------

FOOTER_SCHEMA = (
    '{"status": "continue|ready_to_draft|need_user_input|'
    'blocked|no_objection|disagree", '
    '"handoff_to": "claude|codex|user", '
    '"writer_vote": "claude|codex|none", '
    '"summary": "one-line state update"}'
)

# -- Room role --------------------------------------------------------------

ROOM_ROLE_SUFFIX = "\nRespond in your planning room role."


def room_preamble(name: str, other: str) -> str:
    """Shared planning room context for model initialization."""
    return (
        f"You are {name} in a shared planning room with {other} "
        f"and a human user.\n"
        f"You are collaborating on creating an implementation plan.\n"
        f"Be concise and constructive. Focus on architecture and "
        f"design decisions."
    )


# -- Caucus -----------------------------------------------------------------

def caucus_preamble(topic: str, turn_number: int, min_turns: int,
                    max_turns: int) -> str:
    """Private coordination turn instruction with footer schema."""
    turns_remaining_before_exit = max(0, min_turns - turn_number)
    return (
        f"[Private caucus — discuss: {topic}]\n"
        f"[Turn {turn_number} of {max_turns} — "
        + (f"minimum {turns_remaining_before_exit} more turn(s) before "
           f"either side may signal completion]\n\n"
           if turns_remaining_before_exit > 0
           else "either side may now signal completion]\n\n")
        + "TURN-TAKING RULES:\n"
        "- This is a structured, multi-round discussion. You speak, "
        "then the other model speaks, alternating.\n"
        "- Use status \"continue\" to keep the discussion going. "
        "The other model will respond to your points.\n"
        "- Only use a terminal status (ready_to_draft, no_objection, "
        "need_user_input, disagree, blocked) when you genuinely have "
        "nothing left to add AND the minimum turns have passed.\n"
        "- Do not rush to agreement. Explore the topic thoroughly.\n\n"
        f"End your response with a JSON footer:\n"
        f"{FOOTER_SCHEMA}\n\n"
        f"Be concise. Focus on the key decision points."
    )


def caucus_first_turn(topic: str, turn_number: int = 1,
                     min_turns: int = 3, max_turns: int = 5) -> str:
    """First caucus turn (no prior response)."""
    return (
        f"Topic: {topic}\n\n"
        f"{caucus_preamble(topic, turn_number, min_turns, max_turns)}"
    )


def caucus_turn(other_name: str, other_response: str, topic: str,
                turn_number: int = 1, min_turns: int = 3,
                max_turns: int = 5) -> str:
    """Subsequent caucus turn with the other model's response."""
    return (
        f"[{other_name}'s caucus response:]\n{other_response}"
        f"\n\n{caucus_preamble(topic, turn_number, min_turns, max_turns)}"
    )


# -- Writer -----------------------------------------------------------------

WRITER_PREAMBLE = (
    "You are the designated plan writer. Draft a complete "
    "implementation plan based on the discussion so far.\n"
    "Format as clean markdown. This is a draft for review — "
    "no files will be written yet."
)

WRITER_FINAL_PREAMBLE = (
    "You are the designated plan writer. Produce a final "
    "implementation plan as a markdown document. This will be "
    "written to implementation-plan.md and checkpoint.md after "
    "user approval.\n\nInclude all decisions from the discussion. "
    "Be thorough and specific."
)

# -- Reviewer ---------------------------------------------------------------


def reviewer_preamble(lead_name: str, draft_text: str) -> str:
    """Review/critique instructions for the non-lead model."""
    return (
        f"Review this implementation plan draft from {lead_name}:\n\n"
        f"{draft_text}\n\n"
        f"Identify gaps, risks, or misalignments with the discussion. "
        f"Be constructive and specific."
    )


def revision_preamble(reviewer_name: str, review_text: str) -> str:
    """Instructions for the lead to revise based on review feedback."""
    return (
        f"{reviewer_name} reviewed your draft and provided this feedback:\n\n"
        f"{review_text}\n\n"
        f"Revise your implementation plan to address this feedback. "
        f"Incorporate valid points, explain any you disagree with, "
        f"and produce the updated plan as clean markdown."
    )


# -- Write ------------------------------------------------------------------


def write_preamble(draft_text: str, work_prefix: str = "") -> str:
    """Instructions for writing approved plan files."""
    return (
        "Write the following plan to these files:\n"
        f"1. {work_prefix}implementation-plan.md — the full plan\n"
        f"2. {work_prefix}checkpoint.md — a brief checkpoint summary\n\n"
        f"Plan content:\n\n{draft_text}"
    )
