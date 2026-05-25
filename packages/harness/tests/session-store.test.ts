import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionStore, resolveHarnessSessionDir } from "../src/session-store.js";

describe("SessionStore", () => {
  it("saves and loads messages with reasoning_content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-session-"));
    const store = new SessionStore(resolveHarnessSessionDir(root));

    await store.save({
      id: "sess-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "system", content: "You are helpful." },
        {
          role: "assistant",
          content: "ok",
          reasoning_content: "thinking...",
        },
        { role: "user", content: "continue" },
      ],
      metadata: {
        turnCount: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
      },
    });

    const loaded = await store.load("sess-1");
    expect(loaded?.messages).toHaveLength(3);
    expect(loaded?.messages[1].reasoning_content).toBe("thinking...");

    await rm(root, { recursive: true, force: true });
  });
});
