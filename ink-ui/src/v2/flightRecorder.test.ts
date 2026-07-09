import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createFlightRecorder } from "./flightRecorder.js";

function harness(overrides: { heapUsed?: number; heapLimit?: number } = {}) {
  const lines: string[] = [];
  const recorder = createFlightRecorder({
    filePath: "/x/flight.jsonl",
    intervalMs: 999_999,
    appendLine: (_p, line) => lines.push(line),
    now: () => 1_000_000,
    memory: () => ({
      rss: 100 * 1048576,
      heapUsed: overrides.heapUsed ?? 50 * 1048576,
      heapLimit: overrides.heapLimit ?? 4096 * 1048576,
    }),
  });
  return { recorder, lines, parse: (i: number) => JSON.parse(lines[i]!) };
}

describe("flight recorder", () => {
  it("writes a start record with memory numbers", () => {
    const { recorder, lines, parse } = harness();
    recorder.start();
    assert.equal(lines.length, 1);
    const rec = parse(0);
    assert.equal(rec.kind, "start");
    assert.equal(rec.rss_mb, 100);
    assert.equal(rec.heap_limit_mb, 4096);
    assert.equal(rec.memory_pressure, undefined);
  });

  it("notes fold into breadcrumbs; flush writes immediately", () => {
    const { recorder, lines, parse } = harness();
    recorder.start();
    recorder.note("bridge:stream");
    recorder.note("bridge:status");
    assert.equal(lines.length, 1, "cheap notes must not write");
    recorder.note("bridge_exit:1", { flush: true });
    assert.equal(lines.length, 2);
    const rec = parse(1);
    assert.equal(rec.kind, "event");
    assert.equal(rec.last, "bridge_exit:1");
    assert.equal(rec.events, 3);
  });

  it("flags memory pressure above 85% of the heap limit", () => {
    const { recorder, parse } = harness({
      heapUsed: 3900 * 1048576,
      heapLimit: 4096 * 1048576,
    });
    recorder.start();
    assert.equal(parse(0).memory_pressure, true);
  });

  it("stop writes a final record and disarms the timer", () => {
    const { recorder, lines, parse } = harness();
    recorder.start();
    recorder.stop();
    assert.equal(lines.length, 2);
    assert.equal(parse(1).kind, "stop");
  });

  it("appendLine failures never propagate", () => {
    const recorder = createFlightRecorder({
      filePath: "/x/flight.jsonl",
      intervalMs: 999_999,
      appendLine: () => {
        throw new Error("disk full");
      },
      now: () => 0,
      memory: () => ({ rss: 0, heapUsed: 0, heapLimit: 0 }),
    });
    recorder.start();
    recorder.note("x", { flush: true });
    recorder.stop();
  });
});
