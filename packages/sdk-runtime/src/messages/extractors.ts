/**
 * SDK message content-block extractors.
 *
 * Pure parsers turning Anthropic-style assistant/user/tool messages into the
 * minimal shapes the runtime persists into snapshots.
 */
import type { SdkMessage } from "../types/sdk-messages.js";

const MAX_TOOL_ARG_STRING_LENGTH = 4_000;

export function extractToolCalls(
  message: SdkMessage,
): Array<{ toolUseId?: string; name: string; args: Record<string, unknown> }> {
  const content = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.message?.content)
      ? message.message!.content
      : [];

  if (!Array.isArray(content)) return [];

  return content
    .filter((block): block is Record<string, unknown> =>
      Boolean(block) && typeof block === "object" && !Array.isArray(block),
    )
    .filter((block) => block.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({
      toolUseId: typeof block.id === "string" ? block.id : undefined,
      name: String(block.name),
      args: summarizeArgs(block.input as Record<string, unknown> | undefined),
    }));
}

/** Keep args readable — only top-level scalar values and truncated strings */
function summarizeArgs(input?: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") {
      out[k] = v.length > MAX_TOOL_ARG_STRING_LENGTH
        ? v.slice(0, MAX_TOOL_ARG_STRING_LENGTH) + "\n...[truncated]"
        : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

export function extractToolResults(
  message: SdkMessage,
): Array<{ toolUseId: string; output: string }> {
  const content = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.message?.content)
      ? message.message!.content
      : [];

  if (!Array.isArray(content)) return [];

  return content
    .filter((block): block is Record<string, unknown> =>
      Boolean(block) && typeof block === "object" && !Array.isArray(block),
    )
    .filter((block) => block.type === "tool_result" && typeof block.tool_use_id === "string")
    .map((block) => ({
      toolUseId: String(block.tool_use_id),
      output: typeof block.content === "string"
        ? block.content.slice(0, MAX_TOOL_ARG_STRING_LENGTH)
        : JSON.stringify(block.content ?? "").slice(0, MAX_TOOL_ARG_STRING_LENGTH),
    }));
}

export function extractTextFromMessage(message: SdkMessage): string {
  const content = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.message?.content)
      ? message.message!.content
      : [];

  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is Record<string, unknown> =>
      Boolean(block) && typeof block === "object",
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
}
