import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ShellSession } from "../src/tools/shell-session.js";

describe("ShellSession", () => {
  let tmpDir: string;
  let session: ShellSession;

  afterEach(() => {
    session?.destroy();
  });

  async function createSession(): Promise<ShellSession> {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "shell-session-"));
    session = new ShellSession(tmpDir);
    return session;
  }

  it("runs a simple command and returns stdout", async () => {
    const shell = await createSession();
    const result = await shell.execute("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
  });

  it("returns non-zero exit code for failing commands", async () => {
    const shell = await createSession();
    const result = await shell.execute("exit 1");
    expect(result.exitCode).toBe(1);
  });

  it("preserves cwd across commands", async () => {
    const shell = await createSession();
    await mkdir(path.join(tmpDir, "subdir"));
    await writeFile(path.join(tmpDir, "subdir", "marker.txt"), "found");

    await shell.execute("cd subdir");
    const result = await shell.execute("cat marker.txt");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("found");
  });

  it("captures failing command output before returning", async () => {
    const shell = await createSession();
    const result = await shell.execute('node -e "console.error(\\"FAIL: bad value\\"); process.exit(1)"');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FAIL: bad value");
  });

  it("times out long commands", async () => {
    const shell = await createSession();
    const result = await shell.execute("sleep 30", 500);
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("timed out");
  });
});
