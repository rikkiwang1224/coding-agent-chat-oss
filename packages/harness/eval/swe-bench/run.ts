#!/usr/bin/env node
/**
 * SWE-bench eval — run agent on real repos, then evaluate with official Docker harness.
 *
 * Phase 1 — agent (this script):
 *   pnpm --filter @forgelet/harness eval:swe -- --dataset lite --limit 3
 *
 * Phase 2 — official harness (Docker required):
 *   pnpm --filter @forgelet/harness eval:swe:verify -- runs/eval-<id>/predictions.jsonl
 *
 * Prerequisites:
 *   - DEEPSEEK_API_KEY (or --api-key) for agent runs
 *   - Python venv with swebench (see eval/swe-bench/README.md) for verification
 *   - Docker for verification
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import {
  filterPendingInstances,
  loadInstancesFromJson,
  runSweBench,
  writeRunReport,
} from "./runner.js";
import type { LlmConfig } from "../../src/types.js";
import type { SweBenchDatasetId } from "./types.js";
import { DATASET_EVAL_NAMES } from "./types.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const apiKey = getArg("api-key") || process.env.DEEPSEEK_API_KEY || "";
const model = getArg("model") || "deepseek-v4-pro";
const baseUrl = getArg("base-url") || "https://api.deepseek.com";
const dataset = (getArg("dataset") || "lite") as SweBenchDatasetId;
const limit = getArg("limit") ? Number(getArg("limit")) : undefined;
const instanceIds = getArg("instance-ids")?.split(",").filter(Boolean);
const instancesPath = getArg("instances");
const maxTurns = Number(getArg("max-turns") || "75");
const timeoutS = Number(getArg("timeout-s") || "1800");
const runId = getArg("run-id") || String(Date.now());
const evaluateOnly = hasFlag("evaluate-only");
const skipEval = hasFlag("skip-eval");
const resume = hasFlag("resume");
/** Traces default on for benchmark debugging; opt out with --no-save-traces. */
const saveTraces = !hasFlag("no-save-traces");

const sweDir = __dirname;
const reposCacheDir = path.resolve(getArg("repos-cache") || path.join(sweDir, "repos"));
const runsDir = path.resolve(getArg("runs-dir") || path.join(sweDir, "runs"));
const outputDir = path.resolve(getArg("output") || path.join(runsDir, `eval-${runId}`));
const predictionsPath = path.join(outputDir, "predictions.jsonl");

async function resolvePython(): Promise<string> {
  if (process.env.SWEBENCH_PYTHON) return process.env.SWEBENCH_PYTHON;

  const candidates = [
    path.join(sweDir, ".venv", "bin", "python"),
    path.join(sweDir, ".venv-mac", "bin", "python"),
    "python3",
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }

  throw new Error(
    "Python not found. Create a venv: cd packages/harness/eval/swe-bench && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
  );
}

async function fetchInstances(): Promise<string> {
  const outPath = path.join(outputDir, "instances.json");
  await mkdir(outputDir, { recursive: true });

  const py = path.join(sweDir, "fetch_instances.py");
  const pythonCmd = await resolvePython();

  const pyArgs = [
    py,
    "--dataset",
    dataset,
    "--output",
    outPath,
    "--split",
    "test",
  ];
  if (limit !== undefined) pyArgs.push("--limit", String(limit));
  if (instanceIds?.length) pyArgs.push("--instance-ids", ...instanceIds);

  console.log(`Fetching instances (${dataset})…`);
  await execFileAsync(pythonCmd, pyArgs, { cwd: sweDir, timeout: 600_000 });
  return outPath;
}

async function runEvaluation(predPath: string = predictionsPath): Promise<void> {
  const evalScript = path.join(sweDir, "evaluate.sh");
  const maxWorkers = getArg("max-workers") || "4";
  const datasetEval = DATASET_EVAL_NAMES[dataset] || DATASET_EVAL_NAMES.lite;
  const namespace =
    getArg("namespace") ??
    (process.platform === "darwin" && process.arch === "arm64" ? "" : undefined);

  const shArgs = [evalScript, predPath, datasetEval, runId, maxWorkers];
  if (namespace !== undefined) shArgs.push(namespace);

  console.log(`\nRunning official SWE-bench harness (Docker)…`);
  await execFileAsync("bash", shArgs, {
    cwd: sweDir,
    timeout: 0,
    env: { ...process.env, SWEBENCH_PYTHON: process.env.SWEBENCH_PYTHON || path.join(sweDir, ".venv", "bin", "python") },
  });
}

async function main(): Promise<void> {
  if (evaluateOnly) {
    const pred = path.resolve(getArg("predictions") || predictionsPath);
    await runEvaluation(pred);
    return;
  }

  if (!apiKey) {
    console.error("Error: Set DEEPSEEK_API_KEY or pass --api-key");
    process.exit(1);
  }

  await mkdir(outputDir, { recursive: true });

  let instancesFile = instancesPath;
  if (!instancesFile) {
    instancesFile = await fetchInstances();
  }

  let instances = await loadInstancesFromJson(instancesFile);
  if (resume) {
    instances = await filterPendingInstances(instances, predictionsPath);
    console.log(`Resume: ${instances.length} instance(s) remaining`);
  }

  if (instances.length === 0) {
    console.log("No instances to run.");
    if (!skipEval) await runEvaluation();
    return;
  }

  const config: LlmConfig = { apiKey, model, baseUrl };

  console.log(`\nSWE-bench agent run`);
  console.log(`  Model:    ${model}`);
  console.log(`  Dataset:  ${dataset}`);
  console.log(`  Output:   ${outputDir}\n`);

  const report = await runSweBench({
    config,
    instances,
    reposCacheDir,
    outputDir,
    modelName: model,
    maxTurns,
    timeoutS,
    concurrency: 1,
    saveTraces,
  });

  report.dataset = dataset;
  const reportPath = await writeRunReport(outputDir, report);
  console.log(`\n── Agent run complete ──`);
  console.log(`  Patches:  ${report.completed}/${report.totalInstances} non-empty`);
  console.log(`  Duration: ${(report.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`  Report:   ${reportPath}`);
  console.log(`  Predictions: ${predictionsPath}`);
  if (saveTraces) {
    console.log(`  Traces:   ${path.join(outputDir, "traces")}/<instance_id>.json`);
  }
  console.log();

  if (!skipEval) {
    await runEvaluation();
  } else {
    console.log(`Skipped harness. Run verification:`);
    console.log(`  pnpm --filter @forgelet/harness eval:swe:verify -- ${predictionsPath}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
