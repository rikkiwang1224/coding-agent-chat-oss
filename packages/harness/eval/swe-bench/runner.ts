import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessEngine } from "../../src/harness-engine.js";
import { SessionStore } from "../../src/session-store.js";
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
  console.log(`  Run ID:     ${options.traceRunId}`);
  console.log(`  Output:     ${predictionsPath}`);
  console.log(`  Max turns:  ${options.maxTurns}`);
  console.log(`  Timeout:    ${options.timeoutS}s per instance\n`);

  for (const instance of options.instances) {
    const result = await runSingleInstance(instance, options, worktreesDir, predictionsPath);
    results.push(result);
    const status = result.success ? "OK" : "FAIL";
    const runSuffix = options.traceRunId ? `, run ${options.traceRunId}` : "";
    console.log(
      `  [${status}] ${instance.instance_id} (${result.durationMs}ms, ${result.turnCount} turns, patch ${result.patchLength} chars${runSuffix})`,
    );
    if (result.error) {
      console.log(`         ${result.error}`);
    }
    if (result.tracePath) {
      console.log(`         trace: ${result.tracePath}`);
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

async function runSingleInstance(
  instance: SweBenchInstance,
  options: SweBenchRunOptions,
  worktreesDir: string,
  predictionsPath: string,
): Promise<SweBenchInstanceResult> {
  const startTime = Date.now();
  let turnCount = 0;
  let tracePath: string | undefined;
  let workspaceDir: string | undefined;
  const cachePath = path.join(options.reposCacheDir, instance.repo.replace("/", "__"));
  const sessionId = `swe-${instance.instance_id}`;

  try {
    workspaceDir = await createInstanceWorkspace(
      instance,
      options.reposCacheDir,
      worktreesDir,
    );

    const traceEnabled = options.saveTraces !== false;
    const engine = new HarnessEngine({
      workspaceRoot: workspaceDir,
      config: options.config,
      maxTurns: options.maxTurns,
      sessionStore: SessionStore.forWorkspace(workspaceDir),
      trace: traceEnabled
        ? {
            enabled: true,
            runKind: "swe-bench",
            runId: options.traceRunId,
            instanceId: instance.instance_id,
            workspaceRoot: workspaceDir,
          }
        : undefined,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutS * 1000);

    try {
      await engine.runTask(
        {
          sessionId,
          prompt: buildSweBenchPrompt(instance),
          signal: controller.signal,
        },
        (event) => {
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

    if (traceEnabled) {
      const { resolveSweBenchTraceInstancePath } = await import("@forgelet/storage-core");
      tracePath = resolveSweBenchTraceInstancePath(options.traceRunId, instance.instance_id);
    }

    const modelPatch = await extractModelPatch(workspaceDir);
    const prediction: SweBenchPrediction = {
      instance_id: instance.instance_id,
      model_name_or_path: options.modelName,
      model_patch: modelPatch,
    };

    await appendFile(predictionsPath, `${JSON.stringify(prediction)}\n`);

    return {
      instance_id: instance.instance_id,
      success: modelPatch.length > 0,
      durationMs: Date.now() - startTime,
      turnCount,
      patchLength: modelPatch.length,
      error: modelPatch.length === 0 ? "Empty patch (no git diff)" : undefined,
      workspaceDir,
      tracePath,
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
      const { resolveSweBenchTraceInstancePath } = await import("@forgelet/storage-core");
      tracePath = resolveSweBenchTraceInstancePath(options.traceRunId, instance.instance_id);
    }

    return {
      instance_id: instance.instance_id,
      success: false,
      durationMs: Date.now() - startTime,
      turnCount,
      patchLength: 0,
      error: message,
      workspaceDir,
      tracePath,
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
