import { describe, expect, it } from "vitest";
import { parseArgv } from "../src/argv.js";

describe("parseArgv", () => {
  it("parses prompt and flags", () => {
    const parsed = parseArgv(["-c", "/tmp/proj", "--model", "gpt-4", "fix", "the", "tests"]);
    expect(parsed.cwd).toBe("/tmp/proj");
    expect(parsed.model).toBe("gpt-4");
    expect(parsed.prompt).toBe("fix the tests");
  });

  it("detects interactive and yes flags", () => {
    expect(parseArgv(["-i", "-y"]).interactive).toBe(true);
    expect(parseArgv(["-i", "-y"]).yes).toBe(true);
  });

  it("parses inline option values", () => {
    expect(parseArgv(["--session=abc-123"]).sessionId).toBe("abc-123");
  });
});
