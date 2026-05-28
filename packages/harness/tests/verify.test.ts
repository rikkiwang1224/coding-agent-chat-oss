import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runVerify,
  formatVerifyFeedback,
  truncateTail,
  truncateHead,
  extractFailureExcerpt,
  type VerifyConfig,
  type ExecResult,
} from "../src/verify.js";

// We use real child processes (sh, echo, sleep) to exercise the spawn path —
// mocking execFile loses real-world failure modes (timeouts, ENOENT, exit codes).
const SH = "/bin/sh";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "verify-test-"));
});
afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const passingParser = (r: ExecResult) => ({
  verdict: r.exitCode === 0 ? ("pass" as const) : ("fail" as const),
  feedback: r.exitCode === 0 ? "ok" : `exit ${r.exitCode}: ${r.stderr}`,
});

describe("runVerify", () => {
  it("returns pass when command exits 0", async () => {
    const cfg: VerifyConfig = {
      enabled: true,
      buildCommand: async () => ({ argv: [SH, "-c", "echo ok"], cwd: tmpDir }),
      parseOutput: passingParser,
    };
    const result = await runVerify(cfg);
    expect(result).not.toBe("skipped");
    if (result === "skipped") throw new Error("unreachable");
    expect(result.verdict).toBe("pass");
  });

  it("returns fail with stderr surfaced when command exits non-zero", async () => {
    const cfg: VerifyConfig = {
      enabled: true,
      buildCommand: async () => ({
        argv: [SH, "-c", "echo boom 1>&2; exit 3"],
        cwd: tmpDir,
      }),
      parseOutput: passingParser,
    };
    const result = await runVerify(cfg);
    if (result === "skipped") throw new Error("unreachable");
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toContain("exit 3");
    expect(result.feedback).toContain("boom");
  });

  it("returns 'skipped' when buildCommand returns undefined", async () => {
    const cfg: VerifyConfig = {
      enabled: true,
      buildCommand: async () => undefined,
      parseOutput: passingParser,
    };
    const result = await runVerify(cfg);
    expect(result).toBe("skipped");
  });

  it("captures spawn errors (ENOENT) into a fail verdict, never throws", async () => {
    // Parser sees exitCode=null and "spawn error" on stderr.
    const cfg: VerifyConfig = {
      enabled: true,
      buildCommand: async () => ({
        argv: ["/definitely/not/a/real/binary/forgelet-test"],
        cwd: tmpDir,
      }),
      parseOutput: (r) => ({
        verdict: "fail" as const,
        feedback: `exit=${r.exitCode} stderr=${r.stderr.slice(0, 200)}`,
      }),
    };
    const result = await runVerify(cfg);
    if (result === "skipped") throw new Error("unreachable");
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toMatch(/spawn error|ENOENT/i);
  });

  it("enforces timeoutMs and marks the result as timed out", async () => {
    const cfg: VerifyConfig = {
      enabled: true,
      timeoutMs: 120,
      buildCommand: async () => ({
        argv: [SH, "-c", "sleep 5"],
        cwd: tmpDir,
      }),
      // The parser receives timedOut=true so it knows what happened.
      parseOutput: (r) => ({
        verdict: r.timedOut ? "fail" : ("pass" as "pass" | "fail"),
        feedback: r.timedOut ? "timed out" : "ok",
      }),
    };
    const startedAt = Date.now();
    const result = await runVerify(cfg);
    const elapsed = Date.now() - startedAt;
    if (result === "skipped") throw new Error("unreachable");
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toBe("timed out");
    // Should kill close to the timeout (give generous slack for CI).
    expect(elapsed).toBeLessThan(3000);
  });

  it("converts parser exceptions into fail verdicts with diagnostics", async () => {
    const cfg: VerifyConfig = {
      enabled: true,
      label: "test-gate",
      buildCommand: async () => ({ argv: [SH, "-c", "echo hi"], cwd: tmpDir }),
      parseOutput: () => {
        throw new Error("oops the parser is broken");
      },
    };
    const result = await runVerify(cfg);
    if (result === "skipped") throw new Error("unreachable");
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toContain("parser error");
    expect(result.feedback).toContain("oops the parser is broken");
    expect(result.feedback).toContain("[verify test-gate]");
  });

  it("propagates buildCommand exceptions (caller bug, fail loudly)", async () => {
    const cfg: VerifyConfig = {
      enabled: true,
      buildCommand: async () => {
        throw new Error("git diff failed");
      },
      parseOutput: passingParser,
    };
    await expect(runVerify(cfg)).rejects.toThrow(/buildCommand threw.*git diff failed/);
  });

  it("passes env to child process and respects cwd", async () => {
    // Write a sentinel script that echoes a custom env var + pwd.
    const script = join(tmpDir, "probe.sh");
    writeFileSync(
      script,
      "#!/bin/sh\necho \"VAR=$FORGELET_TEST_VAR PWD=$(pwd)\"\n",
    );
    chmodSync(script, 0o755);

    const cfg: VerifyConfig = {
      enabled: true,
      buildCommand: async () => ({
        argv: [script],
        cwd: tmpDir,
        env: { FORGELET_TEST_VAR: "hello-verify" },
      }),
      parseOutput: (r) => ({
        verdict: "pass" as const,
        feedback: r.stdout.trim(),
      }),
    };
    const result = await runVerify(cfg);
    if (result === "skipped") throw new Error("unreachable");
    expect(result.feedback).toContain("VAR=hello-verify");
    expect(result.feedback).toContain(tmpDir);
  });
});

