import type { ChatMessage, LlmConfig } from "./types.js";
import { LlmClient } from "./api-client.js";

/**
 * Estimates token count for a message array using character-based heuristic.
 * ~4 chars per token for English, ~2 chars per token for code-heavy content.
 * This is intentionally conservative (overestimates) to trigger compression early.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (msg.content) totalChars += msg.content.length;
    if (msg.reasoning_content) totalChars += msg.reasoning_content.length;
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        totalChars += tc.function.name.length + tc.function.arguments.length;
      }
    }
    totalChars += 10; // role + structural overhead
  }
  return Math.ceil(totalChars / 3);
}

export interface ContextCompressorOptions {
  config: LlmConfig;
  /** Max tokens before triggering compression (default: 80000) */
  maxContextTokens?: number;
  /** Number of recent messages to always preserve (default: 10) */
  preserveRecentCount?: number;
}

/**
 * Compresses conversation history when it gets too long.
 * Strategy:
 * 1. Always keep the system message (index 0)
 * 2. Always keep the N most recent messages
 * 3. Summarize everything in between into a single "summary" user message
 */
export class ContextCompressor {
  private readonly maxContextTokens: number;
  private readonly preserveRecentCount: number;
  private readonly client: LlmClient;

  constructor(options: ContextCompressorOptions) {
    this.maxContextTokens = options.maxContextTokens ?? 80_000;
    this.preserveRecentCount = options.preserveRecentCount ?? 10;
    this.client = new LlmClient(options.config);
  }

  shouldCompress(messages: ChatMessage[]): boolean {
    return estimateTokens(messages) > this.maxContextTokens;
  }

  /**
   * Compress messages if they exceed the token budget.
   * Returns a new array with compressed history or the original if no compression needed.
   */
  async compress(messages: ChatMessage[], signal?: AbortSignal): Promise<ChatMessage[]> {
    if (!this.shouldCompress(messages)) {
      return messages;
    }

    const systemMessage = messages[0];
    const recentMessages = messages.slice(-this.preserveRecentCount);
    const middleMessages = messages.slice(1, -this.preserveRecentCount);

    if (middleMessages.length < 4) {
      // Not enough messages to compress meaningfully
      return messages;
    }

    const summary = await this.summarizeMessages(middleMessages, signal);

    const summaryMessage: ChatMessage = {
      role: "user",
      content: `[Previous conversation summary]\n${summary}\n[End of summary — continue from here]`,
    };

    return [systemMessage, summaryMessage, ...recentMessages];
  }

  private async summarizeMessages(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const conversationText = messages
      .map((msg) => {
        if (msg.role === "tool") {
          return `[Tool result: ${msg.content?.slice(0, 200)}...]`;
        }
        if (msg.role === "assistant" && msg.tool_calls) {
          const calls = msg.tool_calls
            .map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 100)})`)
            .join(", ");
          return `Assistant called: ${calls}`;
        }
        if (msg.role === "assistant" && msg.content) {
          return `Assistant: ${msg.content.slice(0, 500)}`;
        }
        if (msg.role === "user") {
          return `User: ${msg.content?.slice(0, 300)}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");

    const summaryPrompt: ChatMessage[] = [
      {
        role: "system",
        content:
          "Summarize the following coding agent conversation into a concise summary (max 500 words). " +
          "Focus on: what the user asked, what files were read/modified, what tools were used, " +
          "what was accomplished, and any important context for continuing the work.",
      },
      { role: "user", content: conversationText },
    ];

    // Use a streaming call to get the summary
    let summary = "";
    const stream = this.client.stream({ messages: summaryPrompt, signal });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        summary += delta.content;
      }
    }

    return summary || "Previous conversation involved code exploration and modifications.";
  }
}
