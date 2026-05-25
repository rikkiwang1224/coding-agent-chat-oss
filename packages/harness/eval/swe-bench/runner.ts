import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@forgelet/shared-types";
import { HarnessEngine } from "../../src/harness-engine.js";
import type { LlmConfig } from "../../src/types.js";
import { buildSweBenchPrompt } from "./prompt.js";
import { extractModelPatch } from "./patch.js";
import { createInstanceWorkspace, ensureRepoCache, removeWorktree } from "./workspace.js";
import type {
  SweBenchInstance,
  SweBenchPrediction,
  SweBenchRunOptions,
  SweBenchRunReport,
  SweBenchInstanceResult,
} from "./types.js";

export async function loadInstancesFromJson(filePath: string): Promise<SweBenchInstance[]> {
  const raw = (await readFile(filePath, "utf8")).trim();
  if (raw.startsWith("[")) {
    return JSON.parse(raw) as SweBenchInstance[];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SweBenchInstance);
}

export async function runSweBench(options: SweBenchRunOptions): Promise<SweBenchRunReport> {
  const startTime = Date.now();
  await mkdir(options.outputDir, { recursive: true });

  const predictionsPath = path.join(options.outputDir, "predictions.jsonl");
  await writeFile(predictionsPath, "");

  const worktreesDir = path.join(options.outputDir, "worktrees");
  const results: SweBenchInstanceResult[] = [];

  console.log(`\nRunning ${options.instances.length} SWE-bench instance(s)`);
  console.log(`  Model:      ${options.modelName}`);
  console.log(`  Output:     ${predictionsPath}`);
  console.log(`  Max turns:  ${options.maxTurns}`);
  console.log(`  Timeout:    ${options.timeoutS}s per instance\n`);

  for (const instance of options.instances) {
    const result = await runSingleInstance(instance, options, worktreesDir, predictionsPath);
    results.push(result);
    const status = result.success ? "OK" : "FAIL";
    console.log(
      `  [${status}] ${instance.instance_id} (${result.durationMs}ms, ${result.turnCount} turns, patch ${result.patchLength} chars)`,
    );
    if (result.error) {
      console.log(`         ${result.error}`);
    }
  }

  const completed = results.filter((r) => r.success).length;

  return {
    model: options.modelName,
    timestamp: new Date().toISOString(),
    totalInstances: results.length,
    completed,
    failed: results.length - completed,
    predictionsPath,
    totalDurationMs: Date.now() - startTime,
    results,
  };
}

async function writeInstanceTrace(
  outputDir: string,
  payload: {
    instance_id: string;
    durationMs: number;
    turnCount: number;
    patchLength: number;
    error?: string;
    events: AgentEvent[];
  },
): Promise<string> {
  const tracesDir = path.join(outputDir, "traces");
  await mkdir(tracesDir, { recursive: true });
  const tracePath = path.join(tracesDir, `${payload.instance_id}.json`);
  await writeFile(tracePath, JSON.stringify(payload, null, 2));
  return tracePath;
}

async function runSingleInstance(
  instance: SweBenchInstance,
  options: SweBenchRunOptions,
  worktreesDir: string,
  predictionsPath: string,
): Promise<SweBenchInstanceResult> {
  const startTime = Date.now();
  let turnCount = 0;
  const events: AgentEvent[] = [];
  let workspaceDir: string | undefined;
  const cachePath = path.join(options.reposCacheDir, instance.repo.replace("/", "__"));

  try {
    workspaceDir = await createInstanceWorkspace(
      instance,
      options.reposCacheDir,
      worktreesDir,
    );

    const engine = new HarnessEngine({
      workspaceRoot: workspaceDir,
      config: options.config,
      maxTurns: options.maxTurns,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutS * 1000);

    try {
      await engine.runTask(
        {
          sessionId: `swe-${instance.instance_id}`,
          prompt: buildSweBenchPrompt(instance),
          signal: controller.signal,
        },
        (event) => {
          if (options.saveTraces !== false) events.push(event);
          if (event.type === "tool.called") turnCount++;
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("abort") && !message.includes("cancel")) {
        // Still extract patch after non-fatal errors
      }
    } finally {
      clearTimeout(timeout);
    }

    const modelPatch = await extractModelPatch(workspaceDir);
    const prediction: SweBenchPrediction = {
      instance_id: instance.instance_id,
      model_name_or_path: options.modelName,
      model_patch: modelPatch,
    };

    await appendFile(predictionsPath, `${JSON.stringify(prediction)}\n`);

    if (options.saveTraces !== false) {
      await writeInstanceTrace(options.outputDir, {
        instance_id: instance.instance_id,
        durationMs: Date.now() - startTime,
        turnCount,
        patchLength: modelPatch.length,
        events,
      });
    }

    return {
      instance_id: instance.instance_id,
      success: modelPatch.length > 0,
      durationMs: Date.now() - startTime,
      turnCount,
      patchLength: modelPatch.length,
      error: modelPatch.length === 0 ? "Empty patch (no git diff)" : undefined,
      workspaceDir,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const emptyPrediction: SweBenchPrediction = {
      instance_id: instance.instance_id,
      model_name_or_path: options.modelName,
      model_patch: "",
    };
    await appendFile(predictionsPath, `${JSON.stringify(emptyPrediction)}\n`);

    if (options.saveTraces !== false) {
      await writeInstanceTrace(options.outputDir, {
        instance_id: instance.instance_id,
        durationMs: Date.now() - startTime,
        turnCount,
        patchLength: 0,
        error: message,
        events,
      });
    }

    return {
      instance_id: instance.instance_id,
      success: false,
      durationMs: Date.now() - startTime,
      turnCount,
      patchLength: 0,
      error: message,
      workspaceDir,
    };
  } finally {
    if (workspaceDir) {
      try {
        await ensureRepoCache(instance, options.reposCacheDir);
        await removeWorktree(cachePath, workspaceDir);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

export async function writeRunReport(
  outputDir: string,
  report: SweBenchRunReport,
): Promise<string> {
  const reportPath = path.join(outputDir, "run-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

/** Append predictions for resume runs (skip instance_ids already in file). */
export async function filterPendingInstances(
  instances: SweBenchInstance[],
  predictionsPath: string,
): Promise<SweBenchInstance[]> {
  try {
    const raw = await readFile(predictionsPath, "utf8");
    const done = new Set<string>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as SweBenchPrediction;
      if (row.instance_id) done.add(row.instance_id);
    }
    return instances.filter((i) => !done.has(i.instance_id));
  } catch {
    return instances;
  }
}

export type { LlmConfig };
