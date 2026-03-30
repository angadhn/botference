"""
Tests for handoff.py — handoff schema, validation, and serialization.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from handoff import (
    REQUIRED_FRONTMATTER_KEYS,
    REQUIRED_HEADINGS,
    VALID_LEADS,
    VALID_MODELS,
    VALID_ROOM_MODES,
    VALID_TIERS,
    ValidationResult,
    _extract_headings,
    _parse_frontmatter,
    build_frontmatter,
    validate_handoff,
)


# ── Helpers ───────────────────────────────────────────────

_VALID_FM = (
    "---\n"
    "model: claude\n"
    "session_id: sess-123\n"
    "created: 2026-03-30T12:00:00Z\n"
    "room_mode: public\n"
    "lead: auto\n"
    "yield_pct: 42.5\n"
    "context_tokens: 50000\n"
    "context_window: 200000\n"
    "generation_tier: self\n"
    "---\n"
)

_VALID_BODY = (
    "\n## Objective\nBuild the widget\n"
    "\n## Resolved Decisions\nUse Python\n"
    "\n## Open Questions\nWhich DB?\n"
    "\n## Positions In Play\n"
    "\n### Converging\nBoth prefer Postgres\n"
    "\n### Contested\nNone\n"
    "\n## Constraints\nMust be fast\n"
    "\n## Current Thread\nDB selection\n"
    "\n## Response Obligation\nAnswer the DB question\n"
    "\n## Decision Criteria\nNone\n"
    "\n## Next Action\nPropose schema\n"
)

VALID_HANDOFF = _VALID_FM + _VALID_BODY


# ── Frontmatter parsing ──────────────────────────────────


class TestParseFrontmatter:
    def test_valid_frontmatter(self):
        fm, body = _parse_frontmatter(VALID_HANDOFF)
        assert fm["model"] == "claude"
        assert fm["session_id"] == "sess-123"
        assert fm["yield_pct"] == "42.5"
        assert "## Objective" in body

    def test_no_frontmatter(self):
        fm, body = _parse_frontmatter("Just some text")
        assert fm == {}
        assert body == "Just some text"

    def test_empty_string(self):
        fm, body = _parse_frontmatter("")
        assert fm == {}
        assert body == ""

    def test_frontmatter_only(self):
        text = "---\nmodel: claude\n---\n"
        fm, body = _parse_frontmatter(text)
        assert fm["model"] == "claude"
        assert body == ""

    def test_unclosed_frontmatter(self):
        text = "---\nmodel: claude\nno closing fence"
        fm, body = _parse_frontmatter(text)
        assert fm == {}

    def test_values_with_colons(self):
        text = "---\nsession_id: sess:abc:123\n---\n"
        fm, _ = _parse_frontmatter(text)
        assert fm["session_id"] == "sess:abc:123"

    def test_comments_skipped(self):
        text = "---\n# a comment\nmodel: codex\n---\n"
        fm, _ = _parse_frontmatter(text)
        assert "model" in fm
        assert fm["model"] == "codex"

    def test_whitespace_trimmed(self):
        text = "---\n  model :  claude  \n---\n"
        fm, _ = _parse_frontmatter(text)
        assert fm["model"] == "claude"


# ── Heading extraction ────────────────────────────────────


class TestExtractHeadings:
    def test_h2_and_h3(self):
        body = "## Foo\ntext\n### Bar\ntext\n## Baz\n"
        assert _extract_headings(body) == ["Foo", "Bar", "Baz"]

    def test_no_headings(self):
        assert _extract_headings("Just text") == []

    def test_h1_ignored(self):
        body = "# Title\n## Real Heading\n"
        assert _extract_headings(body) == ["Real Heading"]

    def test_heading_with_trailing_space(self):
        body = "## Objective   \ntext\n"
        assert _extract_headings(body) == ["Objective"]


# ── Validation — valid documents ──────────────────────────


class TestValidateHandoffValid:
    def test_complete_document_passes(self):
        result = validate_handoff(VALID_HANDOFF)
        assert result.valid is True
        assert result.errors == []

    def test_codex_model_passes(self):
        text = VALID_HANDOFF.replace("model: claude", "model: codex")
        assert validate_handoff(text).valid is True

    def test_all_room_modes_pass(self):
        for mode in VALID_ROOM_MODES:
            text = VALID_HANDOFF.replace("room_mode: public", f"room_mode: {mode}")
            result = validate_handoff(text)
            assert result.valid is True, f"mode {mode}: {result.errors}"

    def test_all_leads_pass(self):
        for lead in VALID_LEADS:
            text = VALID_HANDOFF.replace("lead: auto", f"lead: {lead}")
            result = validate_handoff(text)
            assert result.valid is True, f"lead {lead}: {result.errors}"

    def test_all_tiers_pass(self):
        for tier in VALID_TIERS:
            text = VALID_HANDOFF.replace("generation_tier: self", f"generation_tier: {tier}")
            result = validate_handoff(text)
            assert result.valid is True, f"tier {tier}: {result.errors}"

    def test_none_body_content_passes(self):
        """Sections with 'None' as content are valid."""
        body = ""
        for h in REQUIRED_HEADINGS:
            level = "###" if h in ("Converging", "Contested") else "##"
            body += f"\n{level} {h}\nNone\n"
        text = _VALID_FM + body
        assert validate_handoff(text).valid is True

    def test_zero_yield_pct_passes(self):
        text = VALID_HANDOFF.replace("yield_pct: 42.5", "yield_pct: 0")
        assert validate_handoff(text).valid is True

    def test_integer_context_tokens_passes(self):
        text = VALID_HANDOFF.replace("context_tokens: 50000", "context_tokens: 0")
        assert validate_handoff(text).valid is True


# ── Validation — frontmatter errors ───────────────────────


class TestValidateHandoffFrontmatterErrors:
    def test_no_frontmatter(self):
        result = validate_handoff("## Objective\nfoo\n")
        assert result.valid is False
        assert any("Missing or malformed" in e for e in result.errors)

    def test_missing_single_key(self):
        text = VALID_HANDOFF.replace("model: claude\n", "")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("model" in e for e in result.errors)

    def test_missing_multiple_keys(self):
        text = VALID_HANDOFF.replace("model: claude\n", "").replace("lead: auto\n", "")
        result = validate_handoff(text)
        assert result.valid is False
        errs = " ".join(result.errors)
        assert "model" in errs
        assert "lead" in errs

    def test_invalid_model(self):
        text = VALID_HANDOFF.replace("model: claude", "model: gpt4")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("model" in e and "gpt4" in e for e in result.errors)

    def test_invalid_room_mode(self):
        text = VALID_HANDOFF.replace("room_mode: public", "room_mode: secret")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("room_mode" in e for e in result.errors)

    def test_invalid_lead(self):
        text = VALID_HANDOFF.replace("lead: auto", "lead: @gpt")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("lead" in e for e in result.errors)

    def test_invalid_generation_tier(self):
        text = VALID_HANDOFF.replace("generation_tier: self", "generation_tier: auto")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("generation_tier" in e for e in result.errors)

    def test_non_numeric_yield_pct(self):
        text = VALID_HANDOFF.replace("yield_pct: 42.5", "yield_pct: high")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("yield_pct" in e and "numeric" in e for e in result.errors)

    def test_non_numeric_context_tokens(self):
        text = VALID_HANDOFF.replace("context_tokens: 50000", "context_tokens: lots")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("context_tokens" in e for e in result.errors)

    def test_non_numeric_context_window(self):
        text = VALID_HANDOFF.replace("context_window: 200000", "context_window: big")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("context_window" in e for e in result.errors)


# ── Validation — body heading errors ──────────────────────


class TestValidateHandoffHeadingErrors:
    def test_missing_single_heading(self):
        text = VALID_HANDOFF.replace("## Objective\nBuild the widget\n", "")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("Objective" in e for e in result.errors)

    def test_missing_subheading(self):
        text = VALID_HANDOFF.replace("### Converging\nBoth prefer Postgres\n", "")
        result = validate_handoff(text)
        assert result.valid is False
        assert any("Converging" in e for e in result.errors)

    def test_duplicate_heading(self):
        text = VALID_HANDOFF + "\n## Objective\nDuplicate\n"
        result = validate_handoff(text)
        assert result.valid is False
        assert any("Duplicate" in e and "Objective" in e for e in result.errors)

    def test_all_headings_missing(self):
        text = _VALID_FM + "\nJust text, no headings.\n"
        result = validate_handoff(text)
        assert result.valid is False
        assert len(result.errors) == len(REQUIRED_HEADINGS)

    def test_multiple_errors_accumulated(self):
        """Missing key + missing heading = multiple errors."""
        text = VALID_HANDOFF.replace("model: claude\n", "").replace(
            "## Objective\nBuild the widget\n", ""
        )
        result = validate_handoff(text)
        assert result.valid is False
        assert len(result.errors) >= 2


# ── build_frontmatter ────────────────────────────────────


class TestBuildFrontmatter:
    def test_round_trip(self):
        fm_text = build_frontmatter(
            model="claude",
            session_id="sess-abc",
            created="2026-03-30T12:00:00Z",
            room_mode="public",
            lead="auto",
            yield_pct=55.3,
            context_tokens=80000,
            context_window=200000,
            generation_tier="self",
        )
        fm, body = _parse_frontmatter(fm_text)
        assert fm["model"] == "claude"
        assert fm["session_id"] == "sess-abc"
        assert fm["yield_pct"] == "55.3"
        assert fm["context_tokens"] == "80000"
        assert fm["generation_tier"] == "self"
        assert body == ""

    def test_built_frontmatter_validates(self):
        fm_text = build_frontmatter(
            model="codex",
            session_id="thread-xyz",
            created="2026-03-30T14:00:00Z",
            room_mode="caucus",
            lead="@codex",
            yield_pct=0,
            context_tokens=10000,
            context_window=128000,
            generation_tier="mechanical",
        )
        full = fm_text + _VALID_BODY
        result = validate_handoff(full)
        assert result.valid is True, result.errors

    def test_starts_and_ends_with_fences(self):
        fm_text = build_frontmatter(
            model="claude", session_id="s", created="t",
            room_mode="public", lead="auto", yield_pct=0,
            context_tokens=0, context_window=100000,
            generation_tier="self",
        )
        assert fm_text.startswith("---\n")
        assert fm_text.endswith("---\n")


# ── Schema constants ──────────────────────────────────────


class TestSchemaConstants:
    def test_required_keys_count(self):
        assert len(REQUIRED_FRONTMATTER_KEYS) == 9

    def test_required_headings_count(self):
        assert len(REQUIRED_HEADINGS) == 11

    def test_converging_and_contested_in_headings(self):
        assert "Converging" in REQUIRED_HEADINGS
        assert "Contested" in REQUIRED_HEADINGS

    def test_valid_models(self):
        assert VALID_MODELS == {"claude", "codex"}

    def test_valid_tiers(self):
        assert VALID_TIERS == {"self", "cross", "mechanical"}
