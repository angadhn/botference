// "Is a bot working?" — the app's turn state, as one named mode.
//
// The modes, in one list. The current mode lives in one field in App.tsx and
// changes only through moveTurnMode(), which refuses an illegal move.
//
//   starting        the engine (Python controller) is opening; not ready yet
//   idle            ready for the next message
//   working         a turn is running
//   stopping        the user pressed Esc; waiting for the turn to wind down
//   engine_stopped  the engine process exited or its pipe closed — final
//
// While starting / working / stopping, a new message is queued by the engine.
// Once engine_stopped, nothing can be sent; nothing leaves this mode.

export const TURN_MODES = [
  "starting",
  "idle",
  "working",
  "stopping",
  "engine_stopped",
] as const;

export type TurnMode = (typeof TURN_MODES)[number];

const ALLOWED_MOVES: Record<TurnMode, readonly TurnMode[]> = {
  starting: ["idle", "stopping", "engine_stopped"],
  idle: ["working", "engine_stopped"],
  working: ["idle", "stopping", "engine_stopped"],
  stopping: ["idle", "engine_stopped"],
  engine_stopped: [],
};

/** True when `from` may move to `to`. Staying put is always allowed (a no-op),
 *  except that nothing ever leaves engine_stopped. */
export function canMoveTurnMode(from: TurnMode, to: TurnMode): boolean {
  if (from === to) return true;
  return ALLOWED_MOVES[from].includes(to);
}

export type TurnMove =
  | { ok: true; mode: TurnMode; changed: boolean }
  | { ok: false; mode: TurnMode };

/** The one setter's rule: returns the new mode, or refuses and keeps `from`. */
export function moveTurnMode(from: TurnMode, to: TurnMode): TurnMove {
  if (!canMoveTurnMode(from, to)) return { ok: false, mode: from };
  return { ok: true, mode: to, changed: from !== to };
}

/** Can a message be handed to the engine right now (now or queued)? */
export function engineAccepts(mode: TurnMode): boolean {
  return mode !== "engine_stopped";
}

/** Does the spinner run in this mode? */
export function showsSpinner(mode: TurnMode): boolean {
  return mode === "starting" || mode === "working" || mode === "stopping";
}

export const ENGINE_STOPPED_STATUS =
  "The engine stopped. Press Ctrl+C, then open botference again.";

export const NOT_SENT_HINT =
  "Not sent: the engine stopped. Your text stays here. Press Ctrl+C, then open botference again.";

/** The one room line shown when the engine stops. */
export function engineStoppedNotice(
  how: { code?: number | null; signal?: string | null; reason?: string },
  restoredCount: number,
): string {
  const detail = how.reason
    ? ` (${how.reason})`
    : how.code !== undefined && how.code !== null
      ? ` (exit code ${how.code})`
      : how.signal
        ? ` (${how.signal})`
        : "";
  const restored = restoredCount > 0
    ? ` What you sent since the last reply may not have been answered; it is back in the typing box.`
    : "";
  return `The engine stopped${detail}, so the bots can't reply.${restored} Press Ctrl+C, then open botference again to carry on.`;
}

/** Put text that never got an answer back into the box, ahead of anything
 *  already typed, so nothing the user wrote is lost. */
export function restoreUnanswered(unanswered: readonly string[], current: string): string {
  const parts = [...unanswered.filter((t) => t.trim() !== "")];
  if (current.trim() !== "") parts.push(current);
  return parts.join("\n\n");
}
