#!/usr/bin/env tsx
/**
 * Best-of-N patch selector (the IO half; pure logic lives in
 * packages/harness/src/best-of-n/select.ts).
 *
 * Reads N candidate patches produced by docker-bestofn.sh (candidate_1.patch …
 * candidate_N.patch in --candidates-dir), optionally measures each candidate's
 * regression status by applying it to the testbed and running the inferred
 * related tests, then writes the chosen patch to --out and a structured
 * decision report to --report.
 *
 * Runs INSIDE the SWE-bench container (needs git + the testbed + the conda
 * `python`). Invoked via tsx, importing the built @forgelet/harness dist.
 *
 * Usage:
 *   tsx select-patch.ts \
 *     --candidates-dir /work --out /work/agent.patch --report /work/bestofn-report.json \
 *     --repo django/django --testbed /testbed --base <sha> [--run-regression] [--python python]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  selectPatch,
  type PatchCandidate,
  type RegressionStatus,
  type SelectionResult,
} from "../../src/best-of-n/index.js";
import { buildChangedFilesVerifyConfig } from "../../src/verify-adapters/index.js";
import { runVerify } from "../../src/verify.js";

interface Args {
  candidatesDir: string;
  out: string;
  report: string;
  repo: string;
  testbed: string;
  base: string;
  runRegression: boolean;
  python: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string => {
    const i = argv.indexOf(flag);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required arg ${flag}`);
  };
  return {
    candidatesDir: get("--candidates-dir"),
    out: get("--out"),
    report: get("--report"),
    repo: get("--repo", ""),
    testbed: get("--testbed", "/testbed"),
    base: get("--base", "HEAD"),
    runRegression: argv.includes("--run-regression"),
    python: get("--python", "python"),
    timeoutMs: Number.parseInt(get("--timeout-ms", "300000"), 10),
  };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function resetTestbed(testbed: string, base: string): void {
  git(testbed, ["reset", "--hard", base]);
  git(testbed, ["clean", "-fdq"]);
}

/** Read candidate_<n>.patch files, sorted by n. Returns {index, diff, rawPath}. */
function readCandidates(dir: string): Array<{ index: number; diff: string; rawPath: string }> {
  const out: Array<{ index: number; diff: string; rawPath: string }> = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(/^candidate_(\d+)\.patch$/);
    if (!m) continue;
    const rawPath = path.join(dir, name);
    out.push({ index: Number.parseInt(m[1], 10), diff: readFileSync(rawPath, "utf8"), rawPath });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * Apply a candidate to the (clean) testbed and run the inferred related tests.
 * Returns "pass"/"fail"/"unknown". Always resets the testbed afterwards.
 */
async function measureRegression(
  args: Args,
  diff: string,
  rawPath: string,
): Promise<RegressionStatus> {
  resetTestbed(args.testbed, args.base);

  // Empty patch → nothing to apply, nothing to regress.
  if (diff.trim().length === 0) return "unknown";

  try {
    execFileSync("git", ["apply", "--whitespace=nowarn", rawPath], {
      cwd: args.testbed,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // Candidate doesn't apply cleanly to base — can't measure; treat as unknown
    // (selection still keeps it as a last resort over empty patches).
    resetTestbed(args.testbed, args.base);
    return "unknown";
  }

  const verify = buildChangedFilesVerifyConfig({
    enabled: true,
    workspaceRoot: args.testbed,
    repo: args.repo,
    pythonBin: args.python,
    timeoutMs: args.timeoutMs,
  });

  let status: RegressionStatus = "unknown";
  if (verify) {
    const result = await runVerify(verify);
    if (result === "skipped") status = "unknown";
    else status = result.verdict === "pass" ? "pass" : "fail";
  }

  resetTestbed(args.testbed, args.base);
  return status;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = readCandidates(args.candidatesDir);

  if (raw.length === 0) {
    // Nothing to select; emit an empty patch so the prediction is well-formed.
    writeFileSync(args.out, "");
    writeFileSync(
      args.report,
      JSON.stringify({ error: "no candidate_*.patch files found", candidatesDir: args.candidatesDir }, null, 2),
    );
    process.stderr.write(`select-patch: no candidates in ${args.candidatesDir}\n`);
    return;
  }

  const candidates: PatchCandidate[] = [];
  for (const c of raw) {
    let regression: RegressionStatus = "unknown";
    if (args.runRegression) {
      regression = await measureRegression(args, c.diff, c.rawPath);
      process.stderr.write(`select-patch: candidate #${c.index} regression=${regression}\n`);
    }
    candidates.push({ index: c.index, diff: c.diff, regression });
  }

  const result: SelectionResult = selectPatch(candidates);

  // Write the chosen patch by copying the original file bytes (preserves the
  // trailing newline that `git apply` requires — re-serializing would strip it).
  const chosen = raw.find((c) => c.index === result.selectedIndex);
  if (result.allEmpty || !chosen) {
    writeFileSync(args.out, "");
  } else {
    writeFileSync(args.out, readFileSync(chosen.rawPath));
  }

  writeFileSync(
    args.report,
    JSON.stringify(
      {
        n: raw.length,
        selectedIndex: result.selectedIndex,
        selectedTier: result.selectedTier,
        allEmpty: result.allEmpty,
        reason: result.reason,
        runRegression: args.runRegression,
        annotations: result.annotations,
        clusters: result.clusters.map((c) => ({ size: c.members.length, members: c.members, representative: c.representative })),
      },
      null,
      2,
    ),
  );

  process.stderr.write(`select-patch: ${result.reason}\n`);
  if (existsSync(args.out)) {
    const bytes = readFileSync(args.out).length;
    process.stderr.write(`select-patch: wrote ${bytes} bytes → ${args.out}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`select-patch: FATAL ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
