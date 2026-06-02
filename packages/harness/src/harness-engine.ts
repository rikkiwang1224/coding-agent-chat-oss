import type { AgentEngine, RunTaskInput, EventSink } from "@forgelet/sdk-core";
import type { AgentEvent, AgentRunMetrics } from "@forgelet/shared-types";
import type { ChatMessage, LlmConfig } from "./types.js";
import { AgentLoop, type ReasonHookConfig } from "./agent-loop.js";
import type { ReasonResult } from "./reason.js";
import { PlanExecutor } from "./plan-execute.js";
import { detectWorkspaceContext, mergePromptContextFromEnv, type PromptContext } from "./prompt.js";
import { SessionStore, sumSessionRunCosts, type SessionData, type SessionRunRecord } from "./session-store.js";
import {
  PermissionGuard,
  type PermissionCallback,
  type PermissionPolicy,
} from "./permissions.js";
import type { HarnessHooks } from "./hooks.js";
import { createTraceSink, type TraceConfig, type TraceSink } from "./trace-sink.js";
import { estimateRunCostUsd } from "@forgelet/sdk-runtime";
import { CodebaseMemoryClient } from "./code-graph/codebase-memory.js";

export interface HarnessEngineOptions {
  workspaceRoot: string;
  config: LlmConfig;
  maxTurns?: number;
  promptContext?: PromptContext;
  usePlanExecute?: boolean;
  sessionStore?: SessionStore;
  /** Persist messages to sessionStore (default: true when sessionStore is set) */
  persistSession?: boolean;
  onPermissionConfirm?: PermissionCallback;
  permissionPolicy?: PermissionPolicy;
  hooks?: HarnessHooks;
  /** Append AgentEvent JSONL under FORGELET_HOME/traces (default on when set) */
  trace?: TraceConfig;
  /**
   * Reason-as-Sensor hook — independent LLM reviewer that runs before the
   * agent's "completed" state is accepted. See `agent-loop.ts` for details.
   * Disabled by default; SWE-bench runner enables it via `FORGELET_REASON=1`.
   */
  reason?: ReasonHookConfig;
  /**
   * Path patterns that block write operations. Passed through to ToolExecutor.
   * Used by SWE-bench to prevent editing test files.
   */
  protectedPathPatterns?: string[];
  /**
   * Code graph via codebase-memory-mcp. Default: auto (use binary if on PATH).
   * Set false to disable. Set true to require it (warn in progress if missing).
   */
  codeGraph?: boolean;
}

export class HarnessEngine implements AgentEngine {
  private readonly workspaceRoot: string;
  private readonly config: LlmConfig;
  private readonly maxTurns?: number;
  private readonly usePlanExecute: boolean;
  private readonly sessionStore?: SessionStore;
  private readonly persistSession: boolean;
  private readonly permissionGuard: PermissionGuard;
  private readonly hooks?: HarnessHooks;
  private readonly traceConfig?: TraceConfig;
  private readonly reason?: ReasonHookConfig;
  private readonly protectedPathPatterns?: string[];
  private readonly codeGraphOption: boolean;
  private promptContext?: PromptContext;

  constructor(options: HarnessEngineOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.config = options.config;
    this.maxTurns = options.maxTurns;
    this.usePlanExecute = options.usePlanExecute ?? false;
    this.sessionStore =
      options.sessionStore ?? SessionStore.forWorkspace(options.workspaceRoot);
    this.traceConfig = options.trace;
    this.persistSession = options.persistSession ?? true;
    this.permissionGuard = new PermissionGuard(
      options.permissionPolicy,
      options.onPermissionConfirm,
    );
    this.hooks = options.hooks;
    this.promptContext = options.promptContext;
    this.reason = options.reason;
    this.protectedPathPatterns = options.protectedPathPatterns;
    this.codeGraphOption = options.codeGraph !== false;
  }

  getPermissionGuard(): PermissionGuard {
    return this.permissionGuard;
  }

  private async prepareCodeGraph(
    emit: ProgressEmitter,
    signal?: AbortSignal,
  ): Promise<CodebaseMemoryClient | undefined> {
    const client = await prepareCodeGraphForRun(
      this.workspaceRoot,
      this.codeGraphOption,
      emit,
      signal,
    );
    if (client) {
      this.promptContext = {
        ...(this.promptContext ?? { workspaceRoot: this.workspaceRoot }),
        codeGraphEnabled: true,
      };
    }
    return client;
  }

