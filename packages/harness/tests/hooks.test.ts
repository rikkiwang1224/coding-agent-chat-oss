import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolExecutor } from "../src/tools/executor.js";

describe("HarnessHooks", () => {
  it("preToolUse can block execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-hooks-"));
    await writeFile(path.join(root, "secret.txt"), "hidden", "utf8");

    const executor = new ToolExecutor({
      workspaceRoot: root,
      hooks: {
        preToolUse: async ({ toolName }) => {
          if (toolName === "read_file") {
            return { allow: false, reason: "blocked" };
          }
        },
      },
    });

    const result = await executor.execute("read_file", { path: "secret.txt" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("preToolUse");

    executor.destroy();
    await rm(root, { recursive: true, force: true });
  });
});
