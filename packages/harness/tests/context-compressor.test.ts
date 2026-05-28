import { describe, it, expect, vi } from "vitest";
import { findSafeCutIndex, ContextCompressor } from "../src/context-compressor.js";
import type { ChatMessage, LlmConfig, ChatCompletionChunk } from "../src/types.js";

/**
 * The compressor needs an LlmClient for the summarization call. Mock it so
 * the tests run hermetically and we can assert on the prompt structure.
 */
let mockSummaryResponse = "MOCK SUMMARY";
let lastSummaryPromptMessages: ChatMessage[] = [];

vi.mock("../src/api-client.js", () => {
  return {
    LlmClient: class MockLlmClient {
      constructor(_config: LlmConfig) {}
      async *stream(req: { messages: ChatMessage[] }): AsyncGenerator<ChatCompletionChunk> {
        lastSummaryPromptMessages = req.messages;
        yield {
          id: "x",
          object: "chat.completion.chunk",
          created: 0,
          model: "mock",
          choices: [{ index: 0, delta: { content: mockSummaryResponse }, finish_reason: null }],
        };
      }
    },
    LlmApiError: class extends Error {
      constructor(msg: string, public statusCode: number, public responseBody: string) {
        super(msg);
      }
    },
  };
});

/**
 * `findSafeCutIndex` is the contract that guarantees the compressed messages
 * array still forms a valid request for the DeepSeek/OpenAI chat completions
 * API. The invariant we enforce: `messages.slice(cutIdx)` must not start with
 * a `role: "tool"` message, otherwise the API rejects the request because the
 * `tool_call_id` references an `assistant.tool_calls` we no longer include.
 */
describe("findSafeCutIndex", () => {
  const sys = (): ChatMessage => ({ role: "system", content: "sys" });
  const user = (text = "u"): ChatMessage => ({ role: "user", content: text });
  const asstText = (text = "a"): ChatMessage => ({ role: "assistant", content: text });
  const asstTool = (callId: string, name = "read_file"): ChatMessage => ({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: callId, type: "function", function: { name, arguments: "{}" } },
    ],
  });
  const tool = (callId: string, output = "ok"): ChatMessage => ({
    role: "tool",
    content: output,
    tool_call_id: callId,
  });

  it("keeps cut as-is when the proposed message is not a tool message", () => {
    const messages = [sys(), user("u1"), asstText("a1"), user("u2"), asstText("a2")];
    // proposed cut at index 3 (user) — already safe
    expect(findSafeCutIndex(messages, 3)).toBe(3);
  });

  it("walks back from a tool message to the matching assistant(tool_calls)", () => {
    // [system, user, asst(tc1), tool(tc1), asst("done")]
    const messages = [
      sys(),
      user("u1"),
      asstTool("tc1"),
      tool("tc1", "result"),
      asstText("done"),
    ];
    // proposed cut at 3 (tool) — must walk back to 2 (asst(tc1)) to keep the pair
    const safe = findSafeCutIndex(messages, 3);
    expect(safe).toBe(2);
    expect(messages[safe].role).toBe("assistant");
    expect(messages[safe].tool_calls?.[0]?.id).toBe("tc1");
  });

  it("walks back across multiple tool responses to the assistant", () => {
    // assistant emitted two tool_calls, both responses follow.
    const messages = [
      sys(),
      user("u1"),
      asstTool("tc1"),
      tool("tc1"),
      tool("tc2"),
      asstText("done"),
    ];
    // proposed cut at 4 (second tool) — walk back: 3 tool → 2 asst
    expect(findSafeCutIndex(messages, 4)).toBe(2);
  });

  it("floors at index 1 so the system message is always preserved", () => {
    // pathological: every message after system is a tool message
    const messages = [sys(), tool("x"), tool("y"), tool("z")];
    // proposed cut at 3 (tool) — walk back through 2,1 stops at 1
    expect(findSafeCutIndex(messages, 3)).toBe(1);
  });

  it("clamps oversized proposed cut to messages.length", () => {
    const messages = [sys(), user(), asstText()];
    expect(findSafeCutIndex(messages, 999)).toBe(3);
  });

  it("clamps undersized proposed cut to 1", () => {
    const messages = [sys(), user(), asstText()];
    expect(findSafeCutIndex(messages, -5)).toBe(1);
  });

  it("makes the resulting slice a valid suffix (no leading tool message)", () => {
    // Realistic 20-message conversation with mixed tool blocks.
    const messages: ChatMessage[] = [sys(), user("u0")];
    for (let i = 1; i <= 6; i++) {
      messages.push(asstTool(`tc${i}`));
      messages.push(tool(`tc${i}`));
    }
    messages.push(asstText("final"));

    for (let proposed = 1; proposed <= messages.length; proposed++) {
      const cut = findSafeCutIndex(messages, proposed);
      const suffix = messages.slice(cut);
      if (suffix.length > 0) {
        expect(suffix[0].role, `cut=${cut}`).not.toBe("tool");
      }
    }
  });
});

