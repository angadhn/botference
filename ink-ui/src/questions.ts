// "Which question is on screen?" — the protected-write pop-up and the
// "choose one" pop-up, as one named mode. Same pattern as turnState.ts.
//
// The modes, in one list. The current state lives in one field in App.tsx and
// changes only through moveQuestions(), which refuses an illegal move.
//
//   none        no question; the typing box is shown
//   permission  a bot asks to write a protected file (Allow once / always / Deny)
//   choice      the engine asks the user to pick one option from a list
//
// Only one question is on screen at a time. A question that arrives while
// another is up waits its turn, in arrival order, and comes up when the one on
// screen is cleared by the engine. Nothing overwrites the question on screen.
//
// The engine (bridge) tags each question with a request_id. The answer sends it
// back as request_id so a late answer can never answer a different question.
// An older bridge sends no request_id; then the answer goes without one, as
// before.

import { permissionResponse, type PermissionChoice } from "./permission.js";

export const QUESTION_MODES = ["none", "permission", "choice"] as const;
export type QuestionMode = (typeof QUESTION_MODES)[number];

export interface PermissionQuestion {
  kind: "permission";
  request_id?: string;
  model: string;
  path: string;
  reason: string;
  /** The answer the cursor is on. */
  highlighted: PermissionChoice;
}

export interface ChoiceQuestion {
  kind: "choice";
  request_id?: string;
  prompt: string;
  options: string[];
  /** The option the cursor is on. */
  highlighted: number;
}

export type Question = PermissionQuestion | ChoiceQuestion;

export type QuestionState =
  | { mode: "none"; waiting: readonly [] }
  | { mode: "permission"; onScreen: PermissionQuestion; waiting: readonly Question[] }
  | { mode: "choice"; onScreen: ChoiceQuestion; waiting: readonly Question[] };

export const NO_QUESTION: QuestionState = { mode: "none", waiting: [] };

const ALLOWED_MOVES: Record<QuestionMode, readonly QuestionMode[]> = {
  none: ["permission", "choice"],
  // permission -> permission / choice -> choice: the next waiting question of
  // the same kind comes up after the one on screen is cleared.
  permission: ["none", "permission", "choice"],
  choice: ["none", "choice", "permission"],
};

/** True when the mode may go from `from` to `to`. */
export function canMoveQuestionMode(from: QuestionMode, to: QuestionMode): boolean {
  return ALLOWED_MOVES[from].includes(to);
}

export type QuestionEvent =
  /** The engine asks a question. */
  | { type: "arrived"; question: Question }
  /** The engine says a question is over (answered, or dropped). With a
   *  request_id it names the question; without one (older bridge) it means the
   *  oldest question of that kind. */
  | { type: "cleared"; kind: Question["kind"]; request_id?: string }
  /** The user moves the cursor on the question on screen. */
  | { type: "highlight_permission"; choice: PermissionChoice }
  | { type: "highlight_choice"; index: number }
  /** The engine stopped: every question is gone. */
  | { type: "engine_stopped" };

export type QuestionMove =
  | { ok: true; state: QuestionState; changed: boolean }
  | { ok: false; state: QuestionState; reason: string };

function show(question: Question, waiting: readonly Question[]): QuestionState {
  return question.kind === "permission"
    ? { mode: "permission", onScreen: question, waiting }
    : { mode: "choice", onScreen: question, waiting };
}

function settle(from: QuestionState, to: QuestionState): QuestionMove {
  if (!canMoveQuestionMode(from.mode, to.mode)) {
    return { ok: false, state: from, reason: `no move ${from.mode}->${to.mode}` };
  }
  return { ok: true, state: to, changed: true };
}

function sameQuestion(a: Question, b: Question): boolean {
  return a.kind === b.kind && !!a.request_id && a.request_id === b.request_id;
}