describe("formatVerifyFeedback", () => {
  it("renders the round header and trailing instruction", () => {
    const text = formatVerifyFeedback(
      { verdict: "fail", feedback: "test_widgets.py::test_select_renders FAILED" },
      2,
      "django-tests",
    );
    expect(text).toContain("[django-tests gate — round 2]");
    expect(text).toContain("test_widgets.py::test_select_renders FAILED");
    expect(text).toContain("re-verify");
  });

  it("uses the default label when none is supplied", () => {
    const text = formatVerifyFeedback({ verdict: "fail", feedback: "nope" }, 1);
    expect(text).toContain("[verify gate — round 1]");
  });
});

describe("truncateTail / truncateHead", () => {
  it("returns input unchanged when under budget", () => {
    expect(truncateTail("short", 100)).toBe("short");
    expect(truncateHead("short", 100)).toBe("short");
  });

  it("truncateTail keeps the END of the text", () => {
    const big = "x".repeat(50) + "TAIL_MARKER";
    const out = truncateTail(big, 20);
    expect(out).toContain("TAIL_MARKER");
    expect(out).toContain("bytes elided");
    expect(out.length).toBeLessThan(big.length);
  });

  it("truncateHead keeps the START of the text", () => {
    const big = "HEAD_MARKER" + "x".repeat(50);
    const out = truncateHead(big, 20);
    expect(out).toContain("HEAD_MARKER");
    expect(out).toContain("bytes elided");
  });
});

describe("extractFailureExcerpt", () => {
  it("returns the input unchanged when no patterns match (within budget)", () => {
    const text = "everything is fine\nno failures here";
    const out = extractFailureExcerpt(text, [/FAIL/, /ERROR/]);
    expect(out).toBe(text);
  });

  it("falls back to tail when no patterns match and text is long", () => {
    const text = "x".repeat(10_000) + "\nLATER";
    const out = extractFailureExcerpt(text, [/FAIL/], 5, 500);
    expect(out).toContain("LATER");
    expect(out).toContain("bytes elided");
  });

  it("returns context around matches and merges overlapping windows", () => {
    const lines = [
      "context line 0",
      "context line 1",
      "context line 2",
      "test_a FAILED here",
      "traceback line",
      "context line 5",
      "context line 6",
      "test_b ERROR here",
      "more traceback",
      "context line 9",
      "context line 10",
      "context line 11",
      "context line 12",
    ];
    const out = extractFailureExcerpt(lines.join("\n"), [/FAILED/, /ERROR/], 2, 5000);
    expect(out).toContain("test_a FAILED here");
    expect(out).toContain("test_b ERROR here");
    expect(out).toContain("traceback line");
    // Both failure regions should appear (merged because they're close).
    expect(out.match(/FAILED|ERROR/g)?.length).toBe(2);
  });

  it("respects maxBytes budget", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`filler line ${i}`);
    for (let i = 0; i < 50; i++) {
      lines.push(`test_${i} FAILED with some message`);
      lines.push(`  traceback frame for ${i}`);
    }
    const out = extractFailureExcerpt(lines.join("\n"), [/FAILED/], 2, 400);
    expect(out.length).toBeLessThan(800); // budget + some elision markers
    expect(out).toMatch(/elided/);
  });
});
