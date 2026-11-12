import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  TURN_MODES,
  activityFor,
  canMoveTurnMode,
  keepsActivity,
  engineAccepts,
  engineStoppedNotice,
  moveTurnMode,
  queueNote,
  restoreUnanswered,
  showsSpinner,
} from "./turnState.js";

describe("turn state (is a bot working?)", () => {
  it("names every mode in one list", () => {
    assert.deepEqual([...TURN_MODES], ["starting", "idle", "working", "stopping", "engine_stopped"]);
  });

  it("a normal turn goes idle -> working -> idle", () => {
    assert.deepEqual(moveTurnMode("starting", "idle"), { ok: true, mode: "idle", changed: true });
    assert.deepEqual(moveTurnMode("idle", "working"), { ok: true, mode: "working", changed: true });
    assert.deepEqual(moveTurnMode("working", "idle"), { ok: true, mode: "idle", changed: true });
  });

  it("Esc moves working -> stopping, and the next ready ends it", () => {
    assert.equal(canMoveTurnMode("working", "stopping"), true);
    assert.equal(canMoveTurnMode("stopping", "idle"), true);
  });

  it("refuses illegal moves and keeps the current mode", () => {
    assert.deepEqual(moveTurnMode("idle", "stopping"), { ok: false, mode: "idle" });
    assert.deepEqual(moveTurnMode("stopping", "working"), { ok: false, mode: "stopping" });
    assert.deepEqual(moveTurnMode("starting", "working"), { ok: false, mode: "starting" });
  });

  it("any live mode can move to engine_stopped, and nothing leaves it", () => {
    for (const mode of TURN_MODES) {
      assert.equal(canMoveTurnMode(mode, "engine_stopped"), true, mode);
    }
    for (const mode of TURN_MODES) {
      if (mode === "engine_stopped") continue;
      assert.deepEqual(moveTurnMode("engine_stopped", mode), { ok: false, mode: "engine_stopped" });
    }
  });

  it("staying put is a no-op, so a second engine-stop report changes nothing", () => {
    assert.deepEqual(moveTurnMode("engine_stopped", "engine_stopped"), { ok: true, mode: "engine_stopped", changed: false });
    assert.deepEqual(moveTurnMode("idle", "idle"), { ok: true, mode: "idle", changed: false });
  });

  it("the spinner runs only while starting, working or stopping", () => {
    assert.deepEqual(TURN_MODES.filter(showsSpinner), ["starting", "working", "stopping"]);
  });

  it("nothing can be sent once the engine stopped", () => {
    assert.deepEqual(TURN_MODES.filter((m) => !engineAccepts(m)), ["engine_stopped"]);
  });

  it("the stop notice is one plain line saying how to carry on", () => {
    const line = engineStoppedNotice({ code: 1 }, 0);
    assert.equal(line, "The engine stopped (exit code 1), so the bots can't reply. Press Ctrl+C, then open botference again to carry on.");
    assert.match(engineStoppedNotice({ signal: "SIGKILL" }, 0), /\(SIGKILL\)/);
    assert.match(engineStoppedNotice({}, 2), /back in the typing box/);
    assert.ok(!engineStoppedNotice({ code: 1 }, 0).includes("\n"));
  });

  it("unanswered text goes back ahead of what is typed, nothing dropped", () => {
    assert.equal(restoreUnanswered(["first", "second"], "draft"), "first\n\nsecond\n\ndraft");
    assert.equal(restoreUnanswered(["only"], ""), "only");
    assert.equal(restoreUnanswered([], "draft"), "draft");
  });
});

describe("who is busy (the turn's activity detail)", () => {
  it("only the spinner modes may carry a busy detail", () => {
    assert.deepEqual(TURN_MODES.filter((m) => keepsActivity(m)), ["starting", "working", "stopping"]);
  });

  it("a bot cannot be busy while idle or after the engine stopped", () => {
    assert.equal(activityFor("idle", { who: "claude" }), null);
    assert.equal(activityFor("engine_stopped", { who: "claude" }), null);
  });

  it("while working, the detail is kept", () => {
    const busy = { who: "codex" };
    assert.equal(activityFor("working", busy), busy);
    assert.equal(activityFor("stopping", busy), busy);
    assert.equal(activityFor("working", null), null);
  });

  it("the queue line is derived from the one count", () => {
    assert.equal(queueNote(0), "");
    assert.equal(queueNote(1), "1 queued message.");
    assert.equal(queueNote(3), "3 queued messages.");
  });
});
