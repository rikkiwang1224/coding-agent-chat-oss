import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runConfigCommand } from "../src/commands/config.js";

describe("runConfigCommand set", () => {
  let tempHome: string;
  let stdout = "";
  let stderr = "";

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "forgelet-config-"));
    process.env.FORGELET_HOME = tempHome;
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.FORGELET_HOME;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("writes key-value pairs to config.json", async () => {
    const code = await runConfigCommand(["set", "provider", "anthropic", "model", "claude-sonnet-4"]);
    expect(code).toBe(0);

    const configPath = path.join(tempHome, "config.json");
    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      provider: string;
      primaryModel: string;
    };
    expect(saved.provider).toBe("anthropic");
    expect(saved.primaryModel).toBe("claude-sonnet-4");
    expect(stdout).toContain("provider: anthropic");
  });

  it("supports key=value syntax", async () => {
    const code = await runConfigCommand(["set", "base-url=https://api.example.com/v1"]);
    expect(code).toBe(0);

    const saved = JSON.parse(await readFile(path.join(tempHome, "config.json"), "utf8")) as {
      baseUrl: string;
    };
    expect(saved.baseUrl).toBe("https://api.example.com/v1");
  });

  it("returns error for unknown keys", async () => {
    const code = await runConfigCommand(["set", "unknown", "value"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown config key");
  });
});
