"""Google Docs review: the council Claude's settings, the write lock, the rule text."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

CORE = Path(__file__).resolve().parent.parent / "core"
sys.path.insert(0, str(CORE))

from cli_adapters import claude_plan_settings_for_work_dir  # noqa: E402
from gdoc_guard import GDOC_WRITE_TOOL, Verdict, judge, judge_text  # noqa: E402
from room_prompts import google_doc_review_note  # noqa: E402

DOC = "doc-id"


def _call(tool_input, tool_name=GDOC_WRITE_TOOL):
    return {"hook_event_name": "PreToolUse", "tool_name": tool_name,
            "tool_input": tool_input}


INSERT = {"insertText": {"text": "x", "location": {"index": 1}}}
COMMENT = {"insertComment": {"content": "Claude: why?",
                             "range": {"startIndex": 1, "endIndex": 4}}}
REPLY = {"addCommentReply": {"commentId": "c1", "content": "Claude: agreed"}}


# -- settings ---------------------------------------------------------------

class TestSettings:
    def test_allows_exactly_the_two_docs_tools(self):
        allow = claude_plan_settings_for_work_dir("/repo", "/repo/botference")[
            "permissions"]["allow"]
        google = [r for r in allow if r.startswith("mcp__")]
        assert google == ["mcp__claude_ai_Google_Docs__read_doc",
                          "mcp__claude_ai_Google_Docs__update_doc"]
        for name in ("Drive", "Gmail", "Calendar", "Sheets", "Slides"):
            assert not [r for r in allow if name in r]

    def test_personal_google_connectors_denied(self):
        deny = claude_plan_settings_for_work_dir("/repo", "/repo/botference")[
            "permissions"]["deny"]
        for server in ("Google_Drive", "Gmail", "Google_Calendar",
                       "Google_Sheets", "Google_Slides"):
            assert f"mcp__claude_ai_{server}" in deny
        assert not [r for r in deny if "Google_Docs" in r]

    def test_write_tool_hook_blocks_on_failure(self):
        hooks = claude_plan_settings_for_work_dir("/repo", "/repo/botference")[
            "hooks"]["PreToolUse"]
        assert len(hooks) == 1 and hooks[0]["matcher"] == GDOC_WRITE_TOOL
        (hook,) = hooks[0]["hooks"]
        assert hook["type"] == "command"
        assert hook["onFailure"] == "block"
        assert Path(hook["args"][-1]) == CORE / "gdoc_guard.py"


# -- the guard ----------------------------------------------------------------

class TestGuard:
    def test_suggest_allowed(self):
        v = judge(_call({"documentId": DOC, "requests": [INSERT],
                         "writeControl": {"writeMode": "SUGGEST",
                                          "requiredRevisionId": "r1"}}))
        assert v is Verdict.ALLOW_SUGGESTIONS

    @pytest.mark.parametrize("request_", [
        INSERT,
        {"deleteContentRange": {"range": {"startIndex": 1, "endIndex": 4}}},
        {"replaceAllText": {"replaceText": "b",
                            "containsText": {"text": "a"}}},
        COMMENT,
        REPLY,
    ])
    def test_suggest_allows_each_listed_kind(self, request_):
        v = judge(_call({"documentId": DOC, "requests": [request_],
                         "writeControl": {"writeMode": "SUGGEST"}}))
        assert v is Verdict.ALLOW_SUGGESTIONS

    def test_suggest_allows_text_and_comment_mixed(self):
        v = judge(_call({"documentId": DOC, "requests": [INSERT, COMMENT],
                         "writeControl": {"writeMode": "SUGGEST"}}))
        assert v is Verdict.ALLOW_SUGGESTIONS

    @pytest.mark.parametrize("kind", [
        "deleteComment", "updateCommentPost", "deleteTab", "madeUpRequest",
    ])
    def test_suggest_refuses_other_kinds(self, kind):
        v = judge(_call({"documentId": DOC, "requests": [INSERT, {kind: {}}],
                         "writeControl": {"writeMode": "SUGGEST"}}))
        assert v is Verdict.REFUSE_REQUEST_KIND

    def test_comment_only_allowed(self):
        v = judge(_call({"documentId": DOC, "requests": [COMMENT, REPLY]}))
        assert v is Verdict.ALLOW_COMMENTS

    def test_direct_edit_refused(self):
        v = judge(_call({"documentId": DOC, "requests": [INSERT]}))
        assert v is Verdict.REFUSE_DIRECT_EDIT

    def test_explicit_edit_mode_refused(self):
        v = judge(_call({"documentId": DOC, "requests": [INSERT],
                         "writeControl": {"writeMode": "EDIT"}}))
        assert v is Verdict.REFUSE_DIRECT_EDIT

    def test_mixed_batch_without_suggest_refused(self):
        v = judge(_call({"documentId": DOC, "requests": [COMMENT, INSERT]}))
        assert v is Verdict.REFUSE_DIRECT_EDIT

    @pytest.mark.parametrize("tool_input", [
        {"documentId": DOC},
        {"documentId": DOC, "requests": []},
        {"documentId": DOC, "requests": [],
         "writeControl": {"writeMode": "SUGGEST"}},
    ])
    def test_empty_refused(self, tool_input):
        assert judge(_call(tool_input)) is Verdict.REFUSE_NO_REQUESTS

    @pytest.mark.parametrize("raw", [
        "", "not json", "[]", "null",
        json.dumps(_call("a string")),
        json.dumps(_call({"requests": "insertText"})),
        json.dumps(_call({"requests": [INSERT],
                          "writeControl": "SUGGEST"})),
        json.dumps(_call({"requests": [{"insertComment": {}, **INSERT}]})),
        json.dumps(_call({"requests": ["insertComment"]})),
    ])
    def test_unparseable_refused(self, raw):
        assert judge_text(raw) is Verdict.REFUSE_UNREADABLE

    def test_other_tool_refused(self):
        v = judge(_call({"requests": [COMMENT]},
                        tool_name="mcp__claude_ai_Google_Drive__update_file"))
        assert v is Verdict.REFUSE_WRONG_TOOL

    def test_every_verdict_is_allow_or_refuse(self):
        assert {v for v in Verdict if v.allowed} == {
            Verdict.ALLOW_SUGGESTIONS, Verdict.ALLOW_COMMENTS}

    @pytest.mark.parametrize("payload, code", [
        (_call({"requests": [COMMENT]}), 0),
        (_call({"requests": [INSERT],
                "writeControl": {"writeMode": "SUGGEST"}}), 0),
        (_call({"requests": [INSERT]}), 2),
        (_call({"requests": [{"deleteComment": {"commentId": "c1"}}],
                "writeControl": {"writeMode": "SUGGEST"}}), 2),
        ("garbage", 2),
    ])
    def test_script_exit_codes(self, payload, code):
        raw = payload if isinstance(payload, str) else json.dumps(payload)
        p = subprocess.run([sys.executable, "-I", str(CORE / "gdoc_guard.py")],
                           input=raw, capture_output=True, text=True)
        assert p.returncode == code
        if code == 2:
            assert p.stderr.startswith("Refused by the botference Google Docs lock")
            assert p.stderr.count("\n") == 1
        else:
            assert p.stdout == "" and p.stderr == ""


# -- rule text ----------------------------------------------------------------

class TestRuleText:
    def test_claude_gets_the_rule_with_its_own_name(self):
        note = google_doc_review_note("claude")
        assert note.startswith("--- Reviewing a Google Doc ---")
        assert '"Claude:"' in note
        assert "requiredRevisionId" in note

    def test_codex_not_yet_wired(self):
        assert google_doc_review_note("codex") == ""
