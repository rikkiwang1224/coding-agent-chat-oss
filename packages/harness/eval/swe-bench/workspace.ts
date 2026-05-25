import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SweBenchInstance } from "./types.js";

const execFileAsync = promisify(execFile);

function repoSlug(repo: string): string {
  return repo.replace("/", "__");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Bare clone cache at reposCacheDir/{owner__repo}/ */
export async function ensureRepoCache(
  instance: SweBenchInstance,
  reposCacheDir: string,
): Promise<string> {
  await mkdir(reposCacheDir, { recursive: true });
  const cachePath = path.join(reposCacheDir, repoSlug(instance.repo));

  if (await pathExists(path.join(cachePath, "HEAD"))) {
    return cachePath;
  }

  const url = `https://github.com/${instance.repo}.git`;
  console.log(`  [clone] ${instance.repo} → ${cachePath}`);
  await execFileAsync("git", ["clone", "--bare", url, cachePath], {
    timeout: 600_000,
  });
  return cachePath;
}

/** Detached worktree at base_commit for agent editing. */
export async function createInstanceWorkspace(
  instance: SweBenchInstance,
  reposCacheDir: string,
  worktreesDir: string,
): Promise<string> {
  const cachePath = await ensureRepoCache(instance, reposCacheDir);
  await mkdir(worktreesDir, { recursive: true });

  const worktreePath = path.join(worktreesDir, instance.instance_id);

  if (await pathExists(worktreePath)) {
    await removeWorktree(cachePath, worktreePath);
  }

  await execFileAsync(
    "git",
    ["-C", cachePath, "fetch", "origin", instance.base_commit, "--depth", "1"],
    { timeout: 300_000 },
  ).catch(async () => {
    await execFileAsync("git", ["-C", cachePath, "fetch", "origin"], {
      timeout: 600_000,
    });
  });

  await execFileAsync(
    "git",
    ["-C", cachePath, "worktree", "add", "--detach", worktreePath, instance.base_commit],
    { timeout: 120_000 },
  );

  return worktreePath;
}

export async function removeWorktree(cachePath: string, worktreePath: string): Promise<void> {
  if (!(await pathExists(worktreePath))) return;

  try {
    await execFileAsync(
      "git",
      ["-C", cachePath, "worktree", "remove", "--force", worktreePath],
      { timeout: 60_000 },
    );
  } catch {
    await execFileAsync("rm", ["-rf", worktreePath], { timeout: 60_000 }).catch(() => {});
    await execFileAsync(
      "git",
      ["-C", cachePath, "worktree", "prune"],
      { timeout: 30_000 },
    ).catch(() => {});
  }
}