describe("ContextCompressor.shouldCompress with actualInputTokens", () => {
  const compressor = new ContextCompressor({
    config: { apiKey: "x", model: "m" },
    maxContextTokens: 1000,
  });

  const longMessages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u" },
  ];

  it("trusts the provider's prompt_tokens over the character heuristic", () => {
    // Tiny messages, but provider says we're at 5000 tokens — should compress.
    expect(compressor.shouldCompress(longMessages, 5000)).toBe(true);
  });

  it("uses heuristic when actualInputTokens is omitted", () => {
    // Tiny char-count messages → heuristic returns small number → no compression.
    expect(compressor.shouldCompress(longMessages)).toBe(false);
  });

  it("ignores zero actualInputTokens (treats as 'no signal yet')", () => {
    expect(compressor.shouldCompress(longMessages, 0)).toBe(false);
  });
});

describe("ContextCompressor.compress incremental summarization", () => {
  it("extends a prior summary instead of re-deriving it from scratch", async () => {
    mockSummaryResponse = "EXTENDED SUMMARY";

    const compressor = new ContextCompressor({
      config: { apiKey: "x", model: "m" },
      maxContextTokens: 100, // force compression
      preserveRecentCount: 4,
    });

    // Conversation already includes a prior summary at the head of the middle.
    // Need >= 5 messages between system and the preserved tail so middle has 4+.
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content:
          "[Previous conversation summary]\nWe explored the repo and fixed bug A.\n[End of summary — continue from here]",
      },
      { role: "user", content: "now please fix bug B" },
      { role: "assistant", content: "looking into it" },
      { role: "user", content: "any progress?" },
      { role: "assistant", content: "yes — fixed the off-by-one" },
      { role: "user", content: "ok next" },
      { role: "assistant", content: "doing it" },
      { role: "user", content: "great, what's next?" },
      { role: "assistant", content: "ship it" },
    ];

    const result = await compressor.compress(messages, undefined, 999_999);

    // System + new summary + recent N (>= 4)
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[1].content).toContain("EXTENDED SUMMARY");

    // The summarizer was called with both the prior summary AND the new activity.
    const summarizerInput = lastSummaryPromptMessages[1].content as string;
    expect(summarizerInput).toContain("Prior summary");
    expect(summarizerInput).toContain("fixed bug A");
    expect(summarizerInput).toContain("New activity since the prior summary");
    expect(summarizerInput).toContain("off-by-one");

    // System prompt of the summarizer reflects "extension" mode.
    expect(lastSummaryPromptMessages[0].content).toContain("extending a running summary");
  });

  it("falls back to single-shot summary when there's no prior summary", async () => {
    mockSummaryResponse = "FRESH SUMMARY";

    const compressor = new ContextCompressor({
      config: { apiKey: "x", model: "m" },
      maxContextTokens: 100,
      preserveRecentCount: 4,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "initial ask" },
      { role: "assistant", content: "starting" },
      { role: "user", content: "step 1" },
      { role: "assistant", content: "done" },
      { role: "user", content: "step 2" },
      { role: "assistant", content: "done" },
      { role: "user", content: "step 3" },
      { role: "assistant", content: "done" },
      { role: "user", content: "step 4" },
    ];

    await compressor.compress(messages, undefined, 999_999);
    expect(lastSummaryPromptMessages[0].content).not.toContain("extending a running summary");
    expect(lastSummaryPromptMessages[1].content).not.toContain("Prior summary");
  });
});
