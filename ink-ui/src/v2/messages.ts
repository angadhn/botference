export interface V2Entry {
  speaker: string;
  text: string;
  streamId?: string;
  restored?: boolean;
}

export const PACED_MESSAGE_MIN_CHARS = 240;
export const PACED_MESSAGE_INTERVAL_MS = 35;
export const PACED_MESSAGE_CHUNK_CHARS = 48;
// Above this size the paced reveal stops being an effect and becomes a hang:
// the reveal re-parses the growing prefix every tick (O(n²/chunk) total) and
// a 1MB message would "type" for over ten minutes. Huge messages land whole.
export const PACED_MESSAGE_MAX_CHARS = 6000;

export function shouldPaceEntry(speaker: string, text: string): boolean {
  const normalizedSpeaker = speaker.toLowerCase();
  return (
    (normalizedSpeaker === "claude" || normalizedSpeaker === "codex")
    && text.length >= PACED_MESSAGE_MIN_CHARS
    && text.length <= PACED_MESSAGE_MAX_CHARS
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

// The in-memory display log is a scrollback window, not the durable record
// (that's the session file). Without a cap, roomEntries — and every cached
// flat line derived from it — grows for the life of the chat, degrading each
// full reflow (terminal resize) and memory use. Trimming in chunks keeps the
// array identity stable between trims so per-entry render caches stay hot.
export const MAX_DISPLAY_ENTRIES = 2400;
export const DISPLAY_TRIM_KEEP = 2000;

export function capDisplayEntries<T>(
  entries: T[],
  max: number = MAX_DISPLAY_ENTRIES,
  keep: number = DISPLAY_TRIM_KEEP,
): T[] {
  if (entries.length <= max) return entries;
  return entries.slice(entries.length - keep);
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

// Trailing JSON footers ({"status": ..., ...}) drive free-form routing
// on the controller side. The controller strips them from its final entry,
// but segmented streams keep the raw streamed text in the pane (the final
// entry is dropped to avoid a reflow), so the footer must also be stripped
// here when the stream completes.
const TRAILING_JSON_FOOTER_RE = /\{[^{]*"status"[^}]*\}\s*$/;

export function stripTrailingJsonFooter(text: string): string {
  return text.replace(TRAILING_JSON_FOOTER_RE, "").trimEnd();
}

/**
 * On stream completion, strip a trailing JSON footer from the stream's last
 * text segment. Returns the same array when nothing changed.
 */
export function stripFooterFromStreamEntries<
  T extends { streamId?: string; text: string },
>(entries: T[], baseStreamId: string): T[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const sid = entry.streamId ?? "";
    if (sid === baseStreamId || sid.startsWith(`${baseStreamId}:text:`)) {
      const stripped = stripTrailingJsonFooter(entry.text);
      if (stripped === entry.text) return entries;
      const next = entries.slice();
      next[i] = { ...entry, text: stripped };
      return next;
    }
  }
  return entries;
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

// ── Summoned build agents ──────────────────────────────────
//
// A bot may summon a build agent. The controller emits room entries with
// speaker "agent" and an `agent` metadata object; the card nests under the
// summoning bot's message (parent_stream_id) and a later report card with
// the same stream id (`<id>:card`) replaces the working card in place.

export interface AgentMeta {
  id: string;
  card?: string; // "report" | "tools"
  parent_stream_id?: string;
  summoned_by?: string;
  cli?: string;
  model?: string;
  effort?: string;
  label?: string;
  brief?: string;
  status?: string; // "working" | "done" | "failed" | "timeout"
  elapsed_s?: number;
}

export function parseAgentMeta(raw: unknown): AgentMeta | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const meta = raw as Record<string, unknown>;
  const id = typeof meta.id === "string" ? meta.id : "";
  if (!id) return undefined;
  const str = (key: string): string | undefined => (
    typeof meta[key] === "string" ? (meta[key] as string) : undefined
  );
  const elapsed = typeof meta.elapsed_s === "number" ? meta.elapsed_s : Number(meta.elapsed_s);
  return {
    id,
    card: str("card"),
    parent_stream_id: str("parent_stream_id"),
    summoned_by: str("summoned_by"),
    cli: str("cli"),
    model: str("model"),
    effort: str("effort"),
    label: str("label"),
    brief: str("brief"),
    status: str("status"),
    elapsed_s: Number.isFinite(elapsed) ? elapsed : undefined,
  };
}

export function agentCardStreamId(agentId: string): string {
  return `${agentId}:card`;
}

export function agentToolsStreamId(agentId: string): string {
  return `${agentId}:tools`;
}

export function formatAgentElapsed(seconds: number | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatAgentStatus(status: string | undefined, elapsedS: number | undefined): string {
  const elapsed = formatAgentElapsed(elapsedS);
  switch ((status ?? "working").toLowerCase()) {
    case "done": return `done in ${elapsed}`;
    case "failed": return `failed after ${elapsed}`;
    case "timeout": return `timed out after ${elapsed}`;
    default: return "working…";
  }
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/** `↳ agent · Claude Opus 5.5 (high) · summoned by Claude · working…` */
export function agentHeaderLine(meta: AgentMeta): string {
  const parts = ["↳ agent"];
  const label = meta.label || meta.model;
  if (label) parts.push(label);
  if (meta.summoned_by) parts.push(`summoned by ${capitalize(meta.summoned_by)}`);
  parts.push(formatAgentStatus(meta.status, meta.elapsed_s));
  return parts.join(" · ");
}

/** Number of calls in an "Explored\n├ …\n└ …" tool stack. */
export function countToolStackCalls(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("├") || line.startsWith("└")) count += 1;
  }
  return count;
}

/** The folded tools card: `↳ tools: 3 calls`. */
export function agentToolsHeaderLine(text: string): string {
  const calls = countToolStackCalls(text);
  return `↳ tools: ${calls} ${calls === 1 ? "call" : "calls"}`;
}

/**
 * Where an agent card goes:
 *   1. an entry with the same stream id is replaced in place (report replaces
 *      the working card; the live tools stack becomes the final tools card);
 *   2. otherwise directly after the last entry belonging to its parent — the
 *      summoner's message (stream id equal to, or a segment of,
 *      `parent_stream_id`) or an earlier card of the same agent / same parent;
 *   3. failing that, after the most recent message from `summoned_by` (and
 *      any agent cards already hanging under it);
 *   4. failing that, appended.
 * Later messages append after, so the card stays put once placed.
 */
export function placeAgentEntry<
  T extends { speaker: string; streamId?: string; agent?: AgentMeta },
>(entries: T[], entry: T): T[] {
  const meta = entry.agent;
  if (!meta) return replaceOrAppendStreamEntry(entries, entry);

  if (entry.streamId) {
    const existing = entries.findIndex((candidate) => candidate.streamId === entry.streamId);
    if (existing !== -1) {
      const next = [...entries];
      next[existing] = entry;
      return next;
    }
  }

  const parent = meta.parent_stream_id ?? "";
  let anchor = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i]!;
    const sid = candidate.streamId ?? "";
    if (candidate.agent && candidate.agent.id === meta.id) { anchor = i; break; }
    if (parent && candidate.agent && candidate.agent.parent_stream_id === parent) { anchor = i; break; }
    if (parent && (sid === parent || sid.startsWith(`${parent}:`))) { anchor = i; break; }
  }

  if (anchor === -1 && meta.summoned_by) {
    const summoner = meta.summoned_by.toLowerCase();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.speaker.toLowerCase() === summoner) { anchor = i; break; }
    }
    // keep sibling cards already hanging under that message in order
    while (anchor !== -1 && anchor + 1 < entries.length && entries[anchor + 1]!.agent) anchor += 1;
  }

  if (anchor === -1) return [...entries, entry];
  const next = [...entries];
  next.splice(anchor + 1, 0, entry);
  return next;
}
