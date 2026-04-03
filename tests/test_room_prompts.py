"""Tests for room_prompts.py — prompt templates for botference mode."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from room_prompts import (
    FOOTER_SCHEMA,
    ROOM_ROLE_SUFFIX,
    WRITER_PREAMBLE,
    caucus_first_turn,
    caucus_preamble,
    caucus_turn,
    checkpoint_preamble,
    finalize_plan_preamble,
    reviewer_preamble,
    revision_from_plan_preamble,
    room_preamble,
)


# -- FOOTER_SCHEMA ----------------------------------------------------------


class TestFooterSchema:
    def test_contains_all_statuses(self):
        for status in ("continue", "ready_to_draft", "need_user_input",
                        "blocked", "no_objection", "disagree"):
            assert status in FOOTER_SCHEMA

    def test_contains_handoff_targets(self):
        for target in ("claude", "codex", "user"):
            assert target in FOOTER_SCHEMA

    def test_contains_writer_vote_field(self):
        assert "writer_vote" in FOOTER_SCHEMA

    def test_contains_summary_field(self):
        assert "summary" in FOOTER_SCHEMA


# -- room_preamble ----------------------------------------------------------


class TestRoomPreamble:
    def test_includes_model_name(self):
        result = room_preamble("Claude", "Codex")
        assert "You are Claude" in result

    def test_includes_other_name(self):
        result = room_preamble("Claude", "Codex")
        assert "Codex" in result

    def test_includes_role_context(self):
        result = room_preamble("Claude", "Codex")
        assert "planning room" in result
        assert "implementation plan" in result
        assert "Botference work directory" in result

    def test_symmetric(self):
        a = room_preamble("Claude", "Codex")
        b = room_preamble("Codex", "Claude")
        assert "You are Claude" in a
        assert "You are Codex" in b


# -- ROOM_ROLE_SUFFIX -------------------------------------------------------


class TestRoomRoleSuffix:
    def test_contains_instruction(self):
        assert "planning room role" in ROOM_ROLE_SUFFIX

    def test_starts_with_newline(self):
        assert ROOM_ROLE_SUFFIX.startswith("\n")


# -- caucus_preamble --------------------------------------------------------


class TestCaucusPreamble:
    def test_includes_topic(self):
        result = caucus_preamble("microservices vs monolith", 1, 3, 5)
        assert "microservices vs monolith" in result

    def test_includes_footer_schema(self):
        result = caucus_preamble("topic", 1, 3, 5)
        assert FOOTER_SCHEMA in result

    def test_includes_instructions(self):
        result = caucus_preamble("topic", 1, 3, 5)
        assert "JSON footer" in result
        assert "concise" in result.lower()


# -- caucus_first_turn ------------------------------------------------------


class TestCaucusFirstTurn:
    def test_includes_topic(self):
        result = caucus_first_turn("database choice")
        assert "database choice" in result

    def test_starts_with_topic_label(self):
        result = caucus_first_turn("arch")
        assert result.startswith("Topic: arch")

    def test_includes_footer_schema(self):
        result = caucus_first_turn("topic")
        assert FOOTER_SCHEMA in result


# -- caucus_turn ------------------------------------------------------------


class TestCaucusTurn:
    def test_includes_other_response(self):
        result = caucus_turn("Claude", "I think option A", "arch")
        assert "Claude's caucus response" in result
        assert "I think option A" in result

    def test_includes_footer_schema(self):
        result = caucus_turn("Codex", "response text", "topic")
        assert FOOTER_SCHEMA in result

    def test_includes_preamble(self):
        result = caucus_turn("Claude", "resp", "db choice")
        assert "Private caucus" in result
        assert "db choice" in result


# -- WRITER_PREAMBLE --------------------------------------------------------


class TestWriterPreamble:
    def test_draft_instructions(self):
        assert "designated plan writer" in WRITER_PREAMBLE
        assert "draft" in WRITER_PREAMBLE.lower()

    def test_no_files_written(self):
        assert "no files" in WRITER_PREAMBLE.lower()


# -- reviewer_preamble ------------------------------------------------------


class TestReviewerPreamble:
    def test_includes_lead_name(self):
        result = reviewer_preamble("Claude", "# Draft plan")
        assert "Claude" in result

    def test_includes_draft_text(self):
        result = reviewer_preamble("Codex", "# My Plan\nStep 1...")
        assert "# My Plan" in result
        assert "Step 1..." in result

    def test_review_instructions(self):
        result = reviewer_preamble("Claude", "draft")
        assert "gaps" in result.lower()
        assert "risks" in result.lower()
        assert "constructive" in result.lower()

    def test_tells_reviewer_not_to_rewrite_plan(self):
        result = reviewer_preamble("Claude", "draft")
        assert "do not rewrite the plan" in result.lower()


# -- revision_from_plan_preamble --------------------------------------------


class TestRevisionFromPlanPreamble:
    def test_includes_current_plan(self):
        result = revision_from_plan_preamble("# Plan", "Codex", "Needs more detail", 2)
        assert "# Plan" in result

    def test_includes_round_number(self):
        result = revision_from_plan_preamble("plan", "Codex", "review", 2)
        assert "round 2" in result.lower()


# -- finalize_plan_preamble -------------------------------------------------


class TestFinalizePlanPreamble:
    def test_includes_plan_and_review_bundle(self):
        result = finalize_plan_preamble("# Plan", "[AI-reviewer_comments_round-1.md]\nreview")
        assert "# Plan" in result
        assert "AI-reviewer_comments_round-1.md" in result

    def test_mentions_addressing_comments(self):
        result = finalize_plan_preamble("plan", "review")
        assert "addressed" in result.lower()


# -- checkpoint_preamble ----------------------------------------------------


class TestCheckpointPreamble:
    def test_mentions_checkpoint_sections(self):
        result = checkpoint_preamble("# Plan")
        assert "Knowledge State" in result
        assert "Next Task" in result
