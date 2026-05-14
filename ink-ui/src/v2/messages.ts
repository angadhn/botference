export interface V2Entry {
  speaker: string;
  text: string;
  streamId?: string;
  restored?: boolean;
}

export const PACED_MESSAGE_MIN_CHARS = 240;
export const PACED_MESSAGE_INTERVAL_MS = 35;
export const PACED_MESSAGE_CHUNK_CHARS = 48;

export function shouldPaceEntry(speaker: string, text: string): boolean {
  const normalizedSpeaker = speaker.toLowerCase();
  return (
    (normalizedSpeaker === "claude" || normalizedSpeaker === "codex")
    && text.length >= PACED_MESSAGE_MIN_CHARS
    && !text.startsWith("Explored\n")
  );
}

export function shouldAppendImmediately(entry: V2Entry): boolean {
  return entry.restored === true || !shouldPaceEntry(entry.speaker, entry.text);
}

export function nextPacedChunkEnd(text: string, start: number): number {
  const hardEnd = Math.min(text.length, start + PACED_MESSAGE_CHUNK_CHARS);
  if (hardEnd >= text.length) return text.length;

  const newline = text.indexOf("\n", start);
  if (newline !== -1 && newline < hardEnd) return newline + 1;

  for (let index = hardEnd; index > start + 12; index--) {
    if (/\s/.test(text[index - 1]!)) return index;
  }

  return hardEnd;
}

export function replaceOrAppendStreamEntry<T extends { streamId?: string }>(
  entries: T[],
  entry: T,
): T[] {
  if (!entry.streamId) return [...entries, entry];
  const index = entries.findIndex((candidate) => candidate.streamId === entry.streamId);
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

export function replaceOrInsertStreamEntryBefore<T extends { streamId?: string }>(
  entries: T[],
  entry: T,
  beforeStreamId: string,
): T[] {
  if (!entry.streamId) return [...entries, entry];

  const index = entries.findIndex((candidate) => candidate.streamId === entry.streamId);
  if (index !== -1) {
    const next = [...entries];
    next[index] = entry;
    return next;
  }

  const beforeIndex = entries.findIndex((candidate) => candidate.streamId === beforeStreamId);
  if (beforeIndex === -1) return [...entries, entry];

  const next = [...entries];
  next.splice(beforeIndex, 0, entry);
  return next;
}

export interface StreamSegmentState {
  nextTextIndex: number;
  nextToolIndex: number;
  currentTextStreamId?: string;
  currentToolStreamId?: string;
  toolStreamIds: Record<string, string>;
}

export function createStreamSegmentState(): StreamSegmentState {
  return {
    nextTextIndex: 0,
    nextToolIndex: 0,
    toolStreamIds: {},
  };
}

export function textSegmentStreamId(baseStreamId: string, state: StreamSegmentState): string {
  if (!state.currentTextStreamId) {
    state.currentTextStreamId = `${baseStreamId}:text:${state.nextTextIndex}`;
    state.nextTextIndex += 1;
  }
  state.currentToolStreamId = undefined;
  return state.currentTextStreamId;
}

export function toolSegmentStreamId(
  baseStreamId: string,
  state: StreamSegmentState,
  toolId: string,
  startsToolGroup: boolean,
): string {
  const existing = state.toolStreamIds[toolId];
  if (existing) return existing;

  if (startsToolGroup || !state.currentToolStreamId) {
    state.currentToolStreamId = `${baseStreamId}:tools:${state.nextToolIndex}`;
    state.nextToolIndex += 1;
  }
  state.currentTextStreamId = undefined;
  state.toolStreamIds[toolId] = state.currentToolStreamId;
  return state.currentToolStreamId;
}

export function isFinalEntryForSegmentedStream(
  entryStreamId: string,
  baseStreamId: string,
): boolean {
  return entryStreamId === baseStreamId || entryStreamId === `${baseStreamId}:tools`;
}

export function toolPreviewLine(msg: Record<string, unknown>): string {
  const name = String(msg.name ?? "tool");
  const preview = String(
    msg.output_preview
    ?? msg.input_preview
    ?? "",
  ).replace(/\s+/g, " ").trim();
  const line = preview ? `${name} - ${preview}` : name;
  return isVerificationToolLine(line) ? `[verify] ${line}` : line;
}

export function toolEventId(msg: Record<string, unknown>): string {
  if (typeof msg.tool_id === "string" && msg.tool_id) return msg.tool_id;
  if (typeof msg.name === "string" && msg.name) return msg.name;
  return "unknown";
}

export function buildToolStackText(lines: string[]): string {
  const textLines = ["Explored"];
  lines.forEach((line, index) => {
    const branch = index === lines.length - 1 ? "└" : "├";
    textLines.push(`${branch} ${line}`);
  });
  return textLines.join("\n");
}

export function isVerificationToolLine(line: string): boolean {
  const normalized = line.toLowerCase();
  return [
    "check_figure",
    "compile_latex",
    "latexmk",
    "page.screenshot",
    "pdflatex",
    "playwright",
    "puppeteer",
    "tectonic",
    "view_pdf_page",
    "visual_check_html",
  ].some((token) => normalized.includes(token));
}
