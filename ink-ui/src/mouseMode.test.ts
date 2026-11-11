import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  MOUSE_MODES,
  TERMINAL_MOUSE_MODES,
  moveMouseMode,
  moveTerminalMouse,
  toggledMouseMode,
  wantsMouseTracking,
} from "./mouseMode.js";

describe("mouse mode (what the mouse does right now)", () => {
  it("names every mode in one list", () => {
    assert.deepEqual([...MOUSE_MODES], ["app_scroll", "terminal_select"]);
  });

  it("Ctrl+Y flips between the two and back", () => {
    assert.equal(toggledMouseMode("app_scroll"), "terminal_select");
    assert.equal(toggledMouseMode("terminal_select"), "app_scroll");
    assert.deepEqual(moveMouseMode("app_scroll", "terminal_select"), { ok: true, mode: "terminal_select", changed: true });
    assert.deepEqual(moveMouseMode("terminal_select", "app_scroll"), { ok: true, mode: "app_scroll", changed: true });
  });

  it("staying put is a no-op", () => {
    assert.deepEqual(moveMouseMode("app_scroll", "app_scroll"), { ok: true, mode: "app_scroll", changed: false });
  });

  it("refuses a mode that is not in the list", () => {
    assert.deepEqual(
      moveMouseMode("app_scroll", "dragging" as never),
      { ok: false, mode: "app_scroll" },
    );
  });

  it("only app_scroll asks the terminal for mouse events", () => {
    assert.equal(wantsMouseTracking("app_scroll"), true);
    assert.equal(wantsMouseTracking("terminal_select"), false);
  });
});

describe("terminal mouse state (what the terminal was told)", () => {
  it("names every mode in one list", () => {
    assert.deepEqual([...TERMINAL_MOUSE_MODES], ["tracking_off", "tracking_on", "restored"]);
  });

  it("tracking goes on and off freely", () => {
    assert.deepEqual(moveTerminalMouse("tracking_off", "tracking_on"), { ok: true, mode: "tracking_on", changed: true });
    assert.deepEqual(moveTerminalMouse("tracking_on", "tracking_off"), { ok: true, mode: "tracking_off", changed: true });
  });

  it("either live mode can hand the terminal back", () => {
    assert.equal(moveTerminalMouse("tracking_on", "restored").ok, true);
    assert.equal(moveTerminalMouse("tracking_off", "restored").ok, true);
  });

  it("nothing leaves restored (no tracking on the way out)", () => {
    assert.deepEqual(moveTerminalMouse("restored", "tracking_on"), { ok: false, mode: "restored" });
    assert.deepEqual(moveTerminalMouse("restored", "tracking_off"), { ok: false, mode: "restored" });
    assert.deepEqual(moveTerminalMouse("restored", "restored"), { ok: true, mode: "restored", changed: false });
  });
});
