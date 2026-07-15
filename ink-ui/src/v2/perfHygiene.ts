/** User-timing hygiene.

    Node retains every performance.mark()/performance.measure() entry in the
    global user-timing buffer for the life of the process — there is no cap.
    React's development reconciler (react-reconciler *.development.js) logs a
    measure per component render for the DevTools performance track, so any
    accidental dev-mode run of a long-lived TUI accumulates entries at
    ~100+/render until the heap ceiling (observed: 4GB OOM after ~1h busy).

    dist/bin.js pins NODE_ENV=production, which removes the emitter; this
    purge is the belt-and-braces layer so even a deliberate dev-mode run
    (npm run dev, tsx) stays bounded.
*/

export const USER_TIMING_PURGE_INTERVAL_MS = 5_000;

export interface UserTimingPerformance {
  clearMeasures(): void;
  clearMarks(): void;
}

export function purgeUserTimings(
  perf: UserTimingPerformance = globalThis.performance,
): void {
  try {
    perf.clearMeasures();
    perf.clearMarks();
  } catch {
    // Diagnostics hygiene must never take the app down.
  }
}

/** Purge on an interval. Returns a stop function. The timer is unref'd so it
    never keeps the process alive. */
export function startUserTimingPurge(
  perf: UserTimingPerformance = globalThis.performance,
  intervalMs: number = USER_TIMING_PURGE_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => purgeUserTimings(perf), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
