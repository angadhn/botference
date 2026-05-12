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

export function toolPreviewLine(msg: Record<string, unknown>): string {
  const name = String(msg.name ?? "tool");
  const preview = String(
    msg.output_preview
    ?? msg.input_preview
    ?? "",
  ).replace(/\s+/g, " ").trim();
  if (!preview) return name;
  return `${name} - ${preview}`;
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

