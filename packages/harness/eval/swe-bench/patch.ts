import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Extract unified diff of all tracked changes (excludes untracked files).
 *
 * IMPORTANT: must NOT use `.trim()` — `git apply` requires the patch to end
 * with a newline. Stripping the trailing `\n` from a `git diff` whose last
 * hunk line is a context line (very common) makes the patch end mid-line,
 * which causes SWE-bench's eval pipeline to fail to apply it (silently
 * scoring the run as "failed_run" instead of "unresolved"). We instead
 * normalize to exactly one trailing newline, which is what git produces. */
export async function extractModelPatch(workspaceDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--no-color", "--", "."],
      { cwd: workspaceDir, maxBuffer: 16 * 1024 * 1024 },
    );
    const filtered = filterTestFileDiffs(stdout);
    const trimmed = filtered.trimEnd();
    return trimmed ? `${trimmed}\n` : "";
  } catch {
    return "";
  }
}

/**
 * Remove diff hunks that target test files. This is a safety net for cases
 * where the agent bypasses the tool guard (e.g. using bash to write files).
 */
function filterTestFileDiffs(rawDiff: string): string {
  const chunks = splitDiffByFile(rawDiff);
  const kept = chunks.filter((chunk) => {
    const match = chunk.match(/^diff --git a\/.+ b\/(.+)/m);
    if (!match) return true;
    const filePath = match[1];
    return !isTestFilePath(filePath);
  });
  return kept.join("");
}

function splitDiffByFile(diff: string): string[] {
  const chunks: string[] = [];
  const lines = diff.split("\n");
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n") + "\n");
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    chunks.push(current.join("\n") + "\n");
  }
  return chunks;
}

/** Detect test file paths using common Python project conventions. */
export function isTestFilePath(filePath: string): boolean {
  const basename = filePath.split("/").pop() || "";
  if (basename.startsWith("test_") || basename.endsWith("_test.py")) {
    return true;
  }
  const segments = filePath.split("/");
  return segments.some((s) => s === "tests" || s === "testing" || s === "test");
}
