import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  purgeUserTimings,
  startUserTimingPurge,
} from "./perfHygiene.js";

test("purgeUserTimings clears measures and marks", () => {
  let measures = 0;
  let marks = 0;
  purgeUserTimings({
    clearMeasures: () => { measures += 1; },
    clearMarks: () => { marks += 1; },
  });
  assert.equal(measures, 1);
  assert.equal(marks, 1);
});

test("purgeUserTimings swallows errors from the performance API", () => {
  assert.doesNotThrow(() => {
    purgeUserTimings({
      clearMeasures: () => { throw new Error("boom"); },
      clearMarks: () => { throw new Error("boom"); },
    });
  });
});

test("purgeUserTimings drains the real user-timing buffer", () => {
  performance.mark("perf-hygiene-test-mark");
  performance.measure("perf-hygiene-test-measure", {
    start: 0,
    end: 1,
  });
  assert.ok(performance.getEntriesByType("measure").length > 0);
  purgeUserTimings();
  assert.equal(performance.getEntriesByType("measure").length, 0);
  assert.equal(performance.getEntriesByType("mark").length, 0);
});

test("startUserTimingPurge purges on an interval and stops cleanly", async () => {
  let calls = 0;
  const stop = startUserTimingPurge(
    {
      clearMeasures: () => { calls += 1; },
      clearMarks: () => {},
    },
    5,
  );
  await delay(40);
  stop();
  assert.ok(calls >= 2, `expected at least 2 purges, got ${calls}`);
  const after = calls;
  await delay(20);
  assert.equal(calls, after, "purge kept running after stop()");
});
