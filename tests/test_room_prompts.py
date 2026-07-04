"""Tests for room_prompts.py — prompt templates for botference mode."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from room_prompts import (
    FREE_FORM_FOOTER_SCHEMA,
    ROOM_ROLE_SUFFIX,
    WRITER_PREAMBLE,
    checkpoint_preamble,
    finalize_plan_preamble,
    free_form_protocol,
    project_skill_context,
    reviewer_preamble,
    revision_from_plan_preamble,
    room_preamble,
)


# -- FREE_FORM_FOOTER_SCHEMA --------------------------------------------------


class TestFreeFormFooterSchema:
    def test_contains_all_statuses(self):
        for status in ("continuing", "converged", "blocked"):
            assert status in FREE_FORM_FOOTER_SCHEMA

    def test_contains_handoff_targets(self):
        for target in ("@claude", "@codex", "@user"):
            assert target in FREE_FORM_FOOTER_SCHEMA

    def test_contains_writer_field(self):
        assert '"writer"' in FREE_FORM_FOOTER_SCHEMA

    def test_contains_summary_field(self):
        assert "summary" in FREE_FORM_FOOTER_SCHEMA


class TestFreeFormProtocol:
    def test_includes_footer_schema(self):
        result = free_form_protocol("Claude", "Codex")
        assert FREE_FORM_FOOTER_SCHEMA in result

    def test_explains_writer_consensus(self):
        result = free_form_protocol("Claude", "Codex")
        assert "writer" in result
        assert "/lead" in result


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


class TestProjectSkillContext:
    def test_lists_codex_native_project_skills_first(self, tmp_path):
        skill_dir = tmp_path / ".agents" / "skills" / "grill-me"
        skill_dir.mkdir(parents=True)
        skill_path = skill_dir / "SKILL.md"
        skill_path.write_text(
            "---\n"
            "name: grill-me\n"
            "description: Stress-test a plan with questions.\n"
            "---\n\n"
            "Ask hard questions.\n",
            encoding="utf-8",
        )

        result = project_skill_context("codex", [tmp_path])

        assert "--- Project Skills ---" in result
        assert "grill-me: Stress-test a plan with questions." in result
        assert str(skill_path.resolve()) in result

    def test_deduplicates_matching_claude_and_codex_skills(self, tmp_path):
        for base in (".agents", ".claude"):
            skill_dir = tmp_path / base / "skills" / "grill-me"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\n"
                "name: grill-me\n"
                "description: Stress-test a plan.\n"
                "---\n",
                encoding="utf-8",
            )

        result = project_skill_context("claude", [tmp_path])

        assert result.count("- grill-me:") == 1
        assert str(
            (tmp_path / ".claude" / "skills" / "grill-me" / "SKILL.md").resolve()
        ) in result


# -- ROOM_ROLE_SUFFIX -------------------------------------------------------


class TestRoomRoleSuffix:
    def test_contains_instruction(self):
        assert "planning room role" in ROOM_ROLE_SUFFIX

    def test_starts_with_newline(self):
        assert ROOM_ROLE_SUFFIX.startswith("\n")


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

    def test_review_requests_room_footer(self):
        result = reviewer_preamble("Claude", "draft")
        assert FREE_FORM_FOOTER_SCHEMA in result
        assert "converged" in result
        assert '"next": "@claude"' in result

    def test_writer_prompts_forbid_footer(self):
        assert "do not append the room footer" in WRITER_PREAMBLE
        assert "do not append the room footer" in revision_from_plan_preamble(
            "plan", "Codex", "review", 1
        )
        assert "do not append the room footer" in finalize_plan_preamble(
            "plan", "review"
        )
        assert "do not append the room footer" in checkpoint_preamble("plan")

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
