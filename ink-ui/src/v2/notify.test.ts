import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  notificationSequence,
  sanitizeNotificationText,
  sendDesktopNotification,
  supportsOsc777,
} from "./notify.js";

describe("desktop notification sequences", () => {
  it("detects OSC 777 terminals from TERM_PROGRAM and TERM", () => {
    assert.equal(supportsOsc777({ TERM_PROGRAM: "ghostty" }), true);
    assert.equal(supportsOsc777({ TERM: "xterm-ghostty" }), true);
    assert.equal(supportsOsc777({ TERM_PROGRAM: "WezTerm" }), true);
    assert.equal(supportsOsc777({ TERM: "foot" }), true);
    assert.equal(supportsOsc777({ TERM_PROGRAM: "iTerm.app" }), false);
    assert.equal(supportsOsc777({}), false);
  });

  it("builds OSC 777 with title and body on ghostty", () => {
    assert.equal(
      notificationSequence("botference", "floor is yours", {
        TERM_PROGRAM: "ghostty",
      }),
      "\x1b]777;notify;botference;floor is yours\x07",
    );
  });

  it("falls back to OSC 9 on other terminals", () => {
    assert.equal(
      notificationSequence("botference", "floor is yours", {
        TERM_PROGRAM: "iTerm.app",
      }),
      "\x1b]9;botference: floor is yours\x07",
    );
  });

  it("wraps in a tmux passthrough inside tmux", () => {
    assert.equal(
      notificationSequence("botference", "done", {
        TERM: "tmux-256color",
        TMUX: "/tmp/tmux-501/default,123,0",
      }),
      "\x1bPtmux;\x1b\x1b]9;botference: done\x07\x1b\\",
    );
  });

  it("sanitizes control characters, separators, and length", () => {
    assert.equal(
      sanitizeNotificationText("a\x1b]0;evil\x07b; c"),
      "a ]0 evil b c",
    );
    const long = sanitizeNotificationText("x".repeat(500));
    assert.equal(long.length, 120);
    assert.ok(long.endsWith("…"));
  });

  it("writes the sequence through the injected stdout writer", () => {
    const writes: string[] = [];
    sendDesktopNotification("botference", "hello", {
      env: { TERM_PROGRAM: "ghostty" },
      writeStdout: (sequence) => writes.push(sequence),
    });
    assert.deepEqual(writes, ["\x1b]777;notify;botference;hello\x07"]);
  });

  it("substitutes a default title when sanitization empties it", () => {
    assert.equal(
      notificationSequence("\x07\x07", "body", {}),
      "\x1b]9;botference: body\x07",
    );
  });
});
