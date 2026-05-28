/**
 * Activity digest — compress agent turn history into a compact, factual
 * audit trail for use as input to an independent Sensor (e.g. Reason).
 *
 * Why not just pass `messages` to the Sensor:
 *   - the agent's reasoning_content / long assistant prose biases the Sensor
 *     (it gets "sold" on the agent's narrative)
 *   - full message history is expensive (10-100k input tokens)
 *
 * What we keep:
 *   - tool calls: name + key args (truncated) + output preview
 *   - assistant text content (the "● ..." bullets that summarize decisions)
 *
 * What we drop:
 *   - reasoning_content (internal LLM thinking — biased + verbose)
 *   - system / user prompts (those are the same input the Sensor sees fresh)
 *   - long tool outputs (truncated to ~200 chars)
 */
import type { ChatMessage, ToolCallMessage } from "./types.js";

export interface DigestOptions {
  /** Max events (tool calls + assistant bullets) to include. Newest wins. */
  maxEvents?: number;
  /** Max chars to keep per tool output (and per assistant bullet). */
  maxChars?: number;
}

export interface DigestEvent {
  turn: number;
  kind: "tool" | "bullet";
  /** Tool name (when kind=tool) or empty (when kind=bullet). */
  tool?: string;
  /** Compact one-line representation: `read_file: {path: "x"}` or the bullet text. */
  summary: string;
  /** Truncated tool output preview (when kind=tool). */
  output?: string;
}

export interface ActivityDigest {
  /** Number of assistant turns observed. */
  totalTurns: number;
  /** Number of tool calls observed (sum across turns). */
  totalToolCalls: number;
  /** Most recent events (chronological). */
  events: DigestEvent[];
  /** The last assistant text bullet (commonly the agent's "I'm done" claim). */
  lastClaim?: string;
}

const DEFAULT_MAX_EVENTS = 18;
const DEFAULT_MAX_CHARS = 220;

export function buildActivityDigest(
  messages: readonly ChatMessage[],
  options: DigestOptions = {},
): ActivityDigest {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  // Map tool_call_id → output preview for fast lookup.
  const toolOutputs = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      const text = typeof m.content === "string" ? m.content : "";
      toolOutputs.set(m.tool_call_id, truncate(text, maxChars));
    }
  }

  const events: DigestEvent[] = [];
  let turn = 0;
  let totalToolCalls = 0;
  let lastBullet: string | undefined;

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    turn++;

    // Assistant text (the "●" bullet equivalent) — only include if non-trivial.
    const text = extractAssistantText(m);
    if (text) {
      const compact = truncate(text, maxChars);
      events.push({ turn, kind: "bullet", summary: compact });
      lastBullet = compact;
    }

    // Tool calls — emit one event per call with output preview if available.
    if (m.tool_calls && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls as ToolCallMessage[]) {
        totalToolCalls++;
        const args = compactArgs(tc.function.arguments, maxChars);
        const output = toolOutputs.get(tc.id);
        events.push({
          turn,
          kind: "tool",
          tool: tc.function.name,
          summary: `${tc.function.name}(${args})`,
          output,
        });
      }
    }
  }

  // Keep only the newest N events. We sample tail-heavy because:
  //  (a) recent activity matters more for "did the agent reach a good state?"
  //  (b) earliest turns are usually exploratory and less informative
  const trimmed = events.slice(-maxEvents);

  return {
    totalTurns: turn,
    totalToolCalls,
    events: trimmed,
    lastClaim: lastBullet,
  };
}

/** Render the digest as a compact markdown block for prompt injection. */
export function renderActivityDigest(d: ActivityDigest): string {
  const lines: string[] = [];
  lines.push(
    `## Agent activity summary (showing last ${d.events.length} of ${d.totalToolCalls} tool calls across ${d.totalTurns} turns)`,
  );
  for (const ev of d.events) {
    if (ev.kind === "bullet") {
      lines.push(`- T${ev.turn} say: ${ev.summary}`);
    } else {
      const out = ev.output ? ` → ${ev.output}` : "";
      lines.push(`- T${ev.turn} ${ev.summary}${out}`);
    }
  }
  return lines.join("\n");
}

function extractAssistantText(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content.trim();
  return "";
}

function truncate(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

/** Compact a JSON-stringified args blob into a one-line preview. */
function compactArgs(argsJson: string, maxChars: number): string {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    // Show only top-level keys with short string values; collapse the rest.
    const pairs: string[] = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") {
        pairs.push(`${k}=${JSON.stringify(truncate(v, 60))}`);
      } else if (typeof v === "number" || typeof v === "boolean") {
        pairs.push(`${k}=${v}`);
      } else {
        pairs.push(`${k}=<...>`);
      }
    }
    return truncate(pairs.join(", "), maxChars);
  } catch {
    return truncate(argsJson, maxChars);
  }
}
