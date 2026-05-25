import { serializeTurnCost } from "@/lib/run-cost";
import type { LocalThread, Message } from "@/types";

export function deriveThreadTitle(firstUserBody: string): string {
  const trimmed = firstUserBody.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 60) return trimmed || "Untitled chat";
  return `${trimmed.slice(0, 57).trimEnd()}...`;
}

export function deriveThreadSummary(lastAssistantBody: string): string {
  const trimmed = lastAssistantBody.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 197).trimEnd()}...`;
}

export function buildLocalThreadFromMessages(
  id: string,
  messages: Message[],
  options?: { summary?: string; sessionState?: string },
): LocalThread {
  const firstUser = messages.find((m) => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const fallbackSummary = deriveThreadSummary(lastAssistant?.body ?? "");
  return {
    id,
    title: deriveThreadTitle(firstUser?.body ?? ""),
    summary: (options?.summary ?? fallbackSummary) || "New chat",
    updatedAt: new Date().toISOString(),
    sessionState: options?.sessionState,
    messages: messages.map((m) => ({
      role: m.role,
      body: m.body,
      attachments: m.attachments.length > 0 ? m.attachments : undefined,
      toolCalls: m.toolCalls && m.toolCalls.length > 0 ? m.toolCalls : undefined,
      turnCost: serializeTurnCost(m.turnCost),
    })),
  };
}
