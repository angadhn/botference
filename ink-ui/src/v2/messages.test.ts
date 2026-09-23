import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildToolStackText,
  capDisplayEntries,
  createStreamSegmentState,
  DISPLAY_TRIM_KEEP,
  MAX_DISPLAY_ENTRIES,
  PACED_MESSAGE_MAX_CHARS,
  isFinalEntryForSegmentedStream,
  replaceOrInsertStreamEntryBefore,
  replaceOrAppendStreamEntry,
  shouldAppendImmediately,
  shouldPaceEntry,
  textSegmentStreamId,
  toolEventId,
  toolPreviewLine,
  toolSegmentStreamId,
  stripFooterFromStreamEntries,
  stripTrailingJsonFooter,
  agentHeaderLine,
  agentToolsHeaderLine,
  formatAgentStatus,
  parseAgentMeta,
  placeAgentEntry,
  type AgentMeta,
} from "./messages.js";

describe("Ink message pacing", () => {
  it("paces long live model messages", () => {
    assert.equal(shouldPaceEntry("codex", "x".repeat(300)), true);
    assert.equal(shouldPaceEntry("claude", "x".repeat(300)), true);
  });

  it("loads restored messages immediately instead of replaying them", () => {
    assert.equal(shouldAppendImmediately({
      speaker: "codex",
      text: "x".repeat(300),
      restored: true,
    }), true);
  });

  it("does not pace grouped tool stack messages", () => {
    assert.equal(shouldPaceEntry("codex", "Explored\n└ tool call".repeat(50)), false);
  });
});

describe("Ink streamed tool stack", () => {
  it("replaces matching stream entries rather than appending duplicates", () => {
    const entries = replaceOrAppendStreamEntry([
      { speaker: "codex", text: "old", streamId: "s1" },
    ], {
      speaker: "codex",
      text: "new",
      streamId: "s1",
    });
    assert.deepEqual(entries, [{ speaker: "codex", text: "new", streamId: "s1" }]);
  });

  it("inserts streamed tool stacks before their owning response stream", () => {
    const entries = replaceOrInsertStreamEntryBefore([
      { speaker: "codex", text: "final answer", streamId: "s1" },
    ], {
      speaker: "codex",
      text: "Explored\n└ Read README.md",
      streamId: "s1:tools",
    }, "s1");

    assert.deepEqual(entries.map((entry) => entry.streamId), ["s1:tools", "s1"]);
  });

  it("keeps existing streamed tool stack position when updating it", () => {
    const entries = replaceOrInsertStreamEntryBefore([
      { speaker: "codex", text: "Explored\n└ Read README.md", streamId: "s1:tools" },
      { speaker: "codex", text: "final answer", streamId: "s1" },
    ], {
      speaker: "codex",
      text: "Explored\n├ Read README.md\n└ Bash npm test",
      streamId: "s1:tools",
    }, "s1");

    assert.deepEqual(entries.map((entry) => entry.streamId), ["s1:tools", "s1"]);
    assert.equal(entries[0]!.text, "Explored\n├ Read README.md\n└ Bash npm test");
  });

  it("renders grouped streamed tools as a vertical stack", () => {
    assert.equal(toolEventId({ tool_id: "abc", name: "Read" }), "abc");
    assert.equal(toolPreviewLine({
      name: "Read",
      input_preview: "  src/App.tsx\n",
    }), "Read - src/App.tsx");
    assert.equal(
      buildToolStackText(["Read - src/App.tsx", "Search - selection"]),
      "Explored\n├ Read - src/App.tsx\n└ Search - selection",
    );
    assert.equal(toolPreviewLine({
      name: "Bash",
      input_preview: "python3 tools/cli.py visual_check_html '{\"html_file\":\"plot.html\"}'",
    }), "[verify] Bash - python3 tools/cli.py visual_check_html '{\"html_file\":\"plot.html\"}'");
  });

  it("allocates chronological text and tool stream segments", () => {
    const state = createStreamSegmentState();
    const firstText = textSegmentStreamId("s1", state);
    const firstTool = toolSegmentStreamId("s1", state, "tool-a", true);
    const sameTool = toolSegmentStreamId("s1", state, "tool-a", false);
    const secondText = textSegmentStreamId("s1", state);
    const secondTool = toolSegmentStreamId("s1", state, "tool-b", true);

    assert.equal(firstText, "s1:text:0");
    assert.equal(firstTool, "s1:tools:0");
    assert.equal(sameTool, "s1:tools:0");
    assert.equal(secondText, "s1:text:1");
    assert.equal(secondTool, "s1:tools:1");
  });

  it("recognizes final controller entries superseded by segmented streams", () => {
    assert.equal(isFinalEntryForSegmentedStream("s1", "s1"), true);
    assert.equal(isFinalEntryForSegmentedStream("s1:tools", "s1"), true);
    assert.equal(isFinalEntryForSegmentedStream("s1:text:0", "s1"), false);
    assert.equal(isFinalEntryForSegmentedStream("s1:tools:0", "s1"), false);
  });
});


