import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractModelPatch } from "../eval/swe-bench/patch.js";

/**
 * Guards the timeout-salvage path (extract-patch.ts → extractModelPatch):
 * when the agent process is hard-killed, docker-batch.sh recovers the
 * worktree diff through this function. It must keep source edits, drop
 * test-file edits, and end with exactly one trailing newline (git apply
 * rejects patches without it).
 */
describe("swe-bench patch salvage (extractModelPatch)", () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "swe-salvage-"));
    git("init", "-q");
    mkdirSync(path.join(repo, "pkg", "tests"), { recursive: true });
    writeFileSync(path.join(repo, "pkg", "core.py"), "def f(): return 1\n");
    writeFileSync(path.join(repo, "pkg", "tests", "test_core.py"), "def test_f(): pass\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("salvages source edits but filters test-file edits", async () => {
    writeFileSync(path.join(repo, "pkg", "core.py"), "def f(): return 2\n");
    writeFileSync(path.join(repo, "pkg", "tests", "test_core.py"), "def test_f(): assert 1\n");

    const patch = await extractModelPatch(repo);

    expect(patch).toContain("diff --git a/pkg/core.py b/pkg/core.py");
    expect(patch).not.toContain("test_core.py");
    expect(patch.endsWith("\n")).toBe(true);
    expect(patch.endsWith("\n\n")).toBe(false);
  });

  it("returns empty string for a clean worktree", async () => {
    await expect(extractModelPatch(repo)).resolves.toBe("");
  });
});
