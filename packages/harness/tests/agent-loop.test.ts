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
  it("returns stopReason=max_turns with partial messages instead of throwing", async () => {
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

    const result = await loop.run("infinite loop");
    expect(result.stopReason).toBe("max_turns");
    expect(result.turnCount).toBe(3);
    // System + user + 3x (assistant + tool) = 8
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
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

describe("AgentLoop - reason sensor hook", () => {
  it("ships on first Reason verdict and records the verdict", async () => {
    mockTurnQueue = [
      { content: "Done — fixed it." },
      // Reason sensor turn
      { content: JSON.stringify({ verdict: "ship", confidence: "high", rationale: "looks fine" }) },
    ];

    const { callbacks } = collectCallbacks();
    const reasonVerdicts: Array<{ round: number; verdict: string }> = [];

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks: {
        ...callbacks,
        onReasonVerdict: (round, r) => reasonVerdicts.push({ round, verdict: r.verdict }),
      },
      reason: {
        enabled: true,
        issueText: "fix the bug",
        getCurrentDiff: async () => "diff --git a b\n@@ -1 +1 @@\n-old\n+new\n",
        maxRounds: 2,
      },
    });

    const result = await loop.run("fix the bug");
    expect(result.stopReason).toBe("completed");
    expect(result.reasonRoundsUsed).toBe(1);
    expect(result.reasonVerdicts).toHaveLength(1);
    expect(result.reasonVerdicts?.[0].verdict).toBe("ship");
    expect(reasonVerdicts).toEqual([{ round: 1, verdict: "ship" }]);
  });

  it("re-loops on revise then ships, injecting feedback as user msg", async () => {
    mockTurnQueue = [
      // Turn 1: agent claims done
      { content: "All done!" },
      // Reason round 1: revise
      {
        content: JSON.stringify({
          verdict: "revise",
          rationale: "missed empty list",
          missed_cases: [{ what: "empty list", where: "utils.py" }],
        }),
      },
      // Turn 2: agent says done again (after seeing feedback as user message)
      { content: "OK fixed the empty list case." },
      // Reason round 2: ship
      { content: JSON.stringify({ verdict: "ship", rationale: "good now" }) },
    ];

    const { callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
      reason: {
        enabled: true,
        issueText: "fix the bug",
        getCurrentDiff: async () => "diff text",
        maxRounds: 2,
      },
    });

    const result = await loop.run("fix the bug");
    expect(result.stopReason).toBe("completed");
    expect(result.reasonRoundsUsed).toBe(2);
    expect(result.reasonVerdicts?.[0].verdict).toBe("revise");
    expect(result.reasonVerdicts?.[1].verdict).toBe("ship");
    // Reviewer feedback should have been pushed as a user message between the
    // two agent turns: system, user, asst("All done!"), user(feedback),
    // asst("OK fixed..."). Plus the reason call doesn't add to messages.
    const userMessages = result.messages.filter((m) => m.role === "user");
    expect(userMessages.length).toBe(2);
    expect(userMessages[1].content).toMatch(/Independent reviewer feedback/);
  });

  it("stops at maxRounds even if sensor keeps saying revise", async () => {
    mockTurnQueue = [
      { content: "done v1" },
      { content: JSON.stringify({ verdict: "revise", rationale: "no" }) },
      { content: "done v2" },
      { content: JSON.stringify({ verdict: "revise", rationale: "still no" }) },
      // No third agent turn — we hit maxRounds=2 and bail
    ];

    const { callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
      reason: {
        enabled: true,
        issueText: "fix",
        getCurrentDiff: async () => "",
        maxRounds: 2,
      },
    });

    const result = await loop.run("fix");
    expect(result.stopReason).toBe("completed");
    expect(result.reasonRoundsUsed).toBe(2);
    expect(result.reasonVerdicts).toHaveLength(2);
    expect(result.reasonVerdicts?.every((v) => v.verdict === "revise")).toBe(true);
  });

  it("does not invoke Reason when hook is undefined (legacy path)", async () => {
    mockTurnQueue = [{ content: "All done!" }];
    const { callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
    });

    const result = await loop.run("fix");
    expect(result.stopReason).toBe("completed");
    expect(result.reasonRoundsUsed).toBeUndefined();
    expect(result.reasonVerdicts).toBeUndefined();
  });

  it("does not invoke Reason when hook is enabled=false", async () => {
    mockTurnQueue = [{ content: "All done!" }];
    const { callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
      reason: {
        enabled: false,
        issueText: "fix",
        getCurrentDiff: async () => "",
      },
    });

    const result = await loop.run("fix");
    expect(result.reasonRoundsUsed).toBeUndefined();
  });

  it("supports a function-form issueText (resolved per round)", async () => {
    mockTurnQueue = [
      { content: "done" },
      { content: JSON.stringify({ verdict: "ship", rationale: "ok" }) },
    ];
    const { callbacks } = collectCallbacks();
    let issueCalls = 0;

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
      reason: {
        enabled: true,
        issueText: () => {
          issueCalls++;
          return "dynamic issue";
        },
        getCurrentDiff: async () => "",
      },
    });

    await loop.run("dynamic issue");
    expect(issueCalls).toBe(1);
  });
});

