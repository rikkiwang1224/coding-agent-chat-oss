import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

const WORKSPACE_DISCOVERY_DEPTH = 4;
const IGNORED_DISCOVERY_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "__pycache__",
  "vendor",
  "target"
]);

export function resolveDefaultWorkspacePath(): string | null {
  const configuredWorkspaceRoot = process.env.AGENT_WORKSPACE_ROOT?.trim();
  const candidate =
    configuredWorkspaceRoot && configuredWorkspaceRoot.length > 0
      ? path.resolve(configuredWorkspaceRoot)
      : app.isPackaged
        ? null
        : path.resolve(process.cwd());

  if (!candidate) {
    return null;
  }

  if (
    existsSync(path.join(candidate, ".git")) ||
    existsSync(path.join(candidate, ".lattice-code")) ||
    existsSync(path.join(candidate, "package.json"))
  ) {
    return candidate;
  }

  return null;
}

export function normalizeWorkspacePaths(paths: Array<string | undefined | null>): string[] {
  const unique = new Set<string>();
  const normalized: string[] = [];

  for (const candidate of paths) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      continue;
    }

    const resolved = path.resolve(candidate);
    if (!existsSync(resolved) || unique.has(resolved)) {
      continue;
    }

    unique.add(resolved);
    normalized.push(resolved);
  }

  return normalized;
}

export async function discoverWorkspacePaths(root: string, maxDepth = WORKSPACE_DISCOVERY_DEPTH): Promise<string[]> {
  const discovered = new Set<string>();

  async function visitDirectory(target: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      return;
    }

    if (existsSync(path.join(target, ".lattice-code", "harness-sessions"))) {
      discovered.add(path.resolve(target));
    }

    if (depth >= maxDepth) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === ".lattice-code" || IGNORED_DISCOVERY_DIRS.has(entry.name)) {
        continue;
      }

      if (entry.name.startsWith(".")) {
        continue;
      }

      await visitDirectory(path.join(target, entry.name), depth + 1);
    }
  }

  await visitDirectory(root, 0);
  return [...discovered];
}

export function readGitBranch(workspacePath: string): string {
  try {
    const branch = execFileSync("git", ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    return branch || "No git";
  } catch {
    return "No git";
  }
}
