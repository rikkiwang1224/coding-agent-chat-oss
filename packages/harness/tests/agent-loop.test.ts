import { describe, it, expect, vi } from "vitest";
import { AgentLoop, type AgentLoopCallbacks } from "../src/agent-loop.js";
import type { LlmConfig, ChatCompletionChunk } from "../src/types.js";

/**
 * Mock LlmClient by intercepting the module. We replace the real HTTP client
 * with a factory that returns pre-scripted streaming responses.
 */

// Pre-scripted responses for different test scenarios
type MockTurn = {
  content?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
};

let mockTurnQueue: MockTurn[] = [];

vi.mock("../src/api-client.js", () => {
  return {
    LlmClient: class MockLlmClient {
      constructor(_config: LlmConfig) {}

      async *stream(): AsyncGenerator<ChatCompletionChunk> {
        const turn = mockTurnQueue.shift();
        if (!turn) {
          throw new Error("MockLlmClient: no more scripted turns");
        }

        // Emit content deltas
        if (turn.content) {
          yield makeChunk({ content: turn.content });
        }

        // Emit tool call deltas
        if (turn.toolCalls) {
          for (let i = 0; i < turn.toolCalls.length; i++) {
            const tc = turn.toolCalls[i];
            yield makeChunk({
              tool_calls: [
                {
                  index: i,
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.arguments },
                },
              ],
            });
          }
        }
      }
    },
    LlmApiError: class LlmApiError extends Error {
      constructor(msg: string, public statusCode: number, public responseBody: string) {
        super(msg);
      }
    },
  };
});

function makeChunk(delta: Record<string, unknown>): ChatCompletionChunk {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "mock-model",
    choices: [{ index: 0, delta: delta as any, finish_reason: null }],
  };
}

function makeConfig(): LlmConfig {
  return { apiKey: "test-key", model: "mock-model" };
}

function collectCallbacks() {
  const deltas: string[] = [];
  const toolCalls: { name: string; args: Record<string, unknown>; id: string }[] = [];
  const toolResults: { name: string; output: string; ok: boolean }[] = [];
  const turns: number[] = [];
  let completed = "";

  const callbacks: AgentLoopCallbacks = {
    onTextDelta: (d) => deltas.push(d),
    onToolCall: (name, args, id) => toolCalls.push({ name, args, id }),
    onToolResult: (name, output, ok) => toolResults.push({ name, output, ok }),
    onTurnStart: (n) => turns.push(n),
    onComplete: (s) => { completed = s; },
  };

  return { deltas, toolCalls, toolResults, turns, getCompleted: () => completed, callbacks };
}

describe("AgentLoop - single turn (no tools)", () => {
  it("returns model response directly when no tool calls", async () => {
    mockTurnQueue = [{ content: "Hello! I can help you with that." }];
    const { deltas, callbacks, getCompleted } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp/test-workspace",
      callbacks,
    });

    const result = await loop.run("Hi there");
    expect(result.turnCount).toBe(1);
    expect(deltas.join("")).toBe("Hello! I can help you with that.");
    expect(getCompleted()).toBe("Hello! I can help you with that.");
  });
});

describe("AgentLoop - tool calling cycle", () => {
  it("executes tool and feeds result back", async () => {
    mockTurnQueue = [
      // Turn 1: model calls read_file
      {
        toolCalls: [
          { id: "call_1", name: "read_file", arguments: '{"path":"/tmp/test-workspace"}' },
        ],
      },
      // Turn 2: model responds with final answer
      { content: "I read the file successfully." },
    ];

    const { toolCalls, toolResults, callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp/test-workspace",
      callbacks,
    });

    const result = await loop.run("Read a file for me");
    expect(result.turnCount).toBe(2);
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe("read_file");
    expect(toolResults.length).toBe(1);
  });
});

describe("AgentLoop - multiple tool calls in one turn", () => {
  it("executes all tool calls from a single assistant message", async () => {
    mockTurnQueue = [
      // Turn 1: model calls 3 tools at once
      {
        toolCalls: [
          { id: "call_a", name: "list_directory", arguments: "{}" },
          { id: "call_b", name: "list_directory", arguments: '{"path":"src"}' },
          { id: "call_c", name: "list_directory", arguments: '{"path":"tests"}' },
        ],
      },
      // Turn 2: final answer
      { content: "Done exploring." },
    ];

    const { toolCalls, toolResults, callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
    });

    const result = await loop.run("Explore the project");
    expect(result.turnCount).toBe(2);
    expect(toolCalls.length).toBe(3);
    expect(toolResults.length).toBe(3);
  });
});

describe("AgentLoop - max turns exceeded", () => {
  it("throws when exceeding max turns", async () => {
    // Always return a tool call so the loop never terminates
    mockTurnQueue = Array.from({ length: 5 }, () => ({
      toolCalls: [{ id: "call_x", name: "list_directory", arguments: "{}" }],
    }));

    const { callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      maxTurns: 3,
      callbacks,
    });

    await expect(loop.run("infinite loop")).rejects.toThrow("max turns");
  });
});

describe("AgentLoop - cancellation", () => {
  it("throws on abort signal", async () => {
    const controller = new AbortController();
    // Abort immediately
    controller.abort("cancelled");

    mockTurnQueue = [{ content: "should not see this" }];
    const { callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      signal: controller.signal,
      callbacks,
    });

    await expect(loop.run("do something")).rejects.toThrow("cancelled");
  });
});

describe("AgentLoop - tool call with malformed JSON args", () => {
  it("handles invalid JSON in tool arguments gracefully", async () => {
    mockTurnQueue = [
      {
        toolCalls: [
          { id: "call_bad", name: "read_file", arguments: "not valid json{{{" },
        ],
      },
      { content: "I see there was an error." },
    ];

    const { toolResults, callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
    });

    const result = await loop.run("try something");
    expect(result.turnCount).toBe(2);
    expect(toolResults.length).toBe(1);
    expect(toolResults[0].ok).toBe(false);
    expect(toolResults[0].output).toContain("Failed to parse");
  });
});