describe("Routing footer stripping", () => {
  it("removes a trailing JSON footer", () => {
    const text = 'Position stated.\n\n{"status": "converged", "next": "@user", "summary": "done"}';
    assert.equal(stripTrailingJsonFooter(text), "Position stated.");
    assert.equal(stripTrailingJsonFooter("no footer here"), "no footer here");
  });

  it("edits only the stream's last text segment", () => {
    const entries = [
      { streamId: "claude:room:1:text:0", text: "early segment" },
      { streamId: "claude:room:1:tools:0", text: "Read - file" },
      { streamId: "claude:room:1:text:1", text: 'End.\n{"status": "continuing", "next": "@codex", "summary": "s"}' },
      { streamId: "codex:room:2:text:0", text: 'Other.\n{"status": "x", "next": "@user", "summary": "s"}' },
    ];
    const out = stripFooterFromStreamEntries(entries, "claude:room:1");
    assert.equal(out[2]!.text, "End.");
    assert.equal(out[0]!.text, "early segment");
    assert.ok(out[3]!.text.includes('"status"'), "other streams untouched");
    const unchanged = stripFooterFromStreamEntries(out, "claude:room:1");
    assert.equal(unchanged, out);
  });
});

describe("Paced reveal size cap", () => {
  it("lands huge messages whole instead of typing them for minutes", () => {
    assert.equal(shouldPaceEntry("claude", "x".repeat(PACED_MESSAGE_MAX_CHARS)), true);
    assert.equal(shouldPaceEntry("claude", "x".repeat(PACED_MESSAGE_MAX_CHARS + 1)), false);
    assert.equal(shouldAppendImmediately({
      speaker: "codex",
      text: "y".repeat(1_000_000),
    }), true);
  });
});

describe("capDisplayEntries", () => {
  it("returns the same array while under the cap", () => {
    const entries = [{ speaker: "user", text: "a" }];
    assert.equal(capDisplayEntries(entries), entries);
  });

  it("trims to the keep size once the cap is exceeded", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ n: i }));
    const capped = capDisplayEntries(entries, 10, 8);
    assert.equal(capped.length, 8);
    assert.equal(capped[0]!.n, 4);
    assert.equal(capped[capped.length - 1]!.n, 11);
  });

  it("keeps chunky trims so identity stays stable between trims", () => {
    // Just below the cap: untouched (same reference, caches stay hot).
    const nearCap = Array.from({ length: 10 }, (_, i) => ({ n: i }));
    assert.equal(capDisplayEntries(nearCap, 10, 8), nearCap);
    assert.ok(MAX_DISPLAY_ENTRIES > DISPLAY_TRIM_KEEP);
  });
});

