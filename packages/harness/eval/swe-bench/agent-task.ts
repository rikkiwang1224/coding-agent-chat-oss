import { HarnessEngine } from "../../src/harness-engine.js";
import { SessionStore } from "../../src/session-store.js";
import type { ReasonHookConfig } from "../../src/agent-loop.js";
import type { LlmConfig } from "../../src/types.js";
import type { AgentEvent } from "@lattice-code/shared-types";
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
  /**
   * Set when the run aborted on an LLM API error (e.g. 402 Insufficient
   * Balance, 401/403 auth). Lets the batch driver fast-abort instead of
   * burning every remaining instance against an exhausted account.
   */
  apiErrorStatus?: number;
  apiErrorMessage?: string;
}

/**
 * Status codes that mean every subsequent instance in a batch will also fail
 * (billing exhausted or bad credentials), so the batch should stop rather than
 * grind through the rest producing empty patches.
 */
export function isBatchFatalApiStatus(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403;
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
    selfReviewGate: selfReviewGateEnabled(),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  const emit = options.emit ?? (() => {});
  let apiErrorStatus: number | undefined;
  let apiErrorMessage: string | undefined;

  try {
    await engine.runTask(
      {
        sessionId: `swe-${options.instance.instance_id}`,
        prompt: buildSweBenchPrompt(options.instance),
        signal: controller.signal,
      },
      (event) => {
        if (event.type === "tool.called") turnCount++;
        if (event.type === "agent.error") {
          const msg = String((event.payload as { error?: string })?.error ?? "");
          const match = msg.match(/LLM API error (\d+)/);
          if (match) {
            apiErrorStatus = Number(match[1]);
            apiErrorMessage = msg;
          }
        }
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
    const { resolveSweBenchTraceInstancePath } = await import("@lattice-code/storage-core");
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
    apiErrorStatus,
    apiErrorMessage,
  };
}

/**
 * Hard self-review gate toggle. On by default for SWE-bench; disable with
 * LATTICE_CODE_SELF_REVIEW_GATE in {0,off,false,no}.
 */
function selfReviewGateEnabled(): boolean {
  const raw = (process.env.LATTICE_CODE_SELF_REVIEW_GATE || "").trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
  return true;
}

function buildReasonHook(
  instance: SweBenchInstance,
  workspaceDir: string,
): ReasonHookConfig | undefined {
  const raw = (process.env.LATTICE_CODE_REASON || "").trim().toLowerCase();
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
