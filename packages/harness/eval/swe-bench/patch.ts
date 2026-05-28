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
    const trimmed = stdout.trimEnd();
    return trimmed ? `${trimmed}\n` : "";
  } catch {
    return "";
  }
}
