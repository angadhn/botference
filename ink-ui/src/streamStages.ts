// "How far along is each streamed reply?" — one named stage per stream id.
// Same pattern as questions.ts.
//
// The stages, in one list. All of them live in one map (stream id -> stage)
// in App.tsx, changed only through moveStreamStages(), which refuses an
// illegal move. A stream id not in the map has not started.
//
//   started      the engine opened the stream; nothing of it is on screen yet
//   streaming    text or tool lines of it are on screen, in segments
//   done_unshown the stream ended without showing anything; the controller's
//                final entry for it is shown as usual
//   done_shown   the stream ended after showing its segments; they stay on
//                screen and the controller's final entry for it is dropped
//                (it would repeat what is already there)
//
// "start" on a stream id already in the map begins it again from "started"
// (the engine may reuse an id). A segment arriving after "done_unshown" means
// something is on screen after all, so the final entry is dropped too.

import { isFinalEntryForSegmentedStream } from "./v2/messages.js";

export const STREAM_STAGES = ["started", "streaming", "done_unshown", "done_shown"] as const;
export type StreamStage = (typeof STREAM_STAGES)[number];

export type StreamStages = ReadonlyMap<string, StreamStage>;

export const NO_STREAMS: StreamStages = new Map();

export type StreamStageEvent =
  /** The engine opened a stream. */
  | { type: "start"; streamId: string }
  /** A text or tool segment of the stream went on screen. */
  | { type: "segment"; streamId: string }
  /** The engine closed the stream. */
  | { type: "done"; streamId: string }
  /** The room was cleared: every stream is forgotten. */
  | { type: "clear_all" };

type Stage = StreamStage | "not_started";

/** Where each event takes a stream from each stage; absent = refused. */
const MOVES: Record<"start" | "segment" | "done", Partial<Record<Stage, StreamStage>>> = {
  start: {
    not_started: "started",
    started: "started",
    streaming: "started",
    done_unshown: "started",
    done_shown: "started",
  },
  segment: {
    not_started: "streaming",
    started: "streaming",
    streaming: "streaming",
    done_unshown: "done_shown",
    done_shown: "done_shown",
  },
  done: {
    not_started: "done_unshown",
    started: "done_unshown",
    streaming: "done_shown",
  },
};

export type StreamStageMove =
  | { ok: true; stages: StreamStages; changed: boolean }
  | { ok: false; stages: StreamStages; reason: string };

/** The one setter's rule: the new map, or a refusal that keeps `from`. */
export function moveStreamStages(from: StreamStages, event: StreamStageEvent): StreamStageMove {
  if (event.type === "clear_all") {
    return from.size === 0
      ? { ok: true, stages: from, changed: false }
      : { ok: true, stages: NO_STREAMS, changed: true };
  }
  const current: Stage = from.get(event.streamId) ?? "not_started";
  const next = MOVES[event.type][current];
  if (!next) return { ok: false, stages: from, reason: `no ${event.type} from ${current}` };
  if (next === current) return { ok: true, stages: from, changed: false };
  const stages = new Map(from);
  stages.set(event.streamId, next);
  return { ok: true, stages, changed: true };
}

/** Is this controller entry the final copy of a stream whose segments are
 *  already on screen? Then it is dropped. */
export function dropsFinalEntry(stages: StreamStages, entryStreamId: string): boolean {
  for (const [baseStreamId, stage] of stages) {
    if (stage === "done_shown" && isFinalEntryForSegmentedStream(entryStreamId, baseStreamId)) {
      return true;
    }
  }
  return false;
}