/** The one setter's rule: the new state, or a refusal that keeps `from`. */
export function moveQuestions(from: QuestionState, event: QuestionEvent): QuestionMove {
  switch (event.type) {
    case "arrived": {
      const q = event.question;
      if (from.mode === "none") return settle(from, show(q, []));
      // The same question again (same request_id): already here, ignore.
      if (sameQuestion(from.onScreen, q) || from.waiting.some((w) => sameQuestion(w, q))) {
        return { ok: false, state: from, reason: "already asked" };
      }
      // Another question is up: this one waits its turn.
      return { ok: true, state: { ...from, waiting: [...from.waiting, q] }, changed: true };
    }
    case "cleared": {
      if (from.mode === "none") return { ok: false, state: from, reason: "no question to clear" };
      const matches = (q: Question) =>
        q.kind === event.kind && (!event.request_id || q.request_id === event.request_id);
      if (matches(from.onScreen)) {
        const [next, ...rest] = from.waiting;
        return settle(from, next ? show(next, rest) : NO_QUESTION);
      }
      const i = from.waiting.findIndex(matches);
      if (i < 0) return { ok: false, state: from, reason: "no such question" };
      const waiting = from.waiting.filter((_, j) => j !== i);
      return { ok: true, state: { ...from, waiting }, changed: true };
    }
    case "highlight_permission": {
      if (from.mode !== "permission") return { ok: false, state: from, reason: "no permission question" };
      if (from.onScreen.highlighted === event.choice) return { ok: true, state: from, changed: false };
      return {
        ok: true,
        state: { ...from, onScreen: { ...from.onScreen, highlighted: event.choice } },
        changed: true,
      };
    }
    case "highlight_choice": {
      if (from.mode !== "choice") return { ok: false, state: from, reason: "no choice question" };
      const last = from.onScreen.options.length - 1;
      const index = Math.max(0, Math.min(last, event.index));
      if (from.onScreen.highlighted === index) return { ok: true, state: from, changed: false };
      return {
        ok: true,
        state: { ...from, onScreen: { ...from.onScreen, highlighted: index } },
        changed: true,
      };
    }
    case "engine_stopped":
      if (from.mode === "none") return { ok: true, state: from, changed: false };
      return settle(from, NO_QUESTION);
  }
}

/** A request_id from a bridge event, or undefined (older bridge). */
function requestIdOf(msg: Record<string, unknown>): string | undefined {
  return typeof msg.request_id === "string" && msg.request_id !== "" ? msg.request_id : undefined;
}

/** A permission_request event as a question (cursor on "Allow once"). */
export function permissionQuestionFrom(msg: Record<string, unknown>): PermissionQuestion {
  const request_id = requestIdOf(msg);
  return {
    kind: "permission",
    ...(request_id ? { request_id } : {}),
    model: String(msg.model ?? ""),
    path: String(msg.path ?? ""),
    reason: String(msg.reason ?? ""),
    highlighted: "once",
  };
}

/** A choice_request event as a question (cursor on the first option). */
export function choiceQuestionFrom(msg: Record<string, unknown>): ChoiceQuestion {
  const request_id = requestIdOf(msg);
  return {
    kind: "choice",
    ...(request_id ? { request_id } : {}),
    prompt: typeof msg.prompt === "string" ? msg.prompt : "",
    options: Array.isArray(msg.options) ? (msg.options as unknown[]).map(String) : [],
    highlighted: 0,
  };
}

/** A permission_cleared / choice_cleared event as a "cleared" move. */
export function clearedFrom(kind: Question["kind"], msg: Record<string, unknown>): QuestionEvent {
  const request_id = requestIdOf(msg);
  return { type: "cleared", kind, ...(request_id ? { request_id } : {}) };
}

/** The bridge message answering a permission question. */
export function permissionAnswer(question: PermissionQuestion, choice: PermissionChoice) {
  return permissionResponse(question.request_id, choice);
}

/** The bridge message answering a choice question; index -1 dismisses. */
export function choiceAnswer(question: ChoiceQuestion, index: number) {
  return {
    type: "choice_response" as const,
    ...(question.request_id ? { request_id: question.request_id } : {}),
    index,
  };
}

/** The line under a question when more are waiting, or "" when none are. */
export function waitingNote(state: QuestionState): string {
  const n = state.waiting.length;
  if (n === 0) return "";
  return n === 1
    ? "1 more question after this one."
    : `${n} more questions after this one.`;
}
