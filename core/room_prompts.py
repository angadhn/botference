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


def room_preamble(name: str, other: str, writable_roots: str) -> str:
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

def reviewer_preamble(lead_name: str, draft_text: str) -> str:
    """Review/critique instructions for the non-lead model."""
    return (
        f"Review this implementation plan draft from {lead_name}:\n\n"
        f"{draft_text}\n\n"
        f"Identify gaps, risks, or misalignments with the discussion. "
        f"Be constructive and specific. Do not rewrite the plan. "
        f"Return review comments only as markdown."
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
    )
