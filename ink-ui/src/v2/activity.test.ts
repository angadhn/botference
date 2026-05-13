import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  V2_SPINNER_VERBS,
  createV2Activity,
  describeV2ToolActivity,
  formatV2ActivityText,
  startV2ActivityFromInput,
  targetFromInput,
  updateV2ActivityForStream,
  v2ActivityGlyph,
} from "./activity.js";

describe("Ink v2 activity status", () => {
  it("keeps the CC-style action words available", () => {
    assert.equal(V2_SPINNER_VERBS.includes("Prestidigitating"), true);
    assert.notEqual(v2ActivityGlyph(0), v2ActivityGlyph(1));
  });

  it("targets activity from input route and mode", () => {
    assert.equal(targetFromInput("@codex please inspect", "@all", "public"), "codex");
    assert.equal(targetFromInput("/help", "@all", "public"), "system");
    assert.equal(targetFromInput("hello", "@claude", "public"), "claude");
    assert.equal(targetFromInput("hello", "@claude", "caucus"), "all");
  });

  it("formats singular and plural bot activity", () => {
    assert.match(
      formatV2ActivityText(createV2Activity("codex", "public", "seed")),
      /^Codex is .+\.\.\.$/,
    );
    assert.equal(
      formatV2ActivityText(createV2Activity("all", "caucus", "seed")),
      "Claude and Codex are caucusing...",
    );
  });

  it("starts a deterministic activity from user input", () => {
    const first = startV2ActivityFromInput("@claude write tests", "@all", "public", 1);
    const second = startV2ActivityFromInput("@claude write tests", "@all", "public", 2);
    assert.equal(first.target, "claude");
    assert.equal(first.verb, second.verb);
  });

  it("describes tool activity from tool names and previews", () => {
    assert.equal(describeV2ToolActivity({ name: "Read", input_preview: " src/App.tsx\n" }), "Reading src/App.tsx");
    assert.equal(describeV2ToolActivity({ name: "Bash", input_preview: " npm test " }), "Running npm test");
    assert.equal(describeV2ToolActivity({ name: "Mystery" }), "Using Mystery");
  });

  it("prefers active tools over generic responding state", () => {
    const started = updateV2ActivityForStream(null, {
      kind: "tool_start",
      model: "codex",
      stream_id: "s1",
      tool_id: "t1",
      name: "Read",
      input_preview: "README.md",
    }, 1);
    assert.equal(started.target, "codex");
    assert.equal(started.mode, "tool");
    assert.equal(formatV2ActivityText(started), "Codex is reading README.md...");

    const responding = updateV2ActivityForStream(started, {
      kind: "tool_done",
      model: "codex",
      stream_id: "s1",
      tool_id: "t1",
      name: "Read",
    }, 2);
    assert.equal(responding.mode, "responding");
    assert.equal(formatV2ActivityText(responding), "Codex is responding...");
  });
});
