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