  async runTask(input: RunTaskInput, emit: EventSink): Promise<void> {
    const { sessionId, prompt, signal } = input;
    const taskId = `harness-${Date.now().toString(36)}`;
    const startTime = Date.now();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadInputTokens = 0;
    let sessionCreatedAt = new Date().toISOString();

    if (!this.promptContext) {
      this.promptContext = mergePromptContextFromEnv(
        await detectWorkspaceContext(this.workspaceRoot),
      );
    }

    let initialMessages: ChatMessage[] | undefined;
    let sessionTotalCostUsd = 0;
    let lastRunCostUsd: number | undefined;
    let sessionRuns: SessionRunRecord[] = [];
    let runStartInputTokens = 0;
    let runStartOutputTokens = 0;

    if (this.sessionStore) {
      const existing = await this.sessionStore.load(sessionId);
      if (existing) {
        sessionRuns = existing.metadata.runs ?? [];
        sessionTotalCostUsd = existing.metadata.totalCostUsd ?? sumSessionRunCosts(sessionRuns);
        if (input.runMode === "resume" && existing.messages?.length) {
          initialMessages = existing.messages;
          sessionCreatedAt = existing.createdAt;
          totalInputTokens = existing.metadata.totalInputTokens ?? 0;
          totalOutputTokens = existing.metadata.totalOutputTokens ?? 0;
        }
      }
    }

    runStartInputTokens = totalInputTokens;
    runStartOutputTokens = totalOutputTokens;

    const attachCost = (metrics: AgentRunMetrics): AgentRunMetrics => {
      const inputTokens = metrics.inputTokens ?? 0;
      const outputTokens = metrics.outputTokens ?? 0;
      const cacheReadInputTokens = metrics.cacheReadInputTokens ?? 0;
      const cacheCreationInputTokens = metrics.cacheCreationInputTokens ?? 0;
      const runCost =
        this.config.provider && (inputTokens > 0 || outputTokens > 0)
          ? estimateRunCostUsd({
              provider: this.config.provider,
              model: this.config.model,
              inputTokens,
              outputTokens,
              cacheReadInputTokens,
              cacheCreationInputTokens,
            })
          : undefined;
      if (runCost === undefined) return metrics;
      const modelKey = this.config.model ?? "unknown";
      return {
        ...metrics,
        totalCostUsd: runCost,
        modelUsage: {
          [modelKey]: {
            inputTokens,
            outputTokens,
            totalTokens: metrics.totalTokens ?? inputTokens + outputTokens,
            cacheReadInputTokens: cacheReadInputTokens || undefined,
            cacheCreationInputTokens: cacheCreationInputTokens || undefined,
            costUsd: runCost,
          },
        },
      };
    };

    const traceSink: TraceSink | undefined = createTraceSink(
      this.traceConfig
        ? {
            enabled: this.traceConfig.enabled ?? true,
            ...this.traceConfig,
            runId: this.traceConfig.runId || sessionId,
          }
        : undefined,
    );

    const emitEvent = (type: AgentEvent["type"], payload: unknown): void => {
      const event: AgentEvent = {
        type,
        sessionId,
        taskId,
        timestamp: new Date().toISOString(),
        payload,
      };
      emit(event);
      void Promise.resolve(traceSink?.append(event)).catch(() => {});
    };

    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const countUserTurns = (messages: ChatMessage[]): number =>
      messages.filter((m) => m.role === "user").length;

    const flushSession = async (messages: ChatMessage[], turnCount?: number): Promise<void> => {
      if (!this.persistSession || !this.sessionStore) return;
      const data: SessionData = {
        id: sessionId,
        createdAt: sessionCreatedAt,
        updatedAt: new Date().toISOString(),
        messages,
        metadata: {
          model: this.config.model,
          workspaceRoot: this.workspaceRoot,
          turnCount: turnCount ?? countUserTurns(messages),
          totalInputTokens,
          totalOutputTokens,
          totalCostUsd: sessionTotalCostUsd,
          lastRunCostUsd,
          runs: sessionRuns.length > 0 ? sessionRuns : undefined,
        },
      };
      await this.sessionStore.save(data);
    };

    const recordCompletedRun = (
      messages: ChatMessage[],
      durationMs: number,
      deltaInputTokens: number,
      deltaOutputTokens: number,
      runCostUsd: number | undefined,
    ): void => {
      const turnIndex = countUserTurns(messages);
      if (turnIndex <= 0) return;

      const completedAt = new Date().toISOString();
      sessionRuns = [
        ...sessionRuns,
        {
          taskId,
          turnIndex,
          startedAt: new Date(startTime).toISOString(),
          completedAt,
          durationMs,
          inputTokens: deltaInputTokens,
          outputTokens: deltaOutputTokens,
          costUsd: runCostUsd,
          model: this.config.model,
        },
      ];
      lastRunCostUsd = runCostUsd;
      sessionTotalCostUsd = sumSessionRunCosts(sessionRuns);
    };

    const scheduleSave = (messages: ChatMessage[], turnCount: number): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        void flushSession(messages, turnCount).catch(() => {});
      }, 500);
    };

    emitEvent("agent.started", {
      prompt,
      status: "running",
      recoverable: false,
      runMode: input.runMode ?? "run",
    });

    const loopCallbacks = {
      onTextDelta: (delta: string) => {
        emitEvent("agent.delta", { delta });
      },
      onUsageUpdate: (usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
      }) => {
        totalInputTokens = usage.inputTokens;
        totalOutputTokens = usage.outputTokens;
        totalCacheReadInputTokens = usage.cacheReadInputTokens ?? totalCacheReadInputTokens;
      },
      onToolCall: (toolName: string, args: Record<string, unknown>, callId: string) => {
        emitEvent("tool.called", {
          toolCallId: callId,
          toolName,
          args,
          metadata: {
            name: toolName,
            displayName: toolName,
          },
        });
      },
      onToolResult: (toolName: string, output: string, ok: boolean, callId: string) => {
        if (ok) {
          emitEvent("tool.output", {
            toolCallId: callId,
            toolName,
            output: truncateForEvent(output),
          });
        } else {
          const isDenied = output.includes("Permission denied") || output.includes("User denied");
          emitEvent("tool.error", {
            toolCallId: callId,
            toolName,
            error: truncateForEvent(output),
            decision: isDenied ? "deny" : undefined,
          });
        }
      },
      onError: (error: Error) => {
        emitEvent("agent.error", {
          error: error.message,
          status: "failed",
          recoverable: false,
          terminalReason: "failed_terminal",
        });
      },
      onReasonVerdict: (round: number, result: ReasonResult) => {
        emitEvent("agent.progress", {
          stage: "execute",
          message: `[reason r${round}] ${result.verdict.toUpperCase()}${result.confidence ? ` (${result.confidence})` : ""}${result.rationale ? `: ${result.rationale}` : ""}`,
          status: "running",
          metadata: {
            reasonRound: round,
            verdict: result.verdict,
            confidence: result.confidence,
            rationale: result.rationale,
            missedCases: result.missed_cases,
            suggestions: result.suggestions,
            inputTokens: result.tokenUsage?.inputTokens,
            outputTokens: result.tokenUsage?.outputTokens,
          },
        });
      },
    };

    try {
      if (this.usePlanExecute) {
        emitEvent("agent.progress", {
          stage: "plan",
          message: `Planning with ${this.config.model || "unknown model"}`,
          status: "running",
        });

        const planner = new PlanExecutor({
          config: this.config,
          workspaceRoot: this.workspaceRoot,
          promptContext: this.promptContext,
          maxTotalTurns: this.maxTurns,
          signal,
          callbacks: {
            ...loopCallbacks,
            onPlanCreated: (plan) => {
              emitEvent("agent.progress", {
                stage: "plan",
                message: `Plan: ${plan.goal} (${plan.steps.length} steps)`,
                status: "running",
              });
            },
            onStepStarted: (step) => {
              emitEvent("agent.progress", {
                stage: "execute",
                message: `Step ${step.id}: ${step.description}`,
                status: "running",
              });
            },
          },
        });

        const { plan, tokenUsage } = await planner.run(prompt);
        const durationMs = Date.now() - startTime;
        const completed = plan.steps.filter((s) => s.status === "completed").length;
        const summary = `Plan completed: ${completed}/${plan.steps.length} steps. Goal: ${plan.goal}`;

        const planMetrics = attachCost({
          durationMs,
          numTurns: plan.steps.length,
          inputTokens: tokenUsage.inputTokens || undefined,
          outputTokens: tokenUsage.outputTokens || undefined,
          totalTokens: tokenUsage.totalTokens || undefined,
          primaryModel: this.config.model,
        });
        lastRunCostUsd = planMetrics.totalCostUsd;
        sessionTotalCostUsd += lastRunCostUsd ?? 0;

        emitEvent("agent.done", {
          summary: truncateForEvent(summary),
          metrics: planMetrics,
          status: "completed",
          recoverable: false,
          terminalReason: "completed",
        });
        await traceSink?.close();
        return;
      }

      const codeGraphClient = await this.prepareCodeGraph(emitEvent, signal);

      emitEvent("agent.progress", {
        stage: "execute",
        message: `Starting agent loop with ${this.config.model || "unknown model"}`,
        status: "running",
      });

      const loop = new AgentLoop({
        config: this.config,
        workspaceRoot: this.workspaceRoot,
        promptContext: this.promptContext,
        maxTurns: this.maxTurns,
        signal,
        callbacks: loopCallbacks,
        initialMessages,
        sessionId,
        permissionGuard: this.permissionGuard,
        hooks: this.hooks,
        reason: this.reason,
        protectedPathPatterns: this.protectedPathPatterns,
        codeGraph: codeGraphClient,
        onMessagesChanged: (messages) => {
          scheduleSave(messages, countUserTurns(messages));
        },
      });

      const result = await loop.run(prompt);
      if (saveTimer) clearTimeout(saveTimer);
      loop.destroy();

      const durationMs = Date.now() - startTime;
      const finalMessage = result.messages[result.messages.length - 1];
      const stoppedAtMaxTurns = result.stopReason === "max_turns";
      const baseSummary =
        finalMessage?.role === "assistant" && finalMessage.content
          ? finalMessage.content
          : "Agent task completed.";
      const summary = stoppedAtMaxTurns
        ? `[Stopped at max turns (${result.turnCount}) — partial work preserved]\n\n${baseSummary}`
        : baseSummary;

      const deltaInputTokens = Math.max(0, totalInputTokens - runStartInputTokens);
      const deltaOutputTokens = Math.max(0, totalOutputTokens - runStartOutputTokens);
      const cacheReadTokens = totalCacheReadInputTokens || result.tokenUsage.cacheReadInputTokens;
      const runMetrics = attachCost({
        durationMs,
        numTurns: result.turnCount,
        inputTokens: deltaInputTokens || undefined,
        outputTokens: deltaOutputTokens || undefined,
        totalTokens:
          deltaInputTokens || deltaOutputTokens
            ? deltaInputTokens + deltaOutputTokens
            : undefined,
        cacheReadInputTokens: cacheReadTokens || undefined,
        primaryModel: this.config.model,
      });
      lastRunCostUsd = runMetrics.totalCostUsd;
      recordCompletedRun(
        result.messages,
        durationMs,
        deltaInputTokens,
        deltaOutputTokens,
        lastRunCostUsd,
      );

      await flushSession(result.messages);

      const lastReasonVerdict = result.reasonVerdicts?.[result.reasonVerdicts.length - 1]?.verdict;
      const metrics = {
        ...runMetrics,
        runInputTokens: deltaInputTokens || undefined,
        runOutputTokens: deltaOutputTokens || undefined,
        sessionTotalCostUsd,
        inputTokens: totalInputTokens || result.tokenUsage.inputTokens || undefined,
        outputTokens: totalOutputTokens || result.tokenUsage.outputTokens || undefined,
        totalTokens:
          totalInputTokens || totalOutputTokens
            ? totalInputTokens + totalOutputTokens
            : result.tokenUsage.totalTokens || undefined,
        reasonRoundsUsed: result.reasonRoundsUsed,
        reasonFinalVerdict: lastReasonVerdict,
      };

      emitEvent("agent.done", {
        summary: truncateForEvent(summary),
        metrics,
        status: "completed",
        recoverable: false,
        terminalReason: stoppedAtMaxTurns ? "max_turns" : "completed",
      });
      await traceSink?.close();
    } catch (error) {
      if (saveTimer) clearTimeout(saveTimer);
      const durationMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);
      const isCancelled = message.includes("cancelled") || message.includes("aborted");

      emitEvent("agent.error", {
        error: message,
        status: isCancelled ? "cancelled" : "failed",
        recoverable: false,
        terminalReason: isCancelled ? "cancelled" : "failed_terminal",
        metrics: {
          durationMs,
          numTurns: 0,
          primaryModel: this.config.model,
        },
      });
      await traceSink?.close();
    }
  }
}

