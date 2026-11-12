import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  PROJECTS_PANEL_MODES,
  canMoveProjectsPanel,
  focusedPaneFor,
  moveProjectsPanel,
  projectsListVisible,
  tabbedProjectsPanel,
  toggledProjectsPanel,
} from "./projectsPanel.js";

describe("projects panel (is the list showing, and does it have the keys?)", () => {
  it("names every mode in one list", () => {
    assert.deepEqual([...PROJECTS_PANEL_MODES], ["hidden", "shown", "focused"]);
  });

  it("Tab moves shown <-> focused; Ctrl+P hides from either", () => {
    assert.deepEqual(moveProjectsPanel("shown", "focused"), { ok: true, mode: "focused", changed: true });
    assert.deepEqual(moveProjectsPanel("focused", "shown"), { ok: true, mode: "shown", changed: true });
    assert.equal(canMoveProjectsPanel("shown", "hidden"), true);
    assert.equal(canMoveProjectsPanel("focused", "hidden"), true);
  });

  it("refuses focus on a hidden list", () => {
    assert.deepEqual(moveProjectsPanel("hidden", "focused"), { ok: false, mode: "hidden" });
  });

  it("staying put is a no-op", () => {
    assert.deepEqual(moveProjectsPanel("shown", "shown"), { ok: true, mode: "shown", changed: false });
  });

  it("the list is visible unless hidden", () => {
    assert.equal(projectsListVisible("hidden"), false);
    assert.equal(projectsListVisible("shown"), true);
    assert.equal(projectsListVisible("focused"), true);
  });

  it("Ctrl+P and Tab name their target", () => {
    assert.equal(toggledProjectsPanel("hidden"), "shown");
    assert.equal(toggledProjectsPanel("shown"), "hidden");
    assert.equal(toggledProjectsPanel("focused"), "hidden");
    assert.equal(tabbedProjectsPanel("shown"), "focused");
    assert.equal(tabbedProjectsPanel("focused"), "shown");
  });

  it("focus is read off the mode, and the room keeps the keys when the list is not drawn", () => {
    assert.equal(focusedPaneFor("focused", true), "projects");
    assert.equal(focusedPaneFor("focused", false), "room");
    assert.equal(focusedPaneFor("shown", true), "room");
    assert.equal(focusedPaneFor("hidden", false), "room");
  });
});
