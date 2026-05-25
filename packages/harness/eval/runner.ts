import { readFile, readdir, cp, rm, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarnessEngine } from "../src/harness-engine.js";
import type { LlmConfig } from "../src/types.js";
import type { AgentEvent } from "@forgelet/shared-types";

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
  events: AgentEvent[];
}

export interface EvalReport {
  model: string;
  timestamp: string;
  totalTasks: number;
  passed: number;
  failed: number;
  passRate: string;
  totalDurationMs: number;
  results: EvalResult[];
}

export async function runEval(config: LlmConfig, tasksDir: string): Promise<EvalReport> {
  const startTime = Date.now();
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
    console.log(`  [${status}] ${result.taskId} (${result.durationMs}ms, ${result.turnCount} turns)`);
    if (result.error) {
      console.log(`         ${result.error}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const totalDurationMs = Date.now() - startTime;

  return {
    model: config.model || "unknown",
    timestamp: new Date().toISOString(),
    totalTasks: results.length,
    passed,
    failed: results.length - passed,
    passRate: `${((passed / results.length) * 100).toFixed(1)}%`,
    totalDurationMs,
    results,
  };
}

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
    const engine = new HarnessEngine({
      workspaceRoot: workspaceDir,
      config,
      maxTurns: 20,
      trace: {
        enabled: true,
        runKind: "eval",
        runId: evalRunId,
        instanceId: task.id,
        workspaceRoot: workspaceDir,
      },
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
    const passed = await judgeTask(task, taskPath, workspaceDir);

    return { taskId: task.id, passed, durationMs, turnCount, events };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function judgeTask(task: EvalTask, taskPath: string, workspaceDir: string): Promise<boolean> {
  switch (task.judge) {
    case "script": {
      const scriptPath = path.join(taskPath, "judge.sh");
      try {
        await execFileAsync("bash", [scriptPath, workspaceDir], {
          timeout: 30_000,
          env: { ...process.env, WORKSPACE: workspaceDir },
        });
        return true;
      } catch {
        return false;
      }
    }

    case "contains": {
      const file = String(task.judge_args?.file || "");
      const expected = String(task.judge_args?.expected || "");
      try {
        const content = await readFile(path.join(workspaceDir, file), "utf8");
        return content.includes(expected);
      } catch {
        return false;
      }
    }

    case "file_exists": {
      const files = (task.judge_args?.files as string[]) || [];
      for (const f of files) {
        try {
          await readFile(path.join(workspaceDir, f));
        } catch {
          return false;
        }
      }
      return files.length > 0;
    }

    case "typecheck": {
      try {
        await execFileAsync("npx", ["tsc", "--noEmit"], {
          cwd: workspaceDir,
          timeout: 30_000,
        });
        return true;
      } catch {
        return false;
      }
    }

    default:
      return false;
  }
}
