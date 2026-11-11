import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  NO_QUESTION,
  QUESTION_MODES,
  canMoveQuestionMode,
  choiceAnswer,
  choiceQuestionFrom,
  clearedFrom,
  moveQuestions,
  permissionAnswer,
  permissionQuestionFrom,
  waitingNote,
  type QuestionState,
} from "./questions.js";

const perm = (id?: string) =>
  permissionQuestionFrom({ type: "permission_request", request_id: id, model: "claude", path: "/p", reason: "r" });
const choice = (id?: string, options = ["a", "b", "c"]) =>
  choiceQuestionFrom({ type: "choice_request", request_id: id, prompt: "Pick", options });

function apply(state: QuestionState, ...events: Parameters<typeof moveQuestions>[1][]): QuestionState {
  for (const e of events) state = moveQuestions(state, e).state;
  return state;
}

describe("questions (which pop-up is on screen)", () => {
  it("names every mode in one list", () => {
    assert.deepEqual([...QUESTION_MODES], ["none", "permission", "choice"]);
  });

  it("legal moves: a question comes up, then clears", () => {
    const up = moveQuestions(NO_QUESTION, { type: "arrived", question: perm("p1") });
    assert.equal(up.ok, true);
    assert.equal(up.state.mode, "permission");
    const down = moveQuestions(up.state, { type: "cleared", kind: "permission", request_id: "p1" });
    assert.equal(down.ok, true);
    assert.equal(down.state.mode, "none");
    assert.equal(canMoveQuestionMode("none", "choice"), true);
    assert.equal(canMoveQuestionMode("choice", "permission"), true);
  });

  it("refused moves keep the state", () => {
    assert.equal(canMoveQuestionMode("none", "none"), false);
    const r1 = moveQuestions(NO_QUESTION, { type: "cleared", kind: "choice" });
    assert.equal(r1.ok, false);
    assert.equal(r1.state, NO_QUESTION);
    const r2 = moveQuestions(NO_QUESTION, { type: "highlight_choice", index: 1 });
    assert.equal(r2.ok, false);
    const onPerm = apply(NO_QUESTION, { type: "arrived", question: perm("p1") });
    const r3 = moveQuestions(onPerm, { type: "highlight_choice", index: 1 });
    assert.equal(r3.ok, false);
    assert.equal(r3.state, onPerm);
    const r4 = moveQuestions(onPerm, { type: "cleared", kind: "choice" });
    assert.equal(r4.ok, false);
    const r5 = moveQuestions(onPerm, { type: "cleared", kind: "permission", request_id: "other" });
    assert.equal(r5.ok, false);
    assert.equal(r5.state.mode, "permission");
  });

  it("a second question waits its turn instead of overwriting the first", () => {
    const s1 = apply(NO_QUESTION, { type: "arrived", question: choice("c1") });
    const s2 = moveQuestions(s1, { type: "arrived", question: perm("p1") });
    assert.equal(s2.ok, true);
    assert.equal(s2.state.mode, "choice");
    assert.equal(s2.state.mode === "choice" && s2.state.onScreen.request_id, "c1");
    assert.equal(s2.state.waiting.length, 1);
    assert.equal(waitingNote(s2.state), "1 more question after this one.");
    // the first clears; the waiting one comes up, cursor at its start
    const s3 = moveQuestions(s2.state, { type: "cleared", kind: "choice", request_id: "c1" });
    assert.equal(s3.state.mode, "permission");
    assert.equal(s3.state.mode === "permission" && s3.state.onScreen.highlighted, "once");
    assert.equal(s3.state.waiting.length, 0);
    assert.equal(waitingNote(s3.state), "");
  });

  it("a second question of the same kind also waits, in arrival order", () => {
    const s = apply(
      NO_QUESTION,
      { type: "arrived", question: perm("p1") },
      { type: "arrived", question: perm("p2") },
      { type: "arrived", question: choice("c1") },
    );
    assert.equal(s.waiting.length, 2);
    const next = apply(s, { type: "cleared", kind: "permission", request_id: "p1" });
    assert.equal(next.mode === "permission" && next.onScreen.request_id, "p2");
    const last = apply(next, { type: "cleared", kind: "permission", request_id: "p2" });
    assert.equal(last.mode, "choice");
  });

  it("the same question twice is not shown twice", () => {
    const s = apply(NO_QUESTION, { type: "arrived", question: perm("p1") });
    const again = moveQuestions(s, { type: "arrived", question: perm("p1") });
    assert.equal(again.ok, false);
    assert.equal(again.state.waiting.length, 0);
  });

  it("a waiting question can clear before it is shown", () => {
    const s = apply(
      NO_QUESTION,
      { type: "arrived", question: choice("c1") },
      { type: "arrived", question: perm("p1") },
      { type: "cleared", kind: "permission", request_id: "p1" },
    );
    assert.equal(s.mode, "choice");
    assert.equal(s.waiting.length, 0);
  });

  it("an older bridge (no request_id) clears the oldest of that kind", () => {
    const s = apply(
      NO_QUESTION,
      { type: "arrived", question: choice() },
      { type: "arrived", question: perm() },
      clearedFrom("choice", { type: "choice_cleared" }),
    );
    assert.equal(s.mode, "permission");
    assert.equal(apply(s, clearedFrom("permission", {})).mode, "none");
  });

  it("moving the cursor stays inside the options", () => {
    let s = apply(NO_QUESTION, { type: "arrived", question: choice("c1") });
    s = apply(s, { type: "highlight_choice", index: 9 });
    assert.equal(s.mode === "choice" && s.onScreen.highlighted, 2);
    s = apply(s, { type: "highlight_choice", index: -4 });
    assert.equal(s.mode === "choice" && s.onScreen.highlighted, 0);
    let p = apply(NO_QUESTION, { type: "arrived", question: perm("p1") });
    p = apply(p, { type: "highlight_permission", choice: "deny" });
    assert.equal(p.mode === "permission" && p.onScreen.highlighted, "deny");
  });

  it("engine stopped drops every question", () => {
    const s = apply(
      NO_QUESTION,
      { type: "arrived", question: perm("p1") },
      { type: "arrived", question: choice("c1") },
      { type: "engine_stopped" },
    );
    assert.deepEqual(s, NO_QUESTION);
  });
});

describe("answers carry the question's request_id back", () => {
  it("choice answer sends request_id when the question had one", () => {
    assert.deepEqual(choiceAnswer(choice("c9"), 1), { type: "choice_response", request_id: "c9", index: 1 });
    assert.deepEqual(choiceAnswer(choice("c9"), -1), { type: "choice_response", request_id: "c9", index: -1 });
  });

  it("choice answer from an older bridge goes as before", () => {
    assert.deepEqual(choiceAnswer(choice(), 0), { type: "choice_response", index: 0 });
  });

  it("permission answer sends request_id back, or leaves it out", () => {
    assert.deepEqual(permissionAnswer(perm("p9"), "once"), { type: "permission_response", request_id: "p9", allow: true });
    assert.deepEqual(permissionAnswer(perm(), "deny"), { type: "permission_response", allow: false });
  });

  it("reads the request_id off the bridge events", () => {
    assert.equal(choiceQuestionFrom({ request_id: "x", options: [1, 2] }).request_id, "x");
    assert.deepEqual(choiceQuestionFrom({ options: [1, 2] }).options, ["1", "2"]);
    assert.equal("request_id" in choiceQuestionFrom({ request_id: 5 }), false);
    assert.deepEqual(clearedFrom("choice", { request_id: "x" }), { type: "cleared", kind: "choice", request_id: "x" });
  });
});
