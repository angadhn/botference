// "Is the room pane gliding to a scroll position?" — one named mode. Same
// pattern as turnState.ts and mouseMode.ts.
//
// The modes, in one list. The current mode lives in one field in App.tsx and
// changes only through moveScrollGlide(), which refuses an illegal move.
//
//   still    no scroll animation is running; the pane sits where it is
//   gliding  a wheel turn set a target and a ~60 fps tick is easing the pane
//            toward it; the tick ends the glide when the pane arrives
//   closed   the app is shutting down — final; no glide may start again
//
// The tick's timer handle is a detail of "gliding", not a second mode: it
// exists only while gliding and is dropped by the setter when the glide ends.

export const SCROLL_GLIDE_MODES = ["still", "gliding", "closed"] as const;
export type ScrollGlideMode = (typeof SCROLL_GLIDE_MODES)[number];

const SCROLL_GLIDE_MOVES: Record<ScrollGlideMode, readonly ScrollGlideMode[]> = {
  still: ["gliding", "closed"],
  gliding: ["still", "closed"],
  closed: [],
};

export type ScrollGlideMove =
  | { ok: true; mode: ScrollGlideMode; changed: boolean }
  | { ok: false; mode: ScrollGlideMode };

/** True when the glide may go from `from` to `to`. */
export function canMoveScrollGlide(from: ScrollGlideMode, to: ScrollGlideMode): boolean {
  return SCROLL_GLIDE_MOVES[from].includes(to);
}

/** The one setter's rule. Staying put is a no-op; nothing leaves closed. */
export function moveScrollGlide(from: ScrollGlideMode, to: ScrollGlideMode): ScrollGlideMove {
  if (from === to) return { ok: true, mode: to, changed: false };
  if (!canMoveScrollGlide(from, to)) return { ok: false, mode: from };
  return { ok: true, mode: to, changed: true };
}

/** While still, the scroll target follows the pane (a wheel turn starts from
 *  where the pane is); while gliding, the target leads and the pane follows. */
export function targetFollowsPane(mode: ScrollGlideMode): boolean {
  return mode === "still";
}
