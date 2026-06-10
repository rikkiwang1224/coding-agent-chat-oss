#!/usr/bin/env node
/**
 * Run official SWE-bench Docker harness on existing predictions.
 *
 *   pnpm --filter @lattice-code/harness eval:swe:verify -- runs/eval-123/predictions.jsonl
 *   pnpm --filter @lattice-code/harness eval:swe:verify -- predictions.jsonl --dataset lite --run-id my-run
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATASET_EVAL_NAMES, type SweBenchDatasetId } from "./types.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const predictionsPath = positional[0] ? path.resolve(positional[0]) : "";
const dataset = (getArg("dataset") || "lite") as SweBenchDatasetId;
const runId = getArg("run-id") || path.basename(path.dirname(predictionsPath)) || `verify-${Date.now()}`;
const maxWorkers = getArg("max-workers") || "4";
const namespace =
  getArg("namespace") ?? (process.platform === "darwin" && process.arch === "arm64" ? "" : undefined);

if (!predictionsPath) {
  console.error("Usage: eval:swe:verify -- <predictions.jsonl> [--dataset lite] [--run-id id]");
  process.exit(1);
}

const datasetEval = DATASET_EVAL_NAMES[dataset];
const evalScript = path.join(__dirname, "evaluate.sh");
const shArgs = [evalScript, predictionsPath, datasetEval, runId, maxWorkers];
if (namespace !== undefined) shArgs.push(namespace);

console.log(`Verifying ${predictionsPath} on ${datasetEval}\n`);

execFileAsync("bash", shArgs, {
  cwd: __dirname,
  env: process.env,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
