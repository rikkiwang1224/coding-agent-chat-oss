import { describe, it, expect } from "vitest";
import { buildActivityDigest, renderActivityDigest } from "../src/activity-digest.js";
import type { ChatMessage } from "../src/types.js";

function tc(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe("buildActivityDigest", () => {
  it("ignores system + user messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are an agent" },
      { role: "user", content: "fix the bug" },
    ];
    const d = buildActivityDigest(messages);
    expect(d.totalTurns).toBe(0);
    expect(d.totalToolCalls).toBe(0);
    expect(d.events).toHaveLength(0);
    expect(d.lastClaim).toBeUndefined();
  });

  it("captures tool calls with output previews", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "look at the code" },
      {
        role: "assistant",
        content: null,
        tool_calls: [tc("t1", "read_file", { path: "src/foo.ts" })],
      },
      {
        role: "tool",
        tool_call_id: "t1",
        content: "export const x = 1;\nexport const y = 2;",
      },
    ];
    const d = buildActivityDigest(messages);
    expect(d.totalToolCalls).toBe(1);
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({
      kind: "tool",
      tool: "read_file",
      summary: expect.stringContaining("read_file"),
      output: expect.stringContaining("export const x = 1"),
    });
  });

  it("captures assistant bullets and reports lastClaim", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "fix" },
      { role: "assistant", content: "All tests pass. Done." },
    ];
    const d = buildActivityDigest(messages);
    expect(d.totalTurns).toBe(1);
    expect(d.events[0].kind).toBe("bullet");
    expect(d.lastClaim).toBe("All tests pass. Done.");
  });

  it("truncates the newest N events when over budget", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "do many things" }];
    for (let i = 0; i < 30; i++) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [tc(`t${i}`, "bash", { command: `echo ${i}` })],
      });
      messages.push({ role: "tool", tool_call_id: `t${i}`, content: `${i}\n` });
    }
    const d = buildActivityDigest(messages, { maxEvents: 5 });
    expect(d.totalToolCalls).toBe(30);
    expect(d.events).toHaveLength(5);
    // We should keep the LATEST events (29 down)
    expect(d.events[d.events.length - 1].summary).toContain("echo 29");
    expect(d.events[0].summary).toContain("echo 25");
  });

  it("truncates long tool outputs", () => {
    const longContent = "x".repeat(1000);
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [tc("t1", "bash", { command: "ls" })],
      },
      { role: "tool", tool_call_id: "t1", content: longContent },
    ];
    const d = buildActivityDigest(messages, { maxChars: 100 });
    expect(d.events[0].output!.length).toBeLessThanOrEqual(101); // 100 chars + ellipsis
    expect(d.events[0].output).toContain("…");
  });

  it("compactArgs strips deeply nested structures", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          tc("t1", "todo_write", { todos: [{ id: "1", content: "do x", status: "pending" }] }),
        ],
      },
    ];
    const d = buildActivityDigest(messages);
    expect(d.events[0].summary).toContain("todos=<...>");
  });
});

describe("renderActivityDigest", () => {
  it("renders into a markdown block with turn numbers and tool args", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Looking at the code.",
        tool_calls: [tc("t1", "read_file", { path: "src/a.ts" })],
      },
      { role: "tool", tool_call_id: "t1", content: "code" },
    ];
    const out = renderActivityDigest(buildActivityDigest(messages));
    expect(out).toContain("Agent activity summary");
    expect(out).toContain("T1 say:");
    expect(out).toContain("T1 read_file");
    expect(out).toContain("path=");
  });
});
