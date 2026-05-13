export type V2ActivityTarget = "claude" | "codex" | "all" | "system";
export type V2ActivityMode = "thinking" | "responding" | "tool" | "system";

export interface V2Activity {
  target: V2ActivityTarget;
  mode: V2ActivityMode;
  verb: string;
  activeTools: Record<string, string>;
  updatedAt: number;
}

export const V2_SPINNER_VERBS = [
  "Architecting",
  "Brewing",
  "Caucusing",
  "Cogitating",
  "Composing",
  "Conjuring",
  "Crystallizing",
  "Drafting",
  "Inspecting",
  "Mulling",
  "Orchestrating",
  "Percolating",
  "Pondering",
  "Prestidigitating",
  "Recombobulating",
  "Synthesizing",
  "Triangulating",
  "Wrangling",
];

const SPINNER_GLYPHS = process.platform === "darwin"
  ? ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]
  : ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"];

export function v2ActivityGlyph(frameIndex: number): string {
  return SPINNER_GLYPHS[Math.abs(frameIndex) % SPINNER_GLYPHS.length] ?? "*";
}

export function selectV2SpinnerVerb(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }
  return V2_SPINNER_VERBS[Math.abs(hash) % V2_SPINNER_VERBS.length] ?? "Working";
}

export function normalizeV2ActivityTarget(value: unknown): V2ActivityTarget {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("claude")) return "claude";
  if (text.includes("codex")) return "codex";
  if (text.includes("all")) return "all";
  return "system";
}

export function targetFromInput(input: string, currentRoute: string, mode: string): V2ActivityTarget {
  const trimmed = input.trim().toLowerCase();
  if (mode === "caucus") return "all";
  if (trimmed.startsWith("@claude")) return "claude";
  if (trimmed.startsWith("@codex")) return "codex";
  if (trimmed.startsWith("@all")) return "all";
  if (trimmed.startsWith("/")) return "system";
  return normalizeV2ActivityTarget(currentRoute || "@all");
}

export function createV2Activity(
  target: V2ActivityTarget,
  mode: string,
  seed: string,
  now = Date.now(),
): V2Activity {
  const verb = mode === "caucus"
    ? "Caucusing"
    : target === "system"
      ? "Working"
      : selectV2SpinnerVerb(seed);
  return {
    target,
    mode: target === "system" ? "system" : "thinking",
    verb,
    activeTools: {},
    updatedAt: now,
  };
}

export function startV2ActivityFromInput(
  input: string,
  currentRoute: string,
  mode: string,
  now = Date.now(),
): V2Activity {
  return createV2Activity(targetFromInput(input, currentRoute, mode), mode, input, now);
}

function lowerFirst(text: string): string {
  if (!text) return text;
  return text[0]!.toLowerCase() + text.slice(1);
}

function actorLabel(target: V2ActivityTarget): string {
  switch (target) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "all":
      return "Claude and Codex";
    case "system":
      return "Botference";
  }
}

export function formatV2ActivityText(activity: V2Activity): string {
  const verb = lowerFirst(activity.verb).replace(/\.+$/, "");
  const actor = actorLabel(activity.target);
  return `${actor} ${activity.target === "all" ? "are" : "is"} ${verb}...`;
}

function cleanPreview(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function describeV2ToolActivity(msg: Record<string, unknown>): string {
  const name = String(msg.name ?? "tool");
  const normalized = name.toLowerCase();
  const preview = cleanPreview(msg.input_preview ?? msg.output_preview);

  if (normalized.includes("read")) return preview ? `Reading ${preview}` : "Reading files";
  if (normalized.includes("grep") || normalized.includes("search") || normalized.includes("glob")) {
    return preview ? `Searching ${preview}` : "Searching";
  }
  if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("command")) {
    return preview ? `Running ${preview}` : "Running shell";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return preview ? `Editing ${preview}` : "Editing files";
  }
  if (normalized.includes("fetch") || normalized.includes("web")) {
    return preview ? `Fetching ${preview}` : "Fetching";
  }
  if (normalized.includes("image")) return "Working with images";
  if (normalized.includes("test")) return "Running tests";
  return preview ? `${name} - ${preview}` : `Using ${name}`;
}

export function v2ToolActivityId(msg: Record<string, unknown>): string {
  if (typeof msg.tool_id === "string" && msg.tool_id) return msg.tool_id;
  if (typeof msg.name === "string" && msg.name) return msg.name;
  return "unknown";
}

export function updateV2ActivityForStream(
  current: V2Activity | null,
  msg: Record<string, unknown>,
  now = Date.now(),
): V2Activity {
  const target = normalizeV2ActivityTarget(msg.model);
  const seed = String(msg.stream_id ?? msg.model ?? now);
  const base = current ?? createV2Activity(target, "", seed, now);
  const kind = String(msg.kind ?? "");

  if (kind === "tool_start") {
    const toolId = v2ToolActivityId(msg);
    const label = describeV2ToolActivity(msg);
    return {
      ...base,
      target,
      mode: "tool",
      verb: label,
      activeTools: { ...base.activeTools, [toolId]: label },
      updatedAt: now,
    };
  }

  if (kind === "tool_done") {
    const toolId = v2ToolActivityId(msg);
    const activeTools = { ...base.activeTools };
    delete activeTools[toolId];
    const nextTool = Object.values(activeTools).at(-1);
    return {
      ...base,
      target,
      mode: nextTool ? "tool" : "responding",
      verb: nextTool ?? "Responding",
      activeTools,
      updatedAt: now,
    };
  }

  if (kind === "text_delta") {
    if (base.mode === "tool" && Object.keys(base.activeTools).length > 0) {
      return { ...base, target, updatedAt: now };
    }
    return { ...base, target, mode: "responding", verb: "Responding", updatedAt: now };
  }

  if (kind === "start") {
    return { ...base, target, updatedAt: now };
  }

  return { ...base, target, updatedAt: now };
}
