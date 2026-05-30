"""Tests for the 2026-05-30 reliability/UX fixes.

Covers: context-overflow detection, tool-output truncation at capture, the
tail-budget helper, and bounded relay/late-join backfill.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from cli_adapters import (  # noqa: E402
    AdapterResponse,
    is_context_overflow,
    _structured_output_blocks,
    _TOOL_OUTPUT_BLOCK_LIMIT,
)
from botference import (  # noqa: E402
    Transcript,
    _take_tail_within_budget,
    _BACKFILL_MAX_CHARS,
)


class TestOverflowDetection:
    def test_detects_anthropic_too_long(self):
        assert is_context_overflow(
            "Error: prompt is too long: 250000 tokens > 200000 maximum")

    def test_detects_openai_maximum_context_length(self):
        assert is_context_overflow(
            "This model's maximum context length is 200000 tokens")

    def test_detects_request_too_large(self):
        assert is_context_overflow("API error 400: request_too_large")

    def test_ignores_normal_text(self):
        assert not is_context_overflow("All good — finished the task.")

    def test_empty_is_false(self):
        assert not is_context_overflow("")


class TestAdapterResponseDefault:
    def test_context_overflow_defaults_false(self):
        assert AdapterResponse(text="hi").context_overflow is False


class TestToolOutputTruncation:
    def test_long_output_truncated_with_marker(self):
        code = "```js\nconsole.log(1)\n```\n"
        filler = "filler line of output\n" * 1000  # well over the limit
        blocks = _structured_output_blocks(code + filler)
        assert blocks, "expected non-text blocks for code content"
        assert "truncated" in blocks[-1].get("text", "")
        retained = sum(len(b.get("text", "")) for b in blocks)
        assert retained < _TOOL_OUTPUT_BLOCK_LIMIT + 200

    def test_short_output_no_marker(self):
        blocks = _structured_output_blocks("```\nprint(1)\n```")
        assert all("truncated" not in b.get("text", "") for b in blocks)

    def test_plain_prose_returns_empty(self):
        assert _structured_output_blocks("just prose, no code blocks") == []


class TestTailBudget:
    def test_keeps_recent_elides_front(self):
        blocks = [f"b{i}" * 10 for i in range(10)]
        kept, elided = _take_tail_within_budget(blocks, 50)
        assert kept == blocks[len(blocks) - len(kept):]  # a contiguous tail
        assert elided == len(blocks) - len(kept)
        assert elided > 0

    def test_always_keeps_at_least_one(self):
        kept, elided = _take_tail_within_budget(["x" * 1000, "y" * 1000], 10)
        assert kept == ["y" * 1000]
        assert elided == 1

    def test_all_fit(self):
        assert _take_tail_within_budget(["a", "b", "c"], 10_000) == (["a", "b", "c"], 0)

    def test_empty(self):
        assert _take_tail_within_budget([], 100) == ([], 0)


class TestBackfillBounding:
    def test_context_after_bounds_and_marks_elision(self):
        t = Transcript()
        for _ in range(50):
            t.add("claude", "Z" * 2000)  # 100k chars total, over the 60k budget
        out = t.context_after(-1)
        assert len(out) < _BACKFILL_MAX_CHARS + 5000
        assert "elided to fit context" in out

    def test_context_after_small_no_elision(self):
        t = Transcript()
        t.add("user", "hello there")
        t.add("claude", "general kenobi")
        out = t.context_after(-1)
        assert "elided" not in out
        assert "hello there" in out and "general kenobi" in out

    def test_context_since_always_keeps_user_message(self):
        t = Transcript()
        for _ in range(50):
            t.add("user", "Q" * 2000)
        out = t.context_since("claude", "the current question")
        assert "the current question" in out
        assert len(out) < _BACKFILL_MAX_CHARS + 5000
