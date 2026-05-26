export interface MouseEventInfo {
  kind: "press" | "drag" | "release";
  x: number;
  y: number;
}

export interface TerminalInputFilterState {
  pending: string;
  pasteBuffer: string | null;
}

export interface TerminalInputEvents {
  text: string;
  wheelSteps: number;
  mouseEvents: MouseEventInfo[];
  shiftEnterCount: number;
  pastes: string[];
}

export const SHIFT_ENTER_SEQS = [
  "\x1b[27;2;13~",
  "\x1b[13;2u",
];
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

const MOUSE_SEQ_AT_START = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/;
const MOUSE_INCOMPLETE_AT_START = /^\x1b\[<(?:\d*(?:;\d*){0,2})?$/;

export function createTerminalInputFilterState(): TerminalInputFilterState {
  return { pending: "", pasteBuffer: null };
}

function tailIsSequencePrefix(tail: string): boolean {
  if (!tail) return false;
  if (tail.length > 1 && tail.length < PASTE_START.length && PASTE_START.startsWith(tail)) return true;
  if (tail.length > 1 && tail.length < PASTE_END.length && PASTE_END.startsWith(tail)) return true;
  if (SHIFT_ENTER_SEQS.some((seq) => tail.length > 1 && tail.length < seq.length && seq.startsWith(tail))) return true;
  return MOUSE_INCOMPLETE_AT_START.test(tail);
}

function suffixPrefixLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (marker.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

export function processTerminalInputChunk(
  state: TerminalInputFilterState,
  chunk: string,
): TerminalInputEvents {
  let text = state.pending + chunk;
  state.pending = "";
  let i = 0;
  let output = "";
  let wheelSteps = 0;
  const mouseEvents: MouseEventInfo[] = [];
  let shiftEnterCount = 0;
  const pastes: string[] = [];

  while (i < text.length) {
    if (state.pasteBuffer !== null) {
      const endIdx = text.indexOf(PASTE_END, i);
      if (endIdx >= 0) {
        state.pasteBuffer += text.slice(i, endIdx);
        pastes.push(state.pasteBuffer);
        state.pasteBuffer = null;
        i = endIdx + PASTE_END.length;
        continue;
      }

      const remainder = text.slice(i);
      const keep = suffixPrefixLength(remainder, PASTE_END);
      state.pasteBuffer += remainder.slice(0, remainder.length - keep);
      state.pending = remainder.slice(remainder.length - keep);
      break;
    }

    const tail = text.slice(i);

    if (tail.startsWith(PASTE_START)) {
      state.pasteBuffer = "";
      i += PASTE_START.length;
      continue;
    }

    const shiftSeq = SHIFT_ENTER_SEQS.find((seq) => tail.startsWith(seq));
    if (shiftSeq) {
      shiftEnterCount += 1;
      i += shiftSeq.length;
      continue;
    }

    if (tail.startsWith("\x1b[<")) {
      const match = MOUSE_SEQ_AT_START.exec(tail);
      if (match) {
        const btn = parseInt(match[1]!, 10);
        if (btn === 64) {
          wheelSteps += 1;
        } else if (btn === 65) {
          wheelSteps -= 1;
        } else {
          const x = Math.max(0, parseInt(match[2]!, 10) - 1);
          const y = Math.max(0, parseInt(match[3]!, 10) - 1);
          const suffix = match[4]!;
          mouseEvents.push({
            kind: suffix === "m" ? "release" : (btn & 32) === 32 ? "drag" : "press",
            x,
            y,
          });
        }
        i += match[0].length;
        continue;
      }

      if (tailIsSequencePrefix(tail)) {
        state.pending = tail;
        break;
      }
    }

    if (tailIsSequencePrefix(tail)) {
      state.pending = tail;
      break;
    }

    output += text[i];
    i += 1;
  }

  if (state.pending.length > 64) {
    state.pending = "";
  }

  return {
    text: output,
    wheelSteps,
    mouseEvents,
    shiftEnterCount,
    pastes,
  };
}
