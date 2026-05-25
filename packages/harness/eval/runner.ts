import { readFile, readdir, cp, rm, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarnessEngine } from "../src/harness-engine.js";
import type { LlmConfig } from "../src/types.js";
import type { AgentEvent } from "@forgelet/shared-types";
import { formatCostUsd, summarizeEvalUsage, summarizeTaskUsage, type EvalUsageSummary } from "./usage-summary.js";

const execFileAsync = promisify(execFile);

export interface EvalTask {
  id: string;
  name: string;
  prompt: string;
  timeout_s: number;
  judge: "script" | "contains" | "file_exists" | "typecheck";
  judge_args?: Record<string, unknown>;
}

export interface EvalResult {
  taskId: string;
  passed: boolean;
  durationMs: number;
  turnCount: number;
  error?: string;
  usage?: EvalUsageSummary;
  events: AgentEvent[];
}

export interface EvalReport {
  model: string;
  provider?: string;
  timestamp: string;
  totalTasks: number;
  passed: number;
  failed: number;
  passRate: string;
  totalDurationMs: number;
  usage: EvalUsageSummary;
  results: EvalResult[];
}

const JUDGE_TIMEOUT_MS = 60_000;

async function warmupJudgeDeps(): Promise<void> {
  try {
    await execFileAsync("npx", ["--yes", "tsx", "--version"], { timeout: JUDGE_TIMEOUT_MS });
  } catch {
    // Best-effort: eval judges still run if warmup fails.
  }
}

export async function runEval(config: LlmConfig, tasksDir: string): Promise<EvalReport> {
  const startTime = Date.now();
  await warmupJudgeDeps();

  const taskDirs = await readdir(tasksDir, { withFileTypes: true });
  const tasks = taskDirs
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const results: EvalResult[] = [];

  for (const taskDir of tasks) {
    const taskPath = path.join(tasksDir, taskDir.name);
    const result = await runSingleTask(config, taskPath);
    results.push(result);
    const status = result.passed ? "PASS" : "FAIL";
    const runId = process.env.FORGELET_EVAL_RUN_ID;
    const runSuffix = runId ? `, run ${runId}` : "";
    console.log(
      `  [${status}] ${result.taskId} (${result.durationMs}ms, ${result.turnCount} turns${runSuffix})`,
    );
    if (result.error) {
      console.log(`         ${result.error}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const totalDurationMs = Date.now() - startTime;
  const usage = summarizeEvalUsage(results, {
    provider: config.provider ?? "deepseek",
    model: config.model,
  });

  return {
    model: config.model || "unknown",
    provider: config.provider,
    timestamp: new Date().toISOString(),
    totalTasks: results.length,
    passed,
    failed: results.length - passed,
    passRate: `${((passed / results.length) * 100).toFixed(1)}%`,
    totalDurationMs,
    usage,
    results,
  };
}

export { formatCostUsd };

async function runSingleTask(config: LlmConfig, taskPath: string): Promise<EvalResult> {
  const taskJson = await readFile(path.join(taskPath, "task.json"), "utf8");
  const task: EvalTask = JSON.parse(taskJson);
  const startTime = Date.now();
  const events: AgentEvent[] = [];

  // Create isolated workspace from task's workspace/ directory
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), `eval-${task.id}-`));
  const workspaceSource = path.join(taskPath, "workspace");

  try {
    // Copy workspace template if it exists
    try {
      await cp(workspaceSource, workspaceDir, { recursive: true });
    } catch {
      // No workspace template — start empty
    }

    const evalRunId = process.env.FORGELET_EVAL_RUN_ID || "local";

    // Run the agent
    const traceEnabled = process.env.FORGELET_EVAL_TRACE === "1";

    const engine = new HarnessEngine({
      workspaceRoot: workspaceDir,
      config,
      maxTurns: 20,
      persistSession: false,
      trace: traceEnabled
        ? {
            enabled: true,
            runKind: "eval",
            runId: evalRunId,
            instanceId: task.id,
            workspaceRoot: workspaceDir,
          }
        : undefined,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeout_s * 1000);

    let turnCount = 0;

    try {
      await engine.runTask(
        { sessionId: `eval-${task.id}`, prompt: task.prompt, signal: controller.signal },
        (event) => {
          events.push(event);
          if (event.type === "tool.called") turnCount++;
        },
      );
    } catch {
      // Agent may have timed out or errored — still judge the workspace
    } finally {
      clearTimeout(timeout);
    }

    // Judge the result regardless of whether the agent completed or timed out
    const durationMs = Date.now() - startTime;
    const { passed, error: judgeError } = await judgeTask(task, taskPath, workspaceDir);

    const usage = summarizeTaskUsage(events);

    return { taskId: task.id, passed, durationMs, turnCount, error: judgeError, usage, events };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function judgeTask(
  task: EvalTask,
  taskPath: string,
  workspaceDir: string,
): Promise<{ passed: boolean; error?: string }> {
  switch (task.judge) {
    case "script": {
      const scriptPath = path.join(taskPath, "judge.sh");
      try {
        await execFileAsync("bash", [scriptPath, workspaceDir], {
          timeout: JUDGE_TIMEOUT_MS,
          env: { ...process.env, WORKSPACE: workspaceDir },
        });
        return { passed: true };
      } catch (err) {
        const message = formatExecError(err);
        return { passed: false, error: `judge failed: ${message}` };
      }
    }

    case "contains": {
      const file = String(task.judge_args?.file || "");
      const expected = String(task.judge_args?.expected || "");
      try {
        const content = await readFile(path.join(workspaceDir, file), "utf8");
        return { passed: content.includes(expected) };
      } catch (err) {
        return { passed: false, error: formatExecError(err) };
      }
    }

    case "file_exists": {
      const files = (task.judge_args?.files as string[]) || [];
      for (const f of files) {
        try {
          await readFile(path.join(workspaceDir, f));
        } catch (err) {
          return { passed: false, error: `missing file: ${f} (${formatExecError(err)})` };
        }
      }
      return { passed: files.length > 0 };
    }

    case "typecheck": {
      try {
        await execFileAsync("npx", ["tsc", "--noEmit"], {
          cwd: workspaceDir,
          timeout: JUDGE_TIMEOUT_MS,
        });
        return { passed: true };
      } catch (err) {
        return { passed: false, error: formatExecError(err) };
      }
    }

    default:
      return { passed: false, error: `unknown judge type: ${task.judge}` };
  }
}

function formatExecError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const execErr = err as { message?: string; stderr?: string; stdout?: string; killed?: boolean };
  const parts = [execErr.message?.trim()].filter(Boolean);
  const stderr = execErr.stderr?.trim();
  const stdout = execErr.stdout?.trim();
  if (stderr) parts.push(stderr);
  else if (stdout) parts.push(stdout);
  if (execErr.killed) parts.push("(timed out)");
  return parts.join(" — ") || "unknown error";
}
