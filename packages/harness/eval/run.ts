#!/usr/bin/env node
/**
 * Eval CLI — Run integration tests against a real LLM.
 *
 * Usage:
 *   npx tsx eval/run.ts                          # uses DEEPSEEK_API_KEY env
 *   npx tsx eval/run.ts --model deepseek-v4-pro  # specify model
 *   npx tsx eval/run.ts --task 01                # run single task by prefix
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { resolveEvalTraceDir } from "@forgelet/storage-core";
import { loadEvalEnv } from "./load-env.js";
import { runEval } from "./runner.js";
import type { LlmConfig } from "../src/types.js";

loadEvalEnv();

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
const taskFilter = getArg("task");
const evalRunId = getArg("run-id") || String(Date.now());
const saveTraces = !hasFlag("no-trace");

if (!apiKey) {
  console.error("Error: Set DEEPSEEK_API_KEY env var or pass --api-key <key>");
  process.exit(1);
}

const config: LlmConfig = { apiKey, model, baseUrl };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = path.resolve(__dirname, "tasks");

process.env.FORGELET_EVAL_RUN_ID = evalRunId;
if (saveTraces) {
  process.env.FORGELET_EVAL_TRACE = "1";
}

const traceDir = resolveEvalTraceDir(evalRunId);

console.log(`\n🧪 Running eval suite`);
console.log(`   Model:   ${model}`);
console.log(`   Run ID:  ${evalRunId}`);
console.log(`   Tasks:   ${tasksDir}`);
console.log(`   Filter:  ${taskFilter || "(all)"}`);
if (saveTraces) {
  console.log(`   Traces:  ${traceDir}/instances/<taskId>.jsonl`);
} else {
  console.log(`   Traces:  (disabled, use default or omit --no-trace)`);
}
console.log();

const report = await runEval(config, tasksDir);

console.log(`\n── Results ──`);
console.log(`   Pass rate: ${report.passRate} (${report.passed}/${report.totalTasks})`);
console.log(`   Duration:  ${(report.totalDurationMs / 1000).toFixed(1)}s`);
console.log(`   Model:     ${report.model}`);
console.log(`   Run ID:    ${evalRunId}`);
if (saveTraces) {
  console.log(`   Traces:    ${traceDir}/instances/`);
}
console.log();

// Save report
const reportPath = path.resolve(__dirname, "reports", `${Date.now()}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {
  // reports dir might not exist, that's fine
});
