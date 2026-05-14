import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildToolStackText,
  createStreamSegmentState,
  isFinalEntryForSegmentedStream,
  replaceOrInsertStreamEntryBefore,
  replaceOrAppendStreamEntry,
  shouldAppendImmediately,
  shouldPaceEntry,
  textSegmentStreamId,
  toolEventId,
  toolPreviewLine,
  toolSegmentStreamId,
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
