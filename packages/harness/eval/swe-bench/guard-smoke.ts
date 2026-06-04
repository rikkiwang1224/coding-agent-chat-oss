#!/usr/bin/env node
/**
 * Smoke test for SWE-bench test-file guards (no LLM).
 * Verifies tool-layer blocking + patch extraction filtering.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ToolExecutor } from "../../src/tools/executor.js";
import { sweBenchProtectedPathPatterns } from "./protected-paths.js";
import { extractModelPatch, isTestFilePath } from "./patch.js";

const execFileAsync = promisify(execFile);

function ok(msg: string): void {
  process.stdout.write(`  ✓ ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`  ✗ ${msg}\n`);
  process.exit(1);
}

async function gitInitCommit(cwd: string, files: Record<string, string>): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "smoke@test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "smoke"], { cwd });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(cwd, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await execFileAsync("git", ["add", "-A"], { cwd });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd });
}

async function main(): Promise<void> {
  process.stdout.write("=== SWE-bench guard smoke ===\n\n");

  const patterns = sweBenchProtectedPathPatterns();
  if (patterns.length < 4) {
    fail(`expected >=4 protected patterns, got ${patterns.length}`);
  }
  ok(`protected patterns: ${patterns.join(", ")}`);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "swe-guard-smoke-"));
  const executor = new ToolExecutor({
    workspaceRoot: tmpDir,
    protectedPathPatterns: patterns,
  });

  try {
    await writeFile(path.join(tmpDir, "src.py"), "def foo():\n    return 1\n", "utf8");
    await mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await writeFile(path.join(tmpDir, "tests", "test_foo.py"), "def test_foo():\n    assert True\n", "utf8");

    // Tool layer: block test edits
    const blockedEdit = await executor.execute("edit_file", {
      path: "tests/test_foo.py",
      old_string: "assert True",
      new_string: "assert False",
    });
    if (blockedEdit.ok) fail("edit_file on tests/test_foo.py should be blocked");
    if (!blockedEdit.output.includes("protected")) fail("blocked edit missing protected message");
    ok("edit_file blocked on tests/test_foo.py");

    const blockedWrite = await executor.execute("write_file", {
      path: "tests/test_new.py",
      content: "pass\n",
    });
    if (blockedWrite.ok) fail("write_file on tests/test_new.py should be blocked");
    ok("write_file blocked on tests/test_new.py");

    const allowed = await executor.execute("edit_file", {
      path: "src.py",
      old_string: "return 1",
      new_string: "return 2",
    });
    if (!allowed.ok) fail(`edit_file on src.py should succeed: ${allowed.output}`);
    ok("edit_file allowed on src.py");

    const patchBlock = await executor.execute("apply_patch", {
      patch: [
        "diff --git a/tests/test_foo.py b/tests/test_foo.py",
        "--- a/tests/test_foo.py",
        "+++ b/tests/test_foo.py",
        "@@ -1 +1 @@",
        "-def test_foo():",
        "+def test_foo():  # hacked",
      ].join("\n"),
    });
    if (patchBlock.ok) fail("apply_patch targeting test file should be blocked");
    ok("apply_patch blocked on test file");

    // Patch filter: strip test hunks even if written via bash bypass
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "swe-guard-patch-"));
    try {
      await gitInitCommit(repoDir, {
        "lib.py": "x = 1\n",
        "tests/test_lib.py": "def test_x():\n    assert True\n",
      });
      await writeFile(path.join(repoDir, "lib.py"), "x = 2\n", "utf8");
      await writeFile(path.join(repoDir, "tests", "test_lib.py"), "def test_x():\n    assert False\n", "utf8");

      const patch = await extractModelPatch(repoDir);
      if (patch.includes("tests/test_lib.py")) fail("extractModelPatch still contains test file hunk");
      if (!patch.includes("lib.py")) fail("extractModelPatch missing source file hunk");
      ok("extractModelPatch keeps source, drops test hunks");

      if (!isTestFilePath("tests/test_lib.py")) fail("isTestFilePath should detect tests/test_lib.py");
      if (isTestFilePath("lib.py")) fail("isTestFilePath should not flag lib.py");
      ok("isTestFilePath heuristics");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }

    process.stdout.write("\n=== all guard checks passed ===\n");
  } finally {
    executor.destroy();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
