"""Summoned build agents and /parallel (core/summon.py, botference.py)."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

import summon  # noqa: E402
from botference import InputKind, parse_input  # noqa: E402
from cli_adapters import AdapterResponse, ToolSummary  # noqa: E402

from test_botference import MockAdapter, MockUI, _make_botference, _ok  # noqa: E402


# ── parsing ───────────────────────────────────────────────


class TestParseSummon:
    def test_a_one_line_brief(self):
        text = "I have enough.\n\nsummon: build the landing page, dark theme\n"
        assert summon.parse_summon_request(text) == "build the landing page, dark theme"

    def test_continuation_lines_join_the_brief(self):
        text = ("Let me send this out.\n"
                "summon: build a one-file HTML report\n"
                "  from projects/acta/notes.md, four sections,\n"
                "  save under projects/acta/artifacts/\n"
                "\n"
                '{"status": "continuing", "next": "@user"}')
        brief = summon.parse_summon_request(text)
        assert brief.startswith("build a one-file HTML report from projects/acta")
        assert brief.endswith("projects/acta/artifacts/")
        assert "status" not in brief

    def test_markdown_wrapping_is_peeled(self):
        assert summon.parse_summon_request("- **summon: make it**") == "make it"

    def test_a_fenced_line_is_code(self):
        assert summon.parse_summon_request("```\nsummon: not this\n```") is None

    def test_an_empty_brief_is_no_brief(self):
        assert summon.parse_summon_request("summon:") is None
        assert summon.parse_summon_request("nothing here") is None

    def test_the_first_summon_wins(self):
        text = "summon: first\n\nsummon: second"
        assert summon.parse_summon_request(text) == "first"


# ── builder spec ──────────────────────────────────────────


class TestBuilderSpec:
    def test_defaults_are_opus_5_5_high(self, tmp_path, monkeypatch):
        for env in ("BOTFERENCE_BUILDER_CLI", "BOTFERENCE_BUILDER_MODEL",
                    "BOTFERENCE_BUILDER_EFFORT"):
            monkeypatch.delenv(env, raising=False)
        spec = summon.builder_spec("claude", tmp_path)
        assert spec["cli"] == "claude"
        assert spec["model"] == "claude-opus-5-5"
        assert spec["effort"] == "high"
        assert spec["timeout_s"] == 0, "no cap by default: a build runs until it is done"

    def test_the_repo_budgets_file_names_the_builder(self, monkeypatch):
        for env in ("BOTFERENCE_BUILDER_CLI", "BOTFERENCE_BUILDER_MODEL",
                    "BOTFERENCE_BUILDER_EFFORT"):
            monkeypatch.delenv(env, raising=False)
        repo = Path(__file__).resolve().parent.parent
        spec = summon.builder_spec("codex", repo)
        assert spec["model"] == "claude-opus-5-5"

    def test_a_per_summoner_override(self, tmp_path, monkeypatch):
        monkeypatch.delenv("BOTFERENCE_BUILDER_MODEL", raising=False)
        monkeypatch.delenv("BOTFERENCE_BUILDER_CLI", raising=False)
        monkeypatch.delenv("BOTFERENCE_BUILDER_EFFORT", raising=False)
        (tmp_path / "context-budgets.json").write_text(json.dumps({
            "builder": {"model": "claude-opus-5-5", "effort": "high",
                        "for": {"codex": {"cli": "codex", "model": "gpt-6-sol",
                                          "effort": "xhigh"}}},
        }))
        assert summon.builder_spec("claude", tmp_path)["model"] == "claude-opus-5-5"
        codex = summon.builder_spec("codex", tmp_path)
        assert (codex["cli"], codex["model"], codex["effort"]) == ("codex", "gpt-6-sol", "xhigh")

    def test_env_wins_over_the_file(self, tmp_path, monkeypatch):
        monkeypatch.setenv("BOTFERENCE_BUILDER_MODEL", "claude-fable-5-1")
        assert summon.builder_spec("claude", tmp_path)["model"] == "claude-fable-5-1"

    def test_an_unlimited_builder_has_no_adapter_timeout(self, tmp_path, monkeypatch):
        monkeypatch.delenv("BOTFERENCE_BUILDER_MODEL", raising=False)
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        a = c._make_builder(summon.builder_spec("claude", tmp_path))
        assert a.timeout is None
        (tmp_path / "context-budgets.json").write_text(json.dumps({"builder": {"timeout_s": 600}}))
        a2 = c._make_builder(summon.builder_spec("claude", tmp_path))
        assert a2.timeout == 600

    def test_labels(self):
        assert summon.builder_label({"model": "claude-opus-5-5", "effort": "high"}) == "Claude Opus 5.5 (high)"
        assert summon.builder_label({"model": "gpt-6-sol", "effort": "xhigh"}) == "GPT-6 Sol (xhigh)"

    def test_prompt_carries_brief_summoner_and_report_rule(self):
        p = summon.builder_prompt(
            brief="build X", summoner="codex", history="[User said:]\nhi",
            artifacts_dir="projects/p/artifacts", project_root="/w",
        )
        assert "summoned by Codex" in p
        assert "build X" in p
        assert "projects/p/artifacts" in p
        assert "artifact: <path" in p
        assert "Do not summon anyone yourself" in p
        assert "[User said:]" in p


# ── the controller runs the agent ─────────────────────────


class MetaUI(MockUI):
    """A UI that also records the agent metadata a room entry carries."""

    def __init__(self):
        super().__init__()
        self.agent_entries: list[tuple[str, str, dict]] = []
        self.stream_events: list[dict] = []

    def add_room_entry(self, speaker, text, blocks=None, *, stream_id="",
                       restored=False, agent=None):
        self.room_entries.append((speaker, text))
        self.room_blocks.append(blocks)
        if agent:
            self.agent_entries.append((speaker, text, dict(agent)))

    def stream_event(self, event):
        self.stream_events.append(event)


def _bot_with_summon(tmp_path, *, summoner_reply: str, builder: MockAdapter,
                     codex_reply: str = "Codex says hi"):
    claude_resps = [_ok(summoner_reply), _ok("Open the page; it is done.")]
    c, claude, codex, _ = _make_botference(
        claude_responses=claude_resps,
        codex_responses=[_ok(codex_reply)],
        tmp_path=tmp_path,
    )
    ui = MetaUI()
    made: list[dict] = []

    def fake_make_builder(spec):
        made.append(spec)
        return builder

    c._make_builder = fake_make_builder  # type: ignore[method-assign]
    return c, claude, codex, ui, made


@pytest.mark.asyncio
class TestSummonInChat:
    async def test_a_summon_line_runs_the_builder_and_nests_its_report(
        self, tmp_path, monkeypatch,
    ):
        monkeypatch.delenv("BOTFERENCE_BUILDER_MODEL", raising=False)
        builder = MockAdapter([_ok(
            "Built projects/p/artifacts/index.html.\nartifact: projects/p/artifacts/index.html"
        )])
        c, claude, codex, ui, made = _bot_with_summon(
            tmp_path,
            summoner_reply="I have enough.\nsummon: build the page from the outline",
            builder=builder,
        )
        await c.handle_input("@claude let's build it", ui)

        # the builder got the brief, the summoner and the room
        assert made and made[0]["model"] == "claude-opus-5-5"
        assert len(builder.send_calls) == 1
        prompt = builder.send_calls[0]
        assert "build the page from the outline" in prompt
        assert "summoned by Claude" in prompt
        assert "let's build it" in prompt

        # the reader saw a working card, then the report, both nested
        cards = [e for e in ui.agent_entries if e[2]["card"] == "report"]
        assert [e[2]["status"] for e in cards] == ["working", "done"]
        assert cards[0][2]["summoned_by"] == "claude"
        assert cards[0][2]["label"] == "Claude Opus 5.5 (high)"
        assert cards[1][1].startswith("Built projects/p/artifacts/index.html")
        # the parent is the summoner's own message
        parent = cards[0][2]["parent_stream_id"]
        assert parent and ":claude:" in parent
        assert cards[0][2]["id"] == cards[1][2]["id"]

        # the report is in the shared history in the agent's own name, and
        # the summoner was woken once with it
        agent_turns = [e for e in c.transcript.entries if e.speaker == "agent"]
        assert len(agent_turns) == 1
        assert "summoned by Claude, done" in agent_turns[0].text
        assert len(claude.resume_calls) == 1
        assert "has done" in claude.resume_calls[0]
        assert "Open the page; it is done." in [t for sp, t in ui.room_entries if sp == "claude"]

        # one history entry for the card, holding the outcome
        saved = [r for r in c._room_history if r.meta]
        assert len(saved) == 1 and saved[0].meta["status"] == "done"

    async def test_the_budget_is_one_summon_per_bot_per_turn(self, tmp_path):
        builder = MockAdapter([_ok("built"), _ok("built again")])
        # the wake-up reply tries to summon again
        c, claude, codex, ui, made = _bot_with_summon(
            tmp_path, summoner_reply="summon: first build", builder=builder,
        )
        claude._responses[1] = _ok("summon: and another one")
        await c.handle_input("@claude go", ui)
        assert len(builder.send_calls) == 1
        # the second is not run: the wake-up is depth 1
        assert not any("another one" in p for p in builder.send_calls)

    async def test_a_failed_builder_is_a_report_not_a_crash(self, tmp_path):
        class Boom(MockAdapter):
            async def send(self, prompt):
                raise RuntimeError("no such model")
        c, claude, codex, ui, made = _bot_with_summon(
            tmp_path, summoner_reply="summon: build it", builder=Boom(),
        )
        await c.handle_input("@claude go", ui)
        cards = [e for e in ui.agent_entries if e[2]["card"] == "report"]
        assert cards[-1][2]["status"] == "failed"
        assert "no such model" in cards[-1][1]
        assert "has failed" in claude.resume_calls[0]

    async def test_codex_can_summon_too(self, tmp_path):
        builder = MockAdapter([_ok("built by opus")])
        c, claude, codex, _ = _make_botference(
            claude_responses=[_ok("Claude says hi")],
            codex_responses=[_ok("Right.\nsummon: build the thing"), _ok("Done, open it.")],
            tmp_path=tmp_path,
        )
        ui = MetaUI()
        c._make_builder = lambda spec: builder  # type: ignore[method-assign]
        await c.handle_input("@codex go", ui)
        cards = [e for e in ui.agent_entries if e[2]["card"] == "report"]
        assert cards and cards[0][2]["summoned_by"] == "codex"
        assert ":codex:" in cards[0][2]["parent_stream_id"]
        assert len(codex.resume_calls) == 1

    async def test_an_in_chat_build_is_stamped(self, tmp_path):
        wrote = AdapterResponse(text="Here is the page.", tool_summaries=[ToolSummary(
            id="t1", name="Write",
            input_preview='{"file_path": "projects/p/artifacts/index.html"}',
        )])
        c, claude, codex, ui = _make_botference(
            claude_responses=[wrote], tmp_path=tmp_path,
        )
        await c.handle_input("@claude build it", ui)
        stamps = [t for sp, t in ui.room_entries
                  if sp == "system" and t.startswith(c.IN_CHAT_BUILD_STAMP)]
        assert len(stamps) == 1
        assert "index.html" in stamps[0]

    async def test_a_resumed_chat_counts_on_from_its_saved_cards(self, tmp_path):
        builder = MockAdapter([_ok("built once")])
        c, claude, codex, ui, made = _bot_with_summon(
            tmp_path, summoner_reply="summon: build it", builder=builder,
        )
        await c.handle_input("@claude go", ui)
        payload = c._session_payload()
        # a fresh bridge process restores the chat and a second summon happens
        c2, claude2, codex2, _ = _make_botference(
            claude_responses=[_ok("summon: build more"), _ok("Open it.")], tmp_path=tmp_path,
        )
        c2._restore_from_payload(payload)
        c2._models_initialized = set()
        ui2 = MetaUI()
        c2._make_builder = lambda spec: MockAdapter([_ok("built twice")])  # type: ignore[method-assign]
        await c2.handle_input("@claude again", ui2)
        cards = [r for r in c2._room_history if r.meta and r.meta["card"] == "report"]
        assert len(cards) == 2, "the second run's card did not replace the first"
        assert cards[0].meta["id"] != cards[1].meta["id"]
        assert [r.meta["status"] for r in cards] == ["done", "done"]

    async def test_restore_keeps_the_agent_card(self, tmp_path):
        builder = MockAdapter([_ok("built")])
        c, claude, codex, ui, made = _bot_with_summon(
            tmp_path, summoner_reply="summon: build it", builder=builder,
        )
        await c.handle_input("@claude go", ui)
        payload = c._session_payload()
        cards = [e for e in payload["room_history"] if e.get("agent")]
        assert len(cards) == 1 and cards[0]["agent"]["status"] == "done"
        c2, _, _, _ = _make_botference(tmp_path=tmp_path)
        c2._restore_from_payload(payload)
        assert [r.meta["status"] for r in c2._room_history if r.meta] == ["done"]


# ── /parallel ─────────────────────────────────────────────


class TestParseParallel:
    def test_the_word_lifts_out_wherever_it_sits(self):
        for raw in ("/parallel what do you think?", "what do you think? /parallel",
                    "what do /parallel you think?"):
            p = parse_input(raw)
            assert p.kind is InputKind.MESSAGE
            assert p.parallel is True
            assert p.target == "@all"
            assert p.body == "what do you think?"

    def test_a_mention_is_overridden(self):
        p = parse_input("@claude /parallel compare these")
        assert p.parallel and p.target == "@all" and p.body == "compare these"

    def test_a_bare_parallel_is_an_empty_message(self):
        p = parse_input("/parallel")
        assert p.kind is InputKind.MESSAGE and p.parallel and p.body == ""

    def test_a_slash_command_stays_a_command(self):
        p = parse_input("/status /parallel")
        assert p.kind is InputKind.STATUS

    def test_ordinary_messages_are_not_parallel(self):
        assert parse_input("run this in /parallelism mode").parallel is False
        assert parse_input("hello").parallel is False


class GateAdapter(MockAdapter):
    """Waits at a gate so the test can prove both bots were in flight at once."""

    def __init__(self, responses, gate: asyncio.Event, arrived: list[str], name: str):
        super().__init__(responses)
        self._gate, self._arrived, self._name = gate, arrived, name

    async def send(self, prompt):
        self._arrived.append(self._name)
        if len(self._arrived) == 2:
            self._gate.set()
        await asyncio.wait_for(self._gate.wait(), timeout=2)
        return await super().send(prompt)

    async def resume(self, message):
        return await self.send(message)


@pytest.mark.asyncio
class TestParallelTurn:
    async def test_both_bots_run_at_once_and_neither_sees_the_other(self, tmp_path):
        gate, arrived = asyncio.Event(), []
        claude = GateAdapter([_ok("Claude's take"), _ok("Claude again")], gate, arrived, "claude")
        codex = GateAdapter([_ok("Codex's take"), _ok("Codex again")], gate, arrived, "codex")
        c, _, _, _ = _make_botference(tmp_path=tmp_path)
        c.claude, c.codex = claude, codex
        ui = MockUI()
        await c.handle_input("/parallel is this a good idea?", ui)

        assert sorted(arrived) == ["claude", "codex"]
        # neither prompt carried the other's reply
        assert "Codex's take" not in claude.send_calls[0]
        assert "Claude's take" not in codex.send_calls[0]
        # both replies are in the shared history
        speakers = [e.speaker for e in c.transcript.entries]
        assert speakers.count("claude") == 1 and speakers.count("codex") == 1
        # no bot-to-bot thread followed: one call each
        assert len(claude.send_calls) + len(claude.resume_calls) == 1
        assert len(codex.send_calls) + len(codex.resume_calls) == 1
        # the reader's echo says so
        user_echo = [t for sp, t in ui.room_entries if sp == "user"][0]
        assert user_echo.startswith("/parallel ")

        # on the NEXT turn each bot is shown the other's parallel reply
        gate.clear(); arrived.clear()
        await c.handle_input("/parallel and now?", ui)
        # (GateAdapter routes resume through send, so the second send is the resume)
        assert "Codex's take" in claude.send_calls[1]
        assert "Claude's take" in codex.send_calls[1]

    async def test_a_bare_parallel_sends_nothing(self, tmp_path):
        c, claude, codex, ui = _make_botference(tmp_path=tmp_path)
        await c.handle_input("/parallel", ui)
        assert not claude.send_calls and not codex.send_calls
        assert any("/parallel" in t for sp, t in ui.room_entries if sp == "system")


# ── /fresh: the no-summary restart ────────────────────────


class TestParseFresh:
    def test_targets(self):
        for raw, target in (("/fresh @claude", "claude"), ("/fresh codex", "codex"),
                            ("/fresh @both", "both"), ("/fresh @all", "both")):
            p = parse_input(raw)
            assert p.kind is InputKind.FRESH and p.target == target

    def test_no_target_is_usage(self):
        p = parse_input("/fresh")
        assert p.kind is InputKind.FRESH and p.target == ""


@pytest.mark.asyncio
class TestFreshRestart:
    async def test_the_bot_forgets_the_chat_and_the_other_is_told(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok("I refuse to discuss that."), _ok("Happy to: entry vehicles…")],
            codex_responses=[_ok("Codex says hi"), _ok("Codex again")],
            tmp_path=tmp_path,
        )
        await c.handle_input("@all hypersonic glide vehicle entry dynamics", ui)
        assert "claude" in c._models_initialized
        await c.handle_input("/fresh @claude", ui)
        assert "claude" not in c._models_initialized
        assert claude.session_id == ""
        notes = [t for sp, t in ui.room_entries if sp == "system" and "clean memory" in t]
        assert len(notes) == 1
        # the next message starts a new session whose prompt carries no history
        await c.handle_input("@claude entry-vehicle guidance: what matters most?", ui)
        assert len(claude.send_calls) == 2
        fresh_prompt = claude.send_calls[1]
        assert "hypersonic glide vehicle" not in fresh_prompt
        assert "I refuse" not in fresh_prompt
        assert "was restarted with a clean memory" not in fresh_prompt
        assert "entry-vehicle guidance" in fresh_prompt
        # …while Codex keeps its memory and is told
        await c.handle_input("@codex and you?", ui)
        assert "was restarted with a clean memory" in codex.resume_calls[-1]

    async def test_both(self, tmp_path):
        c, claude, codex, ui = _make_botference(tmp_path=tmp_path)
        await c.handle_input("@all hello", ui)
        await c.handle_input("/fresh @both", ui)
        assert not c._models_initialized

    async def test_no_target_prints_usage(self, tmp_path):
        c, claude, codex, ui = _make_botference(tmp_path=tmp_path)
        await c.handle_input("/fresh", ui)
        assert any("Usage: /fresh" in t for sp, t in ui.room_entries if sp == "system")


# ── the model's own safety filter said no → fall back to Opus 5.5 ──


REFUSAL = ("API Error: Fable 5.1's safeguards flagged this message "
           "(https://www.anthropic.com/legal/aup). This sometimes happens with safe, "
           "normal conversations. Claude Code can't respond to this message with Fable 5.1.")


@pytest.mark.asyncio
class TestSafeguardFallback:
    async def test_a_refused_resume_switches_to_opus_5_5_and_retries(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok("first turn fine"), _ok(REFUSAL), _ok("Entry vehicles: the answer.")],
            tmp_path=tmp_path,
        )
        claude.model = "claude-fable-5-1[1m]"
        await c.handle_input("@claude hello", ui)
        await c.handle_input("@claude hypersonic glide vehicle entry dynamics?", ui)
        assert claude.model == "claude-opus-5-5"
        assert len(claude.resume_calls) == 2, "the message was retried once on the new model"
        assert "safeguards declined" in claude.resume_calls[1]
        assert "Entry vehicles: the answer." in [t for sp, t in ui.room_entries if sp == "claude"]
        notices = [t for sp, t in ui.room_entries if sp == "system" and "Switching this chat's Claude to claude-opus-5-5" in t]
        assert len(notices) == 1
        # saved with the chat
        assert c._session_payload()["claude"]["model"] == "claude-opus-5-5"

    async def test_a_refused_first_turn_is_retried_too(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[AdapterResponse(text=REFUSAL, exit_code=1), _ok("Fine on Opus.")],
            tmp_path=tmp_path,
        )
        claude.model = "claude-fable-5-1"
        await c.handle_input("@claude entry corridor design", ui)
        assert claude.model == "claude-opus-5-5"
        assert len(claude.send_calls) == 2
        assert "Fine on Opus." in [t for sp, t in ui.room_entries if sp == "claude"]

    async def test_the_list_runs_out(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok(REFUSAL), _ok(REFUSAL), _ok(REFUSAL), _ok("never")],
            tmp_path=tmp_path,
        )
        claude.model = "claude-fable-5-1"
        await c.handle_input("@claude hello", ui)
        # fable → opus-5-5 → opus-5, then stop
        assert claude.model == "claude-opus-5"
        assert len(claude.send_calls) + len(claude.resume_calls) == 3
        assert any("every model on the fallback list" in t for sp, t in ui.room_entries if sp == "system")

    async def test_codex_and_ordinary_errors_are_left_alone(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok("Error: something else broke")],
            codex_responses=[_ok(REFUSAL)],
            tmp_path=tmp_path,
        )
        claude.model = "claude-fable-5-1"
        await c.handle_input("@all hi", ui)
        assert claude.model == "claude-fable-5-1"
        assert len(claude.send_calls) == 1 and len(codex.send_calls) == 1


# ── hyphenated project verbs ──────────────────────────────


class TestProjectVerbAliases:
    def test_each_verb_is_the_project_command(self):
        cases = {
            "/new-project hypersonic space vehicles": "create hypersonic space vehicles",
            "/open-project lff": "open lff",
            "/assign-project abc lff": "assign abc lff",
            "/unfile-project": "unfile",
            "/clear-project": "clear",
            "/current-project": "current",
            "/project-contents lff": "contents lff",
            "/project-github lff": "github lff",
            "/archive-project lff": "archive lff",
            "/unarchive-project lff": "unarchive lff",
            "/project-from-chat": "create-from-chat",
            "/activate-build": "activate-build",
        }
        for raw, body in cases.items():
            p = parse_input(raw)
            assert p.kind is InputKind.PROJECT and p.body == body, raw

    def test_new_is_still_a_new_chat(self):
        assert parse_input("/new").kind is InputKind.NEW


@pytest.mark.asyncio
class TestProjectNoMatch:
    async def test_a_bare_title_that_matches_nothing_says_how_to_create(self, tmp_path):
        c, claude, codex, ui = _make_botference(tmp_path=tmp_path)
        await c.handle_input("/project hypersonic space vehicles", ui)
        note = [t for sp, t in ui.room_entries if sp == "system"][-1]
        assert note.startswith("⚠ No project matched")
        assert "/new-project hypersonic space vehicles" in note


# ── ticks reach the bots; projects and sources stay in their lane ──


@pytest.mark.asyncio
class TestTicksReachTheBots:
    async def test_a_tick_flips_the_item_and_leaves_a_note(self, tmp_path):
        c, claude, codex, ui = _make_botference(
            claude_responses=[_ok("Plan:\n- [ ] Book the MRI\n- [ ] Ask about the meniscus"), _ok("Noted.")],
            tmp_path=tmp_path,
        )
        await c.handle_input("@claude what next?", ui)
        assert c.record_tick("Book the MRI", True, ui) is True
        claude_entry = [e for e in c.transcript.entries if e.speaker == "claude"][-1]
        assert "- [x] Book the MRI" in claude_entry.text
        assert "- [ ] Ask about the meniscus" in claude_entry.text
        shown = [r for r in c._room_history if r.speaker == "claude"][-1]
        assert "- [x] Book the MRI" in shown.text
        assert c.transcript.entries[-1].text == "[User ticked: Book the MRI]"
        # the next turn carries both the flipped list and the note
        await c.handle_input("@claude go on", ui)
        assert "[User ticked: Book the MRI]" in claude.resume_calls[-1]
        # untick works, and an unknown item is a no-op
        assert c.record_tick("Book the MRI", False, ui) is True
        assert any("- [ ] Book the MRI" in e.text for e in c.transcript.entries if e.speaker == "claude")
        assert not any("- [x] Book the MRI" in e.text for e in c.transcript.entries)
        assert c.record_tick("Something never listed", True, ui) is False


@pytest.mark.asyncio
class TestProjectCreationLeavesEstablishedChats:
    async def test_a_fresh_chat_is_filed_an_established_one_is_not(self, tmp_path):
        c, claude, codex, ui = _make_botference(tmp_path=tmp_path)
        (tmp_path / "projects").mkdir(exist_ok=True)
        await c.handle_input("/new-project Fresh Thing", ui)
        assert c.session_project_id == "fresh-thing"
        c2, claude2, codex2, ui2 = _make_botference(tmp_path=tmp_path)
        await c2.handle_input("@claude my knee hurts", ui2)
        await c2.handle_input("/new-project Rocket Landing", ui2)
        assert c2.session_project_id == ""
        assert c2.active_project_id == ""
        note = [t for sp, t in ui2.room_entries if sp == "system"][-1]
        assert "stays where it is" in note and "/assign-project rocket-landing" in note


@pytest.mark.asyncio
class TestVerificationSourcesStayInLane:
    async def test_project_files_count_only_when_the_room_touched_them(self, tmp_path):
        c, claude, codex, ui = _make_botference(tmp_path=tmp_path)
        (tmp_path / "projects").mkdir(exist_ok=True)
        await c.handle_input("/new-project Pdg", ui)
        root = tmp_path / "projects" / "pdg"
        (root / "notes.md").write_text("Açıkmeşe lossless convexification notes")
        # PROJECT.md as written by botference is a template — never a source
        assert c._is_template_project_file(root / "PROJECT.md")
        assert not c._is_template_project_file(root / "notes.md")
        # the room has not mentioned the project: nothing from it is a source
        await c.handle_input("@claude how is my knee?", ui)
        assert "Project Pdg" not in c._verification_sources()
        # …until it does
        await c.handle_input("@claude look at notes.md in the pdg folder", ui)
        src = c._verification_sources()
        assert "Project Pdg" in src and "notes.md" in src and "PROJECT.md" not in src
