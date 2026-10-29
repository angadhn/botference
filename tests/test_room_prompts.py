"""Tests for room_prompts.py — prompt templates for botference mode."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from room_prompts import (
    FREE_FORM_FOOTER_SCHEMA,
    PROPORTIONATE_TESTS_RULE,
    ROOM_ROLE_SUFFIX,
    WRITER_PREAMBLE,
    checkpoint_preamble,
    finalize_plan_preamble,
    free_form_protocol,
    project_skill_context,
    reviewer_preamble,
    revision_from_plan_preamble,
    room_preamble,
    web_access_note,
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


class TestBuildRules:
    def test_footer_carries_the_optional_build_stage(self):
        assert '"build": "specifying|building|reviewing|done' in FREE_FORM_FOOTER_SCHEMA

    def test_protocol_says_ask_first_then_announce_the_build(self):
        text = free_form_protocol("Claude", "Codex")
        assert "too thin to build from, ask the user" in text
        assert 'say in one line that a long build is starting' in text
        assert '"build": "building"' in text

    def test_protocol_carries_tags_review_rule_and_test_rule(self):
        text = free_form_protocol("Claude", "Codex")
        assert "summon: [ui]" in text and "summon: [logic]" in text
        assert "does not judge its report" in text and "`git diff`" in text
        assert PROPORTIONATE_TESTS_RULE in text


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


# -- web_access_note ----------------------------------------------------------


class TestWebAccessNote:
    def test_claude_gets_curl_fallback_guidance(self):
        result = web_access_note("claude")
        assert "WebFetch" in result
        assert "403" in result
        assert "curl -sL" in result
        assert "botference/1.0" in result
        assert "WebSearch" in result

    def test_model_name_is_case_insensitive(self):
        assert web_access_note("Claude") == web_access_note("claude")

    def test_codex_gets_no_note(self):
        assert web_access_note("codex") == ""

    def test_only_allowlist_mode_tells_claude_to_ask_for_a_host(self, monkeypatch):
        monkeypatch.delenv("BOTFERENCE_PLAN_ALLOW_NETWORK", raising=False)
        monkeypatch.delenv("BOTFERENCE_PLAN_NETWORK", raising=False)
        assert "/allow-host" not in web_access_note("claude")
        monkeypatch.setenv("BOTFERENCE_PLAN_NETWORK", "allowlist")
        assert "/allow-host" in web_access_note("claude")


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


# -- video_watch_note -------------------------------------------------------


class TestVideoWatchNote:
    def test_tells_the_bots_the_line_to_write(self):
        from room_prompts import video_watch_note
        note = video_watch_note()
        assert "cannot watch video" in note
        assert "watch: <youtube url>" in note
        assert "ask gemini: <question>" in note
        assert "witness" in note
        assert "/watch" in note

    def test_states_the_budget_and_the_depth_limit(self):
        from room_prompts import video_watch_note
        note = video_watch_note()
        assert "two questions to Gemini per user turn" in note
        assert "not acted on" in note   # the wake-up is the end of the chain


class TestWritingStyle:
    def test_room_preamble_carries_house_style(self):
        from room_prompts import WRITING_STYLE_RULE, claude_style_contract
        assert "ASD-STE100" in WRITING_STYLE_RULE
        assert WRITING_STYLE_RULE in room_preamble("Claude", "Codex")
        assert WRITING_STYLE_RULE in claude_style_contract()
