import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  LocalEnvironment,
  redactSensitiveEnv,
} from "../src/execution/local-environment.js";
import { ShellSession } from "../src/tools/shell-session.js";

describe("LocalEnvironment", () => {
  let tmpDir: string;
  let session: LocalEnvironment;

  afterEach(() => {
    session?.destroy();
  });

  async function createSession(): Promise<LocalEnvironment> {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "local-env-"));
    session = new LocalEnvironment(tmpDir);
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

  it("rejects when AbortSignal fires mid-command", async () => {
    const shell = await createSession();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    await expect(
      shell.execute("sleep 30", 30_000, controller.signal),
    ).rejects.toThrow(/abort/i);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("rejects immediately if signal already aborted", async () => {
    const shell = await createSession();
    const controller = new AbortController();
    controller.abort();
    await expect(
      shell.execute("echo hi", 5000, controller.signal),
    ).rejects.toThrow(/abort/i);
  });

  it("respawns the shell after an abort so subsequent commands work", async () => {
    const shell = await createSession();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(
      shell.execute("sleep 30", 30_000, controller.signal),
    ).rejects.toThrow(/abort/i);
    // The aborted shell is torn down (non-interactive bash ignores Ctrl-C),
    // but the session transparently spawns a fresh one for the next call —
    // any cwd / env state from before the abort is intentionally lost.
    const result = await shell.execute("echo recovered");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("recovered");
  });

  it("is still exported as ShellSession for backward compatibility", () => {
    expect(ShellSession).toBe(LocalEnvironment);
  });
});

describe("LocalEnvironment — env redaction (P0)", () => {
  let tmpDir: string;
  let session: LocalEnvironment;
  const SECRET_NAME = "MYTEST_PROVIDER_API_KEY";
  const PLAIN_NAME = "MYTEST_PLAIN_VAR";

  beforeEach(() => {
    process.env[SECRET_NAME] = "sk-super-secret";
    process.env[PLAIN_NAME] = "visible-value";
  });

  afterEach(() => {
    session?.destroy();
    delete process.env[SECRET_NAME];
    delete process.env[PLAIN_NAME];
    delete process.env.LATTICE_CODE_EXEC_ENV_ALLOW;
    delete process.env.LATTICE_CODE_EXEC_ENV_PASSTHROUGH;
  });

  async function createSession(): Promise<LocalEnvironment> {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "local-env-redact-"));
    session = new LocalEnvironment(tmpDir);
    return session;
  }

  it("does not expose secret-looking env vars to the shell", async () => {
    const shell = await createSession();
    const result = await shell.execute(`printenv ${SECRET_NAME} || echo __ABSENT__`);
    expect(result.output).toContain("__ABSENT__");
    expect(result.output).not.toContain("sk-super-secret");
  });

  it("passes through non-sensitive env vars", async () => {
    const shell = await createSession();
    const result = await shell.execute(`printenv ${PLAIN_NAME}`);
    expect(result.output).toContain("visible-value");
  });

  it("keeps a secret var when explicitly allowlisted", async () => {
    process.env.LATTICE_CODE_EXEC_ENV_ALLOW = SECRET_NAME;
    const shell = await createSession();
    const result = await shell.execute(`printenv ${SECRET_NAME}`);
    expect(result.output).toContain("sk-super-secret");
  });

  it("passes everything through when the escape hatch is set", async () => {
    process.env.LATTICE_CODE_EXEC_ENV_PASSTHROUGH = "1";
    const shell = await createSession();
    const result = await shell.execute(`printenv ${SECRET_NAME}`);
    expect(result.output).toContain("sk-super-secret");
  });
});

describe("redactSensitiveEnv", () => {
  it("strips common secret name patterns", () => {
    const out = redactSensitiveEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      DEEPSEEK_API_KEY: "sk-1",
      GITHUB_TOKEN: "ghp_x",
      DB_PASSWORD: "pw",
      AWS_SECRET_ACCESS_KEY: "aws",
      MY_PASSPHRASE: "p",
    });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/me");
    expect(out.DEEPSEEK_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.DB_PASSWORD).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.MY_PASSPHRASE).toBeUndefined();
  });

  it("strips vendor-prefixed vars even without an obvious secret token", () => {
    const out = redactSensitiveEnv({
      TENCENTCLOUD_SECRET_ID: "id",
      OPENAI_ORG: "org",
      KEEP_ME: "yes",
    });
    expect(out.TENCENTCLOUD_SECRET_ID).toBeUndefined();
    expect(out.OPENAI_ORG).toBeUndefined();
    expect(out.KEEP_ME).toBe("yes");
  });

  it("honors the allowlist", () => {
    const out = redactSensitiveEnv(
      { GITHUB_TOKEN: "ghp_x", DEEPSEEK_API_KEY: "sk-1" },
      { allow: ["GITHUB_TOKEN"] },
    );
    expect(out.GITHUB_TOKEN).toBe("ghp_x");
    expect(out.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("returns everything when passthrough is enabled", () => {
    const out = redactSensitiveEnv(
      { DEEPSEEK_API_KEY: "sk-1", PATH: "/usr/bin" },
      { passthrough: true },
    );
    expect(out.DEEPSEEK_API_KEY).toBe("sk-1");
    expect(out.PATH).toBe("/usr/bin");
  });
});

describe("LocalEnvironment — resource limits (P0)", () => {
  let tmpDir: string;
  let session: LocalEnvironment;

  afterEach(() => {
    session?.destroy();
    delete process.env.LATTICE_CODE_EXEC_MAX_FILESIZE;
  });

  it("applies the configured file-size ulimit to the shell", async () => {
    // Lowering a limit is always permitted, so this deterministically proves
    // the ulimit init line ran inside the spawned shell.
    process.env.LATTICE_CODE_EXEC_MAX_FILESIZE = "100";
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "local-env-ulimit-"));
    session = new LocalEnvironment(tmpDir);
    const result = await session.execute("ulimit -f");
    expect(result.output.trim()).toBe("100");
  });
});