describe("AgentLoop - verify hook", () => {
  it("completes normally when verify passes on first round", async () => {
    mockTurnQueue = [{ content: "All done." }];
    const { callbacks } = collectCallbacks();
    let parseCalls = 0;

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
      verify: {
        enabled: true,
        buildCommand: async () => ({ argv: ["/bin/sh", "-c", "exit 0"], cwd: "/tmp" }),
        parseOutput: (r) => {
          parseCalls++;
          return {
            verdict: r.exitCode === 0 ? "pass" : "fail",
            feedback: r.exitCode === 0 ? "all green" : "exit nonzero",
          };
        },
      },
    });

    const result = await loop.run("do it");
    expect(result.stopReason).toBe("completed");
    expect(result.verifyRoundsUsed).toBe(1);
    expect(result.verifyVerdicts?.[0].verdict).toBe("pass");
    expect(parseCalls).toBe(1);
  });

  it("loops on verify fail, injects feedback, then passes on next round", async () => {
    mockTurnQueue = [
      { content: "first attempt" },
      { content: "fixed it" },
    ];
    const { callbacks } = collectCallbacks();
    const verifyVerdicts: Array<{ round: number; verdict: string }> = [];
    let round = 0;

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks: {
        ...callbacks,
        onVerifyVerdict: (r, v) => verifyVerdicts.push({ round: r, verdict: v.verdict }),
      },
      verify: {
        enabled: true,
        label: "tests",
        buildCommand: async () => {
          round++;
          return {
            argv: ["/bin/sh", "-c", round === 1 ? "exit 1" : "exit 0"],
            cwd: "/tmp",
          };
        },
        parseOutput: (r) => ({
          verdict: r.exitCode === 0 ? "pass" : "fail",
          feedback: r.exitCode === 0 ? "ok" : "test_thing FAILED on line 42",
        }),
      },
    });

    const result = await loop.run("ship feature X");
    expect(result.stopReason).toBe("completed");
    expect(result.verifyRoundsUsed).toBe(2);
    expect(verifyVerdicts).toEqual([
      { round: 1, verdict: "fail" },
      { round: 2, verdict: "pass" },
    ]);
    // Feedback from round 1 must appear as a user message between the two
    // agent turns. Order: system, user, asst("first attempt"), user(feedback),
    // asst("fixed it").
    const userMessages = result.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1].content).toMatch(/tests gate — round 1/);
    expect(userMessages[1].content).toMatch(/test_thing FAILED/);
  });

  it("stops at verifyMaxRounds even on persistent failure", async () => {
    mockTurnQueue = [
      { content: "v1" },
      { content: "v2" },
      // No third agent turn — at round 2 we hit maxRounds and ship anyway
    ];
    const { callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
      verify: {
        enabled: true,
        maxRounds: 2,
        buildCommand: async () => ({ argv: ["/bin/sh", "-c", "exit 1"], cwd: "/tmp" }),
        parseOutput: () => ({ verdict: "fail", feedback: "still broken" }),
      },
    });

    const result = await loop.run("fix");
    expect(result.stopReason).toBe("completed");
    expect(result.verifyRoundsUsed).toBe(2);
    expect(result.verifyVerdicts).toHaveLength(2);
    expect(result.verifyVerdicts?.every((v) => v.verdict === "fail")).toBe(true);
  });

  it("does not consume budget when buildCommand returns undefined (skipped)", async () => {
    mockTurnQueue = [{ content: "done" }];
    const { callbacks } = collectCallbacks();
    let buildCalls = 0;

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
      verify: {
        enabled: true,
        maxRounds: 3,
        buildCommand: async () => {
          buildCalls++;
          return undefined; // nothing to verify
        },
        parseOutput: () => ({ verdict: "pass", feedback: "" }),
      },
    });

    const result = await loop.run("noop work");
    expect(result.stopReason).toBe("completed");
    // We invoked buildCommand exactly once and shipped without recording a verdict.
    expect(buildCalls).toBe(1);
    expect(result.verifyRoundsUsed).toBe(0);
    expect(result.verifyVerdicts).toBeUndefined();
  });

  it("runs verify BEFORE reason; reason is skipped when verify fails", async () => {
    // Agent says done → verify fails → feedback injected → agent says done v2 →
    // verify passes → reason runs → ship.
    mockTurnQueue = [
      { content: "v1" },
      { content: "v2" },
      // Reason turn (only fires after verify passes on round 2)
      { content: JSON.stringify({ verdict: "ship", rationale: "tests green + looks fine" }) },
    ];
    const { callbacks } = collectCallbacks();
    const reasonRounds: number[] = [];
    const verifyRounds: number[] = [];
    let verifyRound = 0;

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks: {
        ...callbacks,
        onReasonVerdict: (r) => reasonRounds.push(r),
        onVerifyVerdict: (r) => verifyRounds.push(r),
      },
      verify: {
        enabled: true,
        buildCommand: async () => {
          verifyRound++;
          return {
            argv: ["/bin/sh", "-c", verifyRound === 1 ? "exit 1" : "exit 0"],
            cwd: "/tmp",
          };
        },
        parseOutput: (r) => ({
          verdict: r.exitCode === 0 ? "pass" : "fail",
          feedback: r.exitCode === 0 ? "green" : "RED: thing broke",
        }),
      },
      reason: {
        enabled: true,
        issueText: "fix it",
        getCurrentDiff: async () => "diff body",
      },
    });

    const result = await loop.run("fix it");
    expect(result.stopReason).toBe("completed");
    expect(verifyRounds).toEqual([1, 2]);
    // Reason fires only ONCE — after verify passes on round 2.
    expect(reasonRounds).toEqual([1]);
    expect(result.verifyVerdicts?.map((v) => v.verdict)).toEqual(["fail", "pass"]);
    expect(result.reasonVerdicts?.[0].verdict).toBe("ship");
  });

  it("captures non-zero exit + stderr correctly via real exec", async () => {
    // Sanity: the agent actually sees concrete failure text from a real process.
    mockTurnQueue = [{ content: "v1" }, { content: "v2" }];
    const { callbacks } = collectCallbacks();

    const loop = new AgentLoop({
      config: makeConfig(),
      workspaceRoot: "/tmp",
      callbacks,
      verify: {
        enabled: true,
        maxRounds: 2,
        buildCommand: async () => ({
          argv: ["/bin/sh", "-c", "echo 'FAIL: widget_test' 1>&2; exit 2"],
          cwd: "/tmp",
        }),
        parseOutput: (r) => ({
          verdict: r.exitCode === 0 ? "pass" : "fail",
          feedback: r.stderr.trim(),
        }),
      },
    });

    const result = await loop.run("do thing");
    // Round 1 verify fails → feedback injected → agent turn 2 → round 2 verify
    // fails again but we're at maxRounds=2 so we ship anyway with both verdicts
    // recorded for the caller's report.
    expect(result.verifyVerdicts).toHaveLength(2);
    expect(result.verifyVerdicts?.[0].feedback).toContain("FAIL: widget_test");
    const injectedUserMsg = result.messages.find(
      (m, i) => m.role === "user" && i > 1 && typeof m.content === "string" && m.content.includes("FAIL: widget_test"),
    );
    expect(injectedUserMsg).toBeDefined();
  });
});
