import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildToolStackText,
  replaceOrInsertStreamEntryBefore,
  replaceOrAppendStreamEntry,
  shouldAppendImmediately,
  shouldPaceEntry,
  toolEventId,
  toolPreviewLine,
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
  });
});
