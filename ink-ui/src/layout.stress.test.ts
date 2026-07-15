import { test } from "node:test";
import assert from "node:assert/strict";
import {
  highlightCacheSize,
  preRenderLines,
  type Entry,
} from "./layout.js";
import {
  MAX_DISPLAY_ENTRIES,
  capDisplayEntries,
  replaceOrAppendStreamEntry,
} from "./v2/messages.js";

// Regression smoke for the 2026-07-15 OOM crashes: a very large restored
// session plus a long streaming turn must complete with bounded state.
// (The primary root cause — React's dev reconciler flooding Node's
// user-timing buffer — is covered by pinning NODE_ENV=production in
// dist/bin.js and by v2/perfHygiene; these tests cover the render pipeline
// invariants that keep the Ink side bounded.)

const WIDTH = 120;

interface StressEntry extends Entry {
  streamId?: string;
  restored?: boolean;
}

function makeRestoredEntries(count: number): StressEntry[] {
  const entries: StressEntry[] = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 4;
    let text: string;
    if (kind === 0) {
      text = `Message ${i} with **markdown**, \`inline code\`, and enough prose to wrap across several visual lines at width ${WIDTH} so the flattener does real work.`;
    } else if (kind === 1) {
      text = "```python\ndef handler_" + i + "(value):\n    return value * " + i + "  # comment\n```";
    } else if (kind === 2) {
      text = `Explored\n├ Read core/file_${i}.py\n└ Grep pattern_${i}`;
    } else {
      text = `diff --git a/file${i}.py b/file${i}.py\n@@ -1,2 +1,2 @@\n-old line ${i}\n+new line ${i}`;
    }
    entries.push({ speaker: i % 2 ? "claude" : "codex", text });
  }
  return entries;
}

test("5000 restored entries flatten and stay capped", () => {
  const restored = makeRestoredEntries(5000);
  const capped = capDisplayEntries(restored);
  assert.ok(capped.length <= MAX_DISPLAY_ENTRIES);

  const lines = preRenderLines(capped, WIDTH);
  assert.ok(lines.length > capped.length, "expected multiple lines per entry");
});

test("long streaming turn over a large session completes with bounded entries", () => {
  let entries: StressEntry[] = capDisplayEntries(makeRestoredEntries(5000));
  // Warm the flatten cache the way the app does on restore.
  preRenderLines(entries, WIDTH);

  let streamText = "";
  for (let tick = 0; tick < 2000; tick++) {
    streamText += ` delta chunk ${tick} of streamed text with some length to it`;
    entries = capDisplayEntries(replaceOrAppendStreamEntry(entries, {
      speaker: "claude",
      text: streamText,
      streamId: "stress:stream",
    }));
    // The app re-flattens after every coalesced flush; the per-entry cache
    // must keep this incremental (only the streaming entry changed).
    if (tick % 50 === 0) {
      preRenderLines(entries, WIDTH);
    }
  }
  const lines = preRenderLines(entries, WIDTH);

  assert.ok(entries.length <= MAX_DISPLAY_ENTRIES);
  const last = entries[entries.length - 1]!;
  assert.equal(last.streamId, "stress:stream");
  assert.ok(lines.length > 0);
});

test("highlight cache stays bounded while streaming code", () => {
  // A streaming code block re-highlights its growing last line on every
  // flush; each partial line is a distinct cache key. Feed it more distinct
  // lines than the cap and assert the cache never exceeds the cap.
  const lines: string[] = [];
  for (let i = 0; i < 11000; i++) {
    lines.push(`value_${i} = compute_${i}(x) + ${i}`);
  }
  const entry: StressEntry = {
    speaker: "claude",
    text: "```python\n" + lines.join("\n") + "\n```",
  };
  preRenderLines([entry], WIDTH);
  assert.ok(
    highlightCacheSize() <= 10_000,
    `highlight cache exceeded cap: ${highlightCacheSize()}`,
  );
});