function truncateForEvent(text: string, maxLen = 4096): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "... [truncated]";
}

type ProgressEmitter = (type: AgentEvent["type"], payload: unknown) => void;

async function prepareCodeGraphForRun(
  workspaceRoot: string,
  enabled: boolean,
  emit: ProgressEmitter,
  signal?: AbortSignal,
): Promise<CodebaseMemoryClient | undefined> {
  if (!enabled) return undefined;
  if (signal?.aborted) return undefined;

  const client = await CodebaseMemoryClient.create(workspaceRoot);
  if (!client) {
    emit("agent.progress", {
      stage: "execute",
      message:
        "Code graph skipped: install codebase-memory-mcp (https://github.com/DeusData/codebase-memory-mcp) or set FORGELET_CODEBASE_MEMORY_BIN",
      status: "running",
    });
    return undefined;
  }

  emit("agent.progress", {
    stage: "execute",
    message: "Indexing workspace for code graph (codebase-memory-mcp)…",
    status: "running",
  });

  const indexResult = await client.indexRepository();
  if (signal?.aborted) return undefined;

  if (indexResult.ok) {
    const projectHint = client.projectName ? ` project=${client.projectName}` : "";
    emit("agent.progress", {
      stage: "execute",
      message: `Code graph ready${projectHint} (code_graph_architecture, code_graph_search, code_graph_trace, code_graph_impact)`,
      status: "running",
    });
    return client;
  }

  emit("agent.progress", {
    stage: "execute",
    message: `Code graph index failed; structural tools disabled. ${truncateForEvent(indexResult.output, 512)}`,
    status: "running",
  });
  return undefined;
}
