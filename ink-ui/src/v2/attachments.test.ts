import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  normalizePathCandidate,
  saveClipboardImage,
  splitPathCandidates,
  tokenizePaste,
} from "./attachments.js";

const HOME = "/Users/tester";

describe("pasted path normalization", () => {
  it("unescapes backslash-escaped spaces and parens", () => {
    assert.equal(
      normalizePathCandidate("/shots/Screenshot\\ 2026-07-08\\ at\\ 11.02.03\\ PM.png", HOME),
      "/shots/Screenshot 2026-07-08 at 11.02.03 PM.png",
    );
    assert.equal(
      normalizePathCandidate("/a/img\\ \\(1\\).png", HOME),
      "/a/img (1).png",
    );
  });

  it("strips quotes, decodes file:// URLs, expands ~", () => {
    assert.equal(normalizePathCandidate('"/a/b c.png"', HOME), "/a/b c.png");
    assert.equal(normalizePathCandidate("'/a/b.png'", HOME), "/a/b.png");
    assert.equal(
      normalizePathCandidate("file:///a/b%20c.png", HOME),
      "/a/b c.png",
    );
    assert.equal(normalizePathCandidate("~/pics/x.png", HOME), `${HOME}/pics/x.png`);
  });
});

describe("splitting multi-path lines", () => {
  it("splits on spaces but honors escapes and quotes", () => {
    assert.deepEqual(
      splitPathCandidates("/a/one.png /b/two.jpg"),
      ["/a/one.png", "/b/two.jpg"],
    );
    assert.deepEqual(
      splitPathCandidates("/a/with\\ space.png /b/two.png"),
      ["/a/with\\ space.png", "/b/two.png"],
    );
    assert.deepEqual(
      splitPathCandidates('"/a/q uoted.png" /b/two.png'),
      ['"/a/q uoted.png"', "/b/two.png"],
    );
  });
});

describe("tokenizePaste", () => {
  const exists = (p: string) => !p.includes("missing");

  it("turns existing image paths into attachments", () => {
    const tokens = tokenizePaste("/shots/a.png", exists, HOME);
    assert.deepEqual(tokens, [{ type: "image", value: "/shots/a.png" }]);
  });

  it("multi-file drag-drop on one line yields multiple attachments", () => {
    const tokens = tokenizePaste(
      "/shots/one\\ shot.png /shots/two.jpg",
      exists,
      HOME,
    );
    assert.deepEqual(tokens, [
      { type: "image", value: "/shots/one shot.png" },
      { type: "image", value: "/shots/two.jpg" },
    ]);
  });

  it("newline-separated paths (Finder Cmd+C) all attach", () => {
    const tokens = tokenizePaste("/a/one.png\n/b/two.png", exists, HOME);
    assert.deepEqual(
      tokens.filter((t) => t.type === "image").map((t) => t.value),
      ["/a/one.png", "/b/two.png"],
    );
  });

  it("nonexistent paths stay visible as text, never dead placeholders", () => {
    const tokens = tokenizePaste("/shots/missing.png", exists, HOME);
    assert.deepEqual(tokens, [{ type: "text", value: "/shots/missing.png" }]);
  });

  it("plain prose passes through untouched", () => {
    const text = "look at the design.png naming convention please";
    assert.deepEqual(tokenizePaste(text, exists, HOME), [
      { type: "text", value: text },
    ]);
  });

  it("mixed text and path on one line keeps both", () => {
    const tokens = tokenizePaste("see /a/pic.png please", exists, HOME);
    assert.deepEqual(tokens, [
      { type: "text", value: "see " },
      { type: "image", value: "/a/pic.png" },
      { type: "text", value: "please" },
    ]);
  });
});

describe("saveClipboardImage", () => {
  it("returns null off macOS without running anything", async () => {
    const result = await saveClipboardImage("/tmp", (() => {
      throw new Error("must not exec");
    }) as never, "linux");
    assert.equal(result, null);
  });

  it("resolves the dest path when osascript reports OK", async () => {
    const calls: string[][] = [];
    const runner = ((cmd: string, args: string[], cb: (e: null, out: string) => void) => {
      calls.push([cmd, ...args]);
      cb(null, "OK\n");
    }) as never;
    const result = await saveClipboardImage("/tmp/dest", runner, "darwin");
    assert.ok(result && result.startsWith("/tmp/dest/botference-clipboard-"));
    assert.equal(calls[0]![0], "osascript");
  });

  it("resolves null when the clipboard has no image", async () => {
    const runner = ((_c: string, _a: string[], cb: (e: null, out: string) => void) => {
      cb(null, "NOIMG\n");
    }) as never;
    assert.equal(await saveClipboardImage("/tmp", runner, "darwin"), null);
  });
});
