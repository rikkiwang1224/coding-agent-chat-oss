import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Extract unified diff of all tracked changes (excludes untracked files). */
export async function extractModelPatch(workspaceDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--no-color", "--", "."],
      { cwd: workspaceDir, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch {
    return "";
  }
}
