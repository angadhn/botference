import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import v8 from "node:v8";

/** In-flight breadcrumbs for post-mortem crash analysis.

    A heartbeat line every interval records memory pressure and the most
    recent activity; significant events flush immediately. When a run dies
    without any exception (hard kill, OOM before the fatal report, terminal
    close), the tail of flight.jsonl says what the app was doing and how
    close to the heap ceiling it was — the "little tracker".
*/

export interface FlightRecorderOptions {
  filePath: string;
  intervalMs?: number;
  maxBytes?: number;
  appendLine?: (filePath: string, line: string) => void;
  now?: () => number;
  memory?: () => { rss: number; heapUsed: number; heapLimit: number };
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function defaultAppendLine(filePath: string, line: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    if (statSync(filePath).size >= DEFAULT_MAX_BYTES) {
      renameSync(filePath, `${filePath}.1`);
    }
  } catch {
    // no file yet
  }
  appendFileSync(filePath, line);
}

function defaultMemory(): { rss: number; heapUsed: number; heapLimit: number } {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapLimit: v8.getHeapStatistics().heap_size_limit,
  };
}

export interface FlightRecorder {
  start(): void;
  stop(): void;
  /** Record activity. Cheap by default (folded into the next heartbeat);
      pass flush for events that must survive an immediate death. */
  note(activity: string, options?: { flush?: boolean }): void;
}

export function createFlightRecorder(
  options: FlightRecorderOptions,
): FlightRecorder {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const appendLine = options.appendLine ?? defaultAppendLine;
  const now = options.now ?? Date.now;
  const memory = options.memory ?? defaultMemory;
  const startedAt = now();

  let timer: NodeJS.Timeout | null = null;
  let lastActivity = "startup";
  let eventsSinceBeat = 0;

  const write = (kind: string) => {
    try {
      const mem = memory();
      const record: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        kind,
        up_s: Math.round((now() - startedAt) / 1000),
        rss_mb: Math.round(mem.rss / 1048576),
        heap_mb: Math.round(mem.heapUsed / 1048576),
        heap_limit_mb: Math.round(mem.heapLimit / 1048576),
        last: lastActivity,
        events: eventsSinceBeat,
      };
      if (mem.heapLimit > 0 && mem.heapUsed / mem.heapLimit > 0.85) {
        record["memory_pressure"] = true;
      }
      appendLine(options.filePath, JSON.stringify(record) + "\n");
      eventsSinceBeat = 0;
    } catch {
      // diagnostics must never take the app down
    }
  };

  return {
    start() {
      if (timer) return;
      write("start");
      timer = setInterval(() => write("heartbeat"), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      write("stop");
    },
    note(activity, noteOptions) {
      lastActivity = activity;
      eventsSinceBeat += 1;
      if (noteOptions?.flush) write("event");
    },
  };
}
