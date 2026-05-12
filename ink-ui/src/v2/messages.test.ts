import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildToolStackText,
  replaceOrAppendStreamEntry,
  shouldAppendImmediately,
  shouldPaceEntry,
  toolEventId,
  toolPreviewLine,
} from "./messages.js";

describe("Ink v2 message pacing", () => {
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

describe("Ink v2 streamed tool stack", () => {
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

