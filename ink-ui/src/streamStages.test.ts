import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  NO_STREAMS,
  STREAM_STAGES,
  dropsFinalEntry,
  moveStreamStages,
  type StreamStageEvent,
  type StreamStages,
} from "./streamStages.js";

function run(events: StreamStageEvent[], from: StreamStages = NO_STREAMS): StreamStages {
  let stages = from;
  for (const event of events) stages = moveStreamStages(stages, event).stages;
  return stages;
}

describe("stream stages (how far along is each streamed reply?)", () => {
  it("names every stage in one list", () => {
    assert.deepEqual([...STREAM_STAGES], ["started", "streaming", "done_unshown", "done_shown"]);
  });

  it("a reply with segments ends done_shown, and its final entry is dropped", () => {
    const stages = run([
      { type: "start", streamId: "s1" },
      { type: "segment", streamId: "s1" },
      { type: "segment", streamId: "s1" },
      { type: "done", streamId: "s1" },
    ]);
    assert.equal(stages.get("s1"), "done_shown");
    assert.equal(dropsFinalEntry(stages, "s1"), true);
    assert.equal(dropsFinalEntry(stages, "s1:tools"), true);
    assert.equal(dropsFinalEntry(stages, "s1:text:0"), false);
    assert.equal(dropsFinalEntry(stages, "s2"), false);
  });

  it("a reply that showed nothing ends done_unshown, and its final entry is kept", () => {
    const stages = run([{ type: "start", streamId: "s1" }, { type: "done", streamId: "s1" }]);
    assert.equal(stages.get("s1"), "done_unshown");
    assert.equal(dropsFinalEntry(stages, "s1"), false);
  });

  it("a reply still streaming keeps its final entry (it has not ended)", () => {
    const stages = run([{ type: "start", streamId: "s1" }, { type: "segment", streamId: "s1" }]);
    assert.equal(stages.get("s1"), "streaming");
    assert.equal(dropsFinalEntry(stages, "s1"), false);
  });

  it("a second segment is a no-op, so nothing is copied", () => {
    const stages = run([{ type: "segment", streamId: "s1" }]);
    const move = moveStreamStages(stages, { type: "segment", streamId: "s1" });
    assert.deepEqual(move, { ok: true, stages, changed: false });
  });

  it("refuses a second done", () => {
    const stages = run([{ type: "segment", streamId: "s1" }, { type: "done", streamId: "s1" }]);
    const move = moveStreamStages(stages, { type: "done", streamId: "s1" });
    assert.equal(move.ok, false);
    assert.equal(move.stages, stages);
  });

  it("start begins a reused stream id again", () => {
    const stages = run([
      { type: "segment", streamId: "s1" },
      { type: "done", streamId: "s1" },
      { type: "start", streamId: "s1" },
    ]);
    assert.equal(stages.get("s1"), "started");
    assert.equal(dropsFinalEntry(stages, "s1"), false);
  });

  it("a segment after done_unshown drops the final entry after all", () => {
    const stages = run([
      { type: "done", streamId: "s1" },
      { type: "segment", streamId: "s1" },
    ]);
    assert.equal(stages.get("s1"), "done_shown");
  });

  it("clear_all forgets every stream", () => {
    const stages = run([{ type: "segment", streamId: "s1" }, { type: "clear_all" }]);
    assert.equal(stages.size, 0);
    assert.deepEqual(moveStreamStages(NO_STREAMS, { type: "clear_all" }), {
      ok: true, stages: NO_STREAMS, changed: false,
    });
  });

  it("never changes the map it was given", () => {
    const before = run([{ type: "start", streamId: "s1" }]);
    moveStreamStages(before, { type: "segment", streamId: "s1" });
    assert.equal(before.get("s1"), "started");
  });
});
