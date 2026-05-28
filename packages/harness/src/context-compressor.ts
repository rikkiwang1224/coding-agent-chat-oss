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

/** Magic prefix used to detect (and extend) a prior summary message. */
const SUMMARY_PREFIX = "[Previous conversation summary]\n";
const SUMMARY_SUFFIX = "\n[End of summary — continue from here]";

/**
 * Compresses conversation history when it gets too long.
 * Strategy:
 * 1. Always keep the system message (index 0)
 * 2. Always keep the N most recent messages (expanded to a tool-call-safe
 *    boundary — see `findSafeCutIndex`)
 * 3. Summarize everything in between into a single "summary" user message,
 *    extending any prior summary we find at the head of the middle slice
 *    (incremental summarization — avoids re-summarizing the same tokens
 *    O(N²) times across repeated compressions).
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

  /**
   * Returns true when the conversation needs compression.
   *
   * @param messages   the current message array
   * @param actualInputTokens  optional override sourced from the most recent
   *   provider `prompt_tokens` (DeepSeek/OpenAI). When supplied, we trust the
   *   real tokenizer instead of the character-based heuristic — saves an
   *   unnecessary compression pass on prompts that LOOK long (lots of code
   *   chars) but tokenize short, and conversely triggers compression earlier
   *   for prompts that LOOK short but tokenize long.
   */
  shouldCompress(messages: ChatMessage[], actualInputTokens?: number): boolean {
    const tokens = actualInputTokens && actualInputTokens > 0
      ? actualInputTokens
      : estimateTokens(messages);
    return tokens > this.maxContextTokens;
  }

  /**
   * Compress messages if they exceed the token budget.
   * Returns a new array with compressed history or the original if no compression needed.
   *
   * @param actualInputTokens  optional override of the estimator — see
   *   `shouldCompress`. Used by `AgentLoop` to feed back the provider's real
   *   `prompt_tokens` count.
   */
  async compress(
    messages: ChatMessage[],
    signal?: AbortSignal,
    actualInputTokens?: number,
  ): Promise<ChatMessage[]> {
    if (!this.shouldCompress(messages, actualInputTokens)) {
      return messages;
    }

    const systemMessage = messages[0];
    const proposedCut = Math.max(1, messages.length - this.preserveRecentCount);
    const cutIdx = findSafeCutIndex(messages, proposedCut);

    const recentMessages = messages.slice(cutIdx);
    const middleMessages = messages.slice(1, cutIdx);

    if (middleMessages.length < 4) {
      // Not enough messages to compress meaningfully
      return messages;
    }

    // Incremental summarization: if the head of the middle slice is a prior
    // summary we produced, extract it and ask the summarizer to extend rather
    // than re-derive it from scratch. Saves both tokens and quality drift.
    const { previousSummary, newMessages } = splitPreviousSummary(middleMessages);

    const summary = await this.summarizeMessages(newMessages, previousSummary, signal);

    const summaryMessage: ChatMessage = {
      role: "user",
      content: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`,
    };

    return [systemMessage, summaryMessage, ...recentMessages];
  }

  private async summarizeMessages(
    messages: ChatMessage[],
    previousSummary: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
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

    const systemPrompt = previousSummary
      ? "You are extending a running summary of a coding agent conversation. " +
        "Produce a single concise summary (max 500 words) that incorporates BOTH the prior " +
        "summary and the new activity since then. Preserve all still-relevant context " +
        "(open issue, files modified, decisions made) but drop redundant exploration. " +
        "Output the summary text only — no preamble."
      : "Summarize the following coding agent conversation into a concise summary (max 500 words). " +
        "Focus on: what the user asked, what files were read/modified, what tools were used, " +
        "what was accomplished, and any important context for continuing the work.";

    const userBody = previousSummary
      ? `# Prior summary\n${previousSummary}\n\n# New activity since the prior summary\n${conversationText}`
      : conversationText;

    const summaryPrompt: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userBody },
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

/**
 * Detect a previously-injected summary message at the head of the middle
 * slice. Returns its extracted content and the remaining messages to be
 * summarized; if no prior summary is found, returns the input untouched.
 */
function splitPreviousSummary(middle: ChatMessage[]): {
  previousSummary?: string;
  newMessages: ChatMessage[];
} {
  const head = middle[0];
  if (!head || head.role !== "user" || typeof head.content !== "string") {
    return { newMessages: middle };
  }
  if (!head.content.startsWith(SUMMARY_PREFIX)) {
    return { newMessages: middle };
  }
  let body = head.content.slice(SUMMARY_PREFIX.length);
  if (body.endsWith(SUMMARY_SUFFIX)) {
    body = body.slice(0, body.length - SUMMARY_SUFFIX.length);
  }
  return { previousSummary: body, newMessages: middle.slice(1) };
}

/**
 * Pick a cut index such that `messages.slice(cutIdx)` is a valid conversation suffix.
 *
 * The DeepSeek/OpenAI chat completions API requires every `role: "tool"` message
 * to be immediately preceded (within the request) by an `assistant` message whose
 * `tool_calls` array references the same `tool_call_id`. A naive
 * `slice(-preserveRecentCount)` will frequently start in the middle of an
 * `assistant(tool_calls) → tool → tool` block and produce a request that the API
 * rejects with HTTP 422.
 *
 * Strategy: walk backward from the proposed cut, expanding the recent window
 * until we land on a non-`tool` message. Because every `tool` message is
 * preceded (eventually) by its `assistant(tool_calls)`, walking back from a
 * `tool` will always land on either the matching `assistant` (good — keeps the
 * pair intact) or earlier — at worst we keep more than `preserveRecentCount`
 * messages, never fewer.
 *
 * Floor at index 1 to always preserve the system message at index 0.
 */
export function findSafeCutIndex(messages: ChatMessage[], proposedCut: number): number {
  let cut = Math.max(1, Math.min(proposedCut, messages.length));
  while (cut > 1 && messages[cut]?.role === "tool") {
    cut--;
  }
  return cut;
}
