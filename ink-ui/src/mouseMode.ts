// What the mouse does right now, and the app's hold on the terminal — each as
// one named mode, kept in one field, changed only through one move function
// that refuses an illegal move. Same pattern as turnState.ts.
//
// 1) MOUSE_MODES — chosen by the user with Ctrl+Y (field in App.tsx):
//
//   app_scroll       the app reads the mouse: the wheel scrolls, a drag selects
//                    text inside the app and copies it
//   terminal_select  the app lets go of the mouse so the terminal's own text
//                    selection works; Ctrl+Y or Esc goes back
//
// 2) TERMINAL_MOUSE_MODES — what the terminal has actually been told
//    (field in index.tsx):
//
//   tracking_off  the terminal sends no mouse events to the app
//   tracking_on   the terminal sends mouse events to the app
//   restored      the terminal was handed back to the shell on the way out —
//                 final; nothing turns tracking on again, or the shell prompt
//                 fills with mouse escape codes

export const MOUSE_MODES = ["app_scroll", "terminal_select"] as const;
export type MouseMode = (typeof MOUSE_MODES)[number];

const MOUSE_MOVES: Record<MouseMode, readonly MouseMode[]> = {
  app_scroll: ["terminal_select"],
  terminal_select: ["app_scroll"],
};

export type MouseMove =
  | { ok: true; mode: MouseMode; changed: boolean }
  | { ok: false; mode: MouseMode };

/** The one setter's rule for the mouse mode. Staying put is a no-op. */
export function moveMouseMode(from: MouseMode, to: MouseMode): MouseMove {
  if (from === to) return { ok: true, mode: to, changed: false };
  if (!MOUSE_MOVES[from].includes(to)) return { ok: false, mode: from };
  return { ok: true, mode: to, changed: true };
}

/** Ctrl+Y: the other mode. */
export function toggledMouseMode(mode: MouseMode): MouseMode {
  return mode === "app_scroll" ? "terminal_select" : "app_scroll";
}

/** Does the app ask the terminal for mouse events in this mode? */
export function wantsMouseTracking(mode: MouseMode): boolean {
  return mode === "app_scroll";
}

export const MOUSE_SELECTION_HINT =
  "Mouse selection mode: drag to select text; Ctrl+Y or Esc returns to scrolling.";

export const TERMINAL_MOUSE_MODES = ["tracking_off", "tracking_on", "restored"] as const;
export type TerminalMouseMode = (typeof TERMINAL_MOUSE_MODES)[number];

const TERMINAL_MOUSE_MOVES: Record<TerminalMouseMode, readonly TerminalMouseMode[]> = {
  tracking_off: ["tracking_on", "restored"],
  tracking_on: ["tracking_off", "restored"],
  restored: [],
};

export type TerminalMouseMove =
  | { ok: true; mode: TerminalMouseMode; changed: boolean }
  | { ok: false; mode: TerminalMouseMode };

/** The one setter's rule for the terminal's mouse state. Staying put is a
 *  no-op; nothing leaves restored. */
export function moveTerminalMouse(
  from: TerminalMouseMode,
  to: TerminalMouseMode,
): TerminalMouseMove {
  if (from === to) return { ok: true, mode: to, changed: false };
  if (!TERMINAL_MOUSE_MOVES[from].includes(to)) return { ok: false, mode: from };
  return { ok: true, mode: to, changed: true };
}
