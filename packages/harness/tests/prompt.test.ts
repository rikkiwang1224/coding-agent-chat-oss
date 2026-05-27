import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/prompt.js";

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

  it("includes custom instructions section", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/ws",
      customInstructions: "Always run tests after edits.",
    });
    expect(prompt).toContain("Project-Specific Instructions");
    expect(prompt).toContain("Always run tests after edits.");
  });
});
