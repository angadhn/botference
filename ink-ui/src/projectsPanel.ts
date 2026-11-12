// "Is the project list showing, and does it have the keys?" — one named mode.
// Same pattern as turnState.ts and mouseMode.ts.
//
// The modes, in one list. The current mode lives in one field in App.tsx and
// changes only through moveProjectsPanel(), which refuses an illegal move.
//
//   hidden   the project list is off (Ctrl+P); the room has the keys
//   shown    the project list is on screen; the room has the keys
//   focused  the project list is on screen and has the keys (Tab)
//
// Which pane has the keys is read off this mode (focusedPaneFor), never kept
// in a second field, so focus can never sit on a hidden list. A list the
// layout had no room to draw (terminal too narrow) counts as hidden for focus.

export const PROJECTS_PANEL_MODES = ["hidden", "shown", "focused"] as const;
export type ProjectsPanelMode = (typeof PROJECTS_PANEL_MODES)[number];

const PROJECTS_PANEL_MOVES: Record<ProjectsPanelMode, readonly ProjectsPanelMode[]> = {
  hidden: ["shown"],
  shown: ["hidden", "focused"],
  focused: ["shown", "hidden"],
};

export type ProjectsPanelMove =
  | { ok: true; mode: ProjectsPanelMode; changed: boolean }
  | { ok: false; mode: ProjectsPanelMode };

/** True when the panel may go from `from` to `to`. */
export function canMoveProjectsPanel(from: ProjectsPanelMode, to: ProjectsPanelMode): boolean {
  return PROJECTS_PANEL_MOVES[from].includes(to);
}

/** The one setter's rule. Staying put is a no-op. */
export function moveProjectsPanel(
  from: ProjectsPanelMode,
  to: ProjectsPanelMode,
): ProjectsPanelMove {
  if (from === to) return { ok: true, mode: to, changed: false };
  if (!canMoveProjectsPanel(from, to)) return { ok: false, mode: from };
  return { ok: true, mode: to, changed: true };
}

/** Does the layout reserve a column for the list in this mode? */
export function projectsListVisible(mode: ProjectsPanelMode): boolean {
  return mode !== "hidden";
}

/** Ctrl+P: hide the list, or show it again. */
export function toggledProjectsPanel(mode: ProjectsPanelMode): ProjectsPanelMode {
  return mode === "hidden" ? "shown" : "hidden";
}

/** Tab: hand the keys to the list, or back to the room. */
export function tabbedProjectsPanel(mode: ProjectsPanelMode): ProjectsPanelMode {
  return mode === "focused" ? "shown" : "focused";
}

/** Which pane has the keys. `drawn` is false when the layout had no room to
 *  draw the list; then the room has the keys whatever the mode says. */
export function focusedPaneFor(mode: ProjectsPanelMode, drawn: boolean): "room" | "projects" {
  return mode === "focused" && drawn ? "projects" : "room";
}
