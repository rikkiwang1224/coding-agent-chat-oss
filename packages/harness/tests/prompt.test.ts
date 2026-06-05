import { describe, expect, it } from "vitest";
import { buildSystemPrompt, mergePromptContextFromEnv, withLlmIdentity } from "../src/prompt.js";

describe("buildSystemPrompt", () => {
  it("includes workspace root from string shorthand", () => {
    const prompt = buildSystemPrompt("/tmp/ws");
    expect(prompt).toContain("Root: /tmp/ws");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("bash");
  });

  it("adds debug workflow when taskHint is debug", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/ws",
      taskHint: "debug",
    });
    expect(prompt).toContain("Workflow (Debugging)");
    expect(prompt).toContain("root cause");
  });

  it("adds language hints for typescript", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/ws",
      languages: ["typescript"],
    });
    expect(prompt).toContain("Language Notes");
    expect(prompt).toContain("TypeScript");
  });

  it("adds terminal workflow when taskHint is terminal", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/ws",
      taskHint: "terminal",
    });
    expect(prompt).toContain("Workflow (Terminal / CLI Tasks)");
    expect(prompt).toContain("timeout_ms");
  });

  it("includes custom instructions section", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/ws",
      customInstructions: "Always run tests after edits.",
    });
    expect(prompt).toContain("Project-Specific Instructions");
    expect(prompt).toContain("Always run tests after edits.");
  });

  it("includes identity section with configured provider and model", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/ws",
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    expect(prompt).toContain("## Identity");
    expect(prompt).toContain("Forgelet");
    expect(prompt).toContain("DeepSeek");
    expect(prompt).toContain("deepseek-v4-pro");
    expect(prompt).toContain("Never invent or guess your vendor");
    expect(prompt).toContain("Forgelet on DeepSeek (deepseek-v4-pro)");
  });

  it("withLlmIdentity merges config into prompt context", () => {
    const merged = withLlmIdentity({ workspaceRoot: "/tmp/ws" }, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    expect(merged.provider).toBe("deepseek");
    expect(merged.model).toBe("deepseek-v4-pro");
  });

  it("merges prompt extras from env", () => {
    const prev = process.env.FORGELET_SYSTEM_PROMPT_EXTRA;
    process.env.FORGELET_SYSTEM_PROMPT_EXTRA = "Prefer jq for JSON.";
    try {
      const merged = mergePromptContextFromEnv({ workspaceRoot: "/tmp/ws" });
      const prompt = buildSystemPrompt(merged);
      expect(prompt).toContain("Prefer jq for JSON.");
    } finally {
      if (prev === undefined) delete process.env.FORGELET_SYSTEM_PROMPT_EXTRA;
      else process.env.FORGELET_SYSTEM_PROMPT_EXTRA = prev;
    }
  });
});
