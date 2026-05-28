/**
 * Adapters that compose the generic Verify primitive with concrete project
 * conventions. Today we provide:
 *
 *   buildChangedFilesVerifyConfig — "run the tests that look related to
 *     what you changed" — pairs the git-diff heuristic with a per-repo
 *     test-runner adapter (Django runtests, pytest).
 *
 * Future adapters worth adding:
 *   - typescriptVerifyAdapter   → `tsc --noEmit` after edits
 *   - npmScriptsVerifyAdapter   → respects package.json scripts.verify
 *   - eslintAdapter             → lint only changed files
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VerifyConfig } from "../verify.js";
import { inferTestTargetsFromDiff } from "./changed-files.js";
import { getTestRunner, type TestRunner } from "./test-runners.js";

export {
  inferTestTargetsFromDiff,
  inferTestPathsForSource,
  isTestFile,
  type InferOpts,
  type InferResult,
} from "./changed-files.js";
export {
  getTestRunner,
  fileToDjangoModule,
  TEST_RUNNERS,
  type TestRunner,
  type TestTarget,
  type BuildOpts,
} from "./test-runners.js";

const execFileAsync = promisify(execFile);

export interface ChangedFilesVerifyOpts {
  enabled: boolean;
  /** Repo root (= testbed inside SWE-bench containers; project root for real users). */
  workspaceRoot: string;
  /**
   * GitHub-style "owner/repo" identifier. Selects the runner (Django vs pytest).
   * For SWE-bench, callers pass `instance.repo` directly. For local CLI use, we
   * auto-detect from `git remote get-url origin` (see `detectRepoFromGitRemote`).
   */
  repo: string;
  /** Override the runner picked by `getTestRunner(repo)`. Useful for tests. */
  runner?: TestRunner;
  /** Python interpreter on PATH. Defaults to "python". */
  pythonBin?: string;
  /** Max revise→retry cycles. Default 3. */
  maxRounds?: number;
  /** Per-round timeout in milliseconds. Default 5 minutes. */
  timeoutMs?: number;
  /** Cap the number of test targets inferred per round. Default 8. */
  maxTargetsPerRound?: number;
  /** Git ref to diff against (HEAD by default). */
  baseRef?: string;
}

/**
 * Wire `inferTestTargetsFromDiff` + the per-repo runner into a `VerifyConfig`
 * suitable for `AgentLoop`. Returns undefined when disabled.
 *
 * Behavior:
 *   - On each round, runs `git diff --name-only HEAD` to see what the agent
 *     changed, then asks the per-repo runner to build a test command.
 *   - If the diff is empty (agent edited nothing): skip the round — no budget
 *     consumed, no verdict recorded. The agent is allowed to finish.
 *   - If the diff has changes but the heuristic finds no matching test files:
 *     also skip. We can't gate on tests that don't exist.
 *   - Otherwise: run the command, parse the verdict, surface the feedback.
 */
export function buildChangedFilesVerifyConfig(
  opts: ChangedFilesVerifyOpts,
): VerifyConfig | undefined {
  if (!opts.enabled) return undefined;

  const runner = opts.runner ?? getTestRunner(opts.repo);

  return {
    enabled: true,
    label: runner.id,
    maxRounds: opts.maxRounds ?? 3,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
    buildCommand: async () => {
      const inference = await inferTestTargetsFromDiff({
        workspaceRoot: opts.workspaceRoot,
        repo: opts.repo,
        baseRef: opts.baseRef,
        maxTargets: opts.maxTargetsPerRound,
      });
      if (inference.noChanges) return undefined;
      if (inference.targets.length === 0) return undefined;

      return runner.build({
        testbedDir: opts.workspaceRoot,
        targets: inference.targets,
        pythonBin: opts.pythonBin,
        maxTargets: opts.maxTargetsPerRound,
      });
    },
    parseOutput: (result) =>
      runner.parse(
        {
          testbedDir: opts.workspaceRoot,
          targets: [],
          pythonBin: opts.pythonBin,
          maxTargets: opts.maxTargetsPerRound,
        },
        result,
      ),
  };
}

/**
 * Best-effort: derive an "owner/repo" identifier from `git remote get-url origin`.
 * Returns undefined if not a git repo, no origin remote, or the URL isn't a
 * recognised GitHub-style URL. Callers should fall back to a default.
 *
 * Handles common formats:
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 *   - https://gitlab.com/group/subgroup/repo (multi-segment paths → "group/repo")
 */
export async function detectRepoFromGitRemote(
  workspaceRoot: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: workspaceRoot },
    );
    const url = stdout.trim();
    // git@host:owner/repo(.git)? → owner/repo
    const ssh = url.match(/^[\w.-]+@[\w.-]+:([^/]+)\/(.+?)(\.git)?$/);
    if (ssh) return `${ssh[1]}/${ssh[2]}`;
    // https://host/path/owner/repo(.git)?
    const https = url.match(/https?:\/\/[\w.-]+\/(.+?)(\.git)?$/);
    if (https) {
      const parts = https[1].split("/").filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
