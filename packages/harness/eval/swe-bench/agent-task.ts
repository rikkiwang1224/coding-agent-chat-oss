import { HarnessEngine } from "../../src/harness-engine.js";
import { SessionStore } from "../../src/session-store.js";
import type { ReasonHookConfig } from "../../src/agent-loop.js";
import type { LlmConfig } from "../../src/types.js";
import type { AgentEvent } from "@forgelet/shared-types";
import { buildSweBenchPrompt } from "./prompt.js";
import { extractModelPatch } from "./patch.js";
import { sweBenchProtectedPathPatterns } from "./protected-paths.js";
import type { SweBenchInstance } from "./types.js";

export interface RunSweBenchAgentOptions {
  workspaceRoot: string;
  instance: SweBenchInstance;
  config: LlmConfig;
  maxTurns: number;
  timeoutMs: number;
  traceRunId?: string;
  saveTraces?: boolean;
  emit?: (event: AgentEvent) => void;
}

export interface RunSweBenchAgentResult {
  modelPatch: string;
  turnCount: number;
  durationMs: number;
  tracePath?: string;
}

export async function runSweBenchAgent(
  options: RunSweBenchAgentOptions,
): Promise<RunSweBenchAgentResult> {
  const startTime = Date.now();
  let turnCount = 0;
  let tracePath: string | undefined;

  const traceEnabled = options.saveTraces !== false && Boolean(options.traceRunId);
  const reasonHook = buildReasonHook(options.instance, options.workspaceRoot);
  const engine = new HarnessEngine({
    workspaceRoot: options.workspaceRoot,
    config: options.config,
    maxTurns: options.maxTurns,
    sessionStore: SessionStore.forWorkspace(options.workspaceRoot),
    trace: traceEnabled
      ? {
          enabled: true,
          runKind: "swe-bench",
          runId: options.traceRunId!,
          instanceId: options.instance.instance_id,
          workspaceRoot: options.workspaceRoot,
        }
      : undefined,
    reason: reasonHook,
    protectedPathPatterns: sweBenchProtectedPathPatterns(),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  const emit = options.emit ?? (() => {});

  try {
    await engine.runTask(
      {
        sessionId: `swe-${options.instance.instance_id}`,
        prompt: buildSweBenchPrompt(options.instance),
        signal: controller.signal,
      },
      (event) => {
        if (event.type === "tool.called") turnCount++;
        emit(event);
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

  if (traceEnabled && options.traceRunId) {
    const { resolveSweBenchTraceInstancePath } = await import("@forgelet/storage-core");
    tracePath = resolveSweBenchTraceInstancePath(
      options.traceRunId,
      options.instance.instance_id,
    );
  }

  const modelPatch = await extractModelPatch(options.workspaceRoot);

  return {
    modelPatch,
    turnCount,
    durationMs: Date.now() - startTime,
    tracePath,
  };
}

function buildReasonHook(
  instance: SweBenchInstance,
  workspaceDir: string,
): ReasonHookConfig | undefined {
  const raw = (process.env.FORGELET_REASON || "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off" || raw === "false") return undefined;

  let maxRounds = 2;
  if (raw !== "1" && raw !== "on" && raw !== "true") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 5) maxRounds = n;
  }

  const issueText = instance.hints_text?.trim()
    ? `${instance.problem_statement.trim()}\n\n## Hints from issue discussion\n${instance.hints_text.trim()}`
    : instance.problem_statement.trim();

  return {
    enabled: true,
    issueText,
    maxRounds,
    getCurrentDiff: () => extractModelPatch(workspaceDir),
  };
}
