import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  SCROLL_GLIDE_MODES,
  canMoveScrollGlide,
  moveScrollGlide,
  targetFollowsPane,
} from "./scrollGlide.js";

describe("scroll glide (is the pane easing to a scroll position?)", () => {
  it("names every mode in one list", () => {
    assert.deepEqual([...SCROLL_GLIDE_MODES], ["still", "gliding", "closed"]);
  });

  it("a wheel turn goes still -> gliding -> still", () => {
    assert.deepEqual(moveScrollGlide("still", "gliding"), { ok: true, mode: "gliding", changed: true });
    assert.deepEqual(moveScrollGlide("gliding", "still"), { ok: true, mode: "still", changed: true });
  });

  it("a second wheel turn while gliding starts nothing new", () => {
    assert.deepEqual(moveScrollGlide("gliding", "gliding"), { ok: true, mode: "gliding", changed: false });
  });

  it("closing is final: no glide starts after the app shuts down", () => {
    assert.equal(canMoveScrollGlide("still", "closed"), true);
    assert.equal(canMoveScrollGlide("gliding", "closed"), true);
    assert.deepEqual(moveScrollGlide("closed", "gliding"), { ok: false, mode: "closed" });
    assert.deepEqual(moveScrollGlide("closed", "still"), { ok: false, mode: "closed" });
  });

  it("the target follows the pane only while still", () => {
    assert.equal(targetFollowsPane("still"), true);
    assert.equal(targetFollowsPane("gliding"), false);
    assert.equal(targetFollowsPane("closed"), false);
  });
});