describe("summoned agent cards", () => {
  type E = { speaker: string; text: string; streamId?: string; agent?: AgentMeta };
  const meta = (over: Partial<AgentMeta> = {}): AgentMeta => ({
    id: "s1:agent:1",
    card: "report",
    parent_stream_id: "claude-room-3",
    summoned_by: "claude",
    cli: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    label: "Claude Opus 5.5 (high)",
    status: "working",
    elapsed_s: 0,
    ...over,
  });

  it("places an agent card directly under the summoning bot's message", () => {
    const entries: E[] = [
      { speaker: "user", text: "build it" },
      { speaker: "claude", text: "summoning…", streamId: "claude-room-3" },
      { speaker: "codex", text: "I'll wait", streamId: "codex-room-4" },
    ];
    const card = { speaker: "agent", text: "building…", streamId: "s1:agent:1:card", agent: meta() };
    const next = placeAgentEntry(entries, card);
    assert.equal(next.length, 4);
    assert.equal(next[2]!.streamId, "s1:agent:1:card");
    assert.equal(next[3]!.speaker, "codex");
  });

  it("nests under the parent's streamed segments when the final entry was dropped", () => {
    const entries: E[] = [
      { speaker: "claude", text: "part one", streamId: "claude-room-3:text:0" },
      { speaker: "claude", text: "Explored", streamId: "claude-room-3:tools:0" },
      { speaker: "codex", text: "later", streamId: "codex-room-4" },
    ];
    const next = placeAgentEntry(entries, {
      speaker: "agent", text: "building…", streamId: "s1:agent:1:card", agent: meta(),
    });
    assert.equal(next[2]!.streamId, "s1:agent:1:card");
  });

  it("replaces the working card with the report card in place", () => {
    const working = { speaker: "agent", text: "building…", streamId: "s1:agent:1:card", agent: meta() };
    const entries: E[] = [
      { speaker: "claude", text: "summoning…", streamId: "claude-room-3" },
      working,
      { speaker: "codex", text: "later", streamId: "codex-room-4" },
    ];
    const report = {
      speaker: "agent", text: "Done: wrote foo.py", streamId: "s1:agent:1:card",
      agent: meta({ status: "done", elapsed_s: 95 }),
    };
    const next = placeAgentEntry(entries, report);
    assert.equal(next.length, 3);
    assert.equal(next[1]!.text, "Done: wrote foo.py");
    assert.equal(next[1]!.agent?.status, "done");
    assert.equal(next[2]!.speaker, "codex");
  });

  it("puts the tools card after the same agent's report card, before later messages", () => {
    const entries: E[] = [
      { speaker: "claude", text: "summoning…", streamId: "claude-room-3" },
      { speaker: "agent", text: "building…", streamId: "s1:agent:1:card", agent: meta() },
      { speaker: "codex", text: "later", streamId: "codex-room-4" },
    ];
    const next = placeAgentEntry(entries, {
      speaker: "agent", text: "Explored\n└ Read foo.py", streamId: "s1:agent:1:tools",
      agent: meta({ card: "tools" }),
    });
    assert.equal(next[2]!.streamId, "s1:agent:1:tools");
    assert.equal(next[3]!.speaker, "codex");
  });

  it("falls back to the summoner's latest message, then to appending", () => {
    const entries: E[] = [
      { speaker: "codex", text: "hi" },
      { speaker: "claude", text: "summoning (restored, no stream id)" },
      { speaker: "user", text: "ok" },
    ];
    const byBot = placeAgentEntry(entries, {
      speaker: "agent", text: "x", streamId: "s1:agent:1:card", agent: meta({ parent_stream_id: "" }),
    });
    assert.equal(byBot[2]!.speaker, "agent");
    assert.equal(byBot[3]!.speaker, "user");

    const appended = placeAgentEntry([{ speaker: "user", text: "ok" }] as E[], {
      speaker: "agent", text: "x", streamId: "s1:agent:1:card",
      agent: meta({ parent_stream_id: "", summoned_by: "codex" }),
    });
    assert.equal(appended[1]!.speaker, "agent");
  });

  it("formats the header and status", () => {
    assert.equal(
      agentHeaderLine(meta()),
      "↳ agent · Claude Opus 5.5 (high) · summoned by Claude · working…",
    );
    assert.equal(formatAgentStatus("done", 95), "done in 1:35");
    assert.equal(formatAgentStatus("failed", 7), "failed after 0:07");
    assert.equal(formatAgentStatus("timeout", 600), "timed out after 10:00");
    assert.equal(agentToolsHeaderLine("Explored\n├ Read a\n└ Edit b"), "↳ tools: 2 calls");
    assert.equal(agentToolsHeaderLine("Explored\n└ Read a"), "↳ tools: 1 call");
  });

  it("parses wire metadata and rejects entries without an id", () => {
    assert.equal(parseAgentMeta({ card: "report" }), undefined);
    assert.equal(parseAgentMeta("nope"), undefined);
    const parsed = parseAgentMeta({ id: "a", status: "done", elapsed_s: 12, label: "L" });
    assert.equal(parsed?.id, "a");
    assert.equal(parsed?.elapsed_s, 12);
    assert.equal(parsed?.label, "L");
  });
});
