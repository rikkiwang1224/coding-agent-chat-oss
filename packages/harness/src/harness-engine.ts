import type { AgentEngine, RunTaskInput, EventSink } from "@forgelet/sdk-core";
import type { AgentEvent, AgentRunMetrics } from "@forgelet/shared-types";
import type { LlmConfig } from "./types.js";
import { AgentLoop } from "./agent-loop.js";
import { PlanExecutor } from "./plan-execute.js";
import { detectWorkspaceContext, type PromptContext } from "./prompt.js";

export interface HarnessEngineOptions {
  workspaceRoot: string;
  config: LlmConfig;
  maxTurns?: number;
  promptContext?: PromptContext;
  /** Use plan-then-execute for complex multi-step tasks */
  usePlanExecute?: boolean;
}

export class HarnessEngine implements AgentEngine {
  private readonly workspaceRoot: string;
  private readonly config: LlmConfig;
  private readonly maxTurns?: number;
  private readonly usePlanExecute: boolean;
  private promptContext?: PromptContext;

  constructor(options: HarnessEngineOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.config = options.config;
    this.maxTurns = options.maxTurns;
    this.usePlanExecute = options.usePlanExecute ?? false;
    this.promptContext = options.promptContext;
  }

  async runTask(input: RunTaskInput, emit: EventSink): Promise<void> {
    const { sessionId, prompt, signal } = input;
    const taskId = `harness-${Date.now().toString(36)}`;
    const startTime = Date.now();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Auto-detect workspace context if not provided
    if (!this.promptContext) {
      this.promptContext = await detectWorkspaceContext(this.workspaceRoot);
    }

    const emitEvent = (type: AgentEvent["type"], payload: unknown): void => {
      emit({
        type,
        sessionId,
        taskId,
        timestamp: new Date().toISOString(),
        payload,
      });
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
      onUsageUpdate: (usage: { inputTokens: number; outputTokens: number }) => {
        totalInputTokens = usage.inputTokens;
        totalOutputTokens = usage.outputTokens;
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
          emitEvent("tool.error", {
            toolCallId: callId,
            toolName,
            error: truncateForEvent(output),
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

        emitEvent("agent.done", {
          summary: truncateForEvent(summary),
          metrics: {
            durationMs,
            numTurns: plan.steps.length,
            inputTokens: tokenUsage.inputTokens || undefined,
            outputTokens: tokenUsage.outputTokens || undefined,
            totalTokens: tokenUsage.totalTokens || undefined,
            primaryModel: this.config.model,
          },
          status: "completed",
          recoverable: false,
          terminalReason: "completed",
        });
        return;
      }

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
      });

      const result = await loop.run(prompt);
      loop.destroy();
      const durationMs = Date.now() - startTime;

      const finalMessage = result.messages[result.messages.length - 1];
      const summary =
        finalMessage?.role === "assistant" && finalMessage.content
          ? finalMessage.content
          : "Agent task completed.";

      const metrics: AgentRunMetrics = {
        durationMs,
        numTurns: result.turnCount,
        inputTokens: totalInputTokens || result.tokenUsage.inputTokens || undefined,
        outputTokens: totalOutputTokens || result.tokenUsage.outputTokens || undefined,
        totalTokens:
          totalInputTokens || totalOutputTokens
            ? totalInputTokens + totalOutputTokens
            : result.tokenUsage.totalTokens || undefined,
        primaryModel: this.config.model,
      };

      emitEvent("agent.done", {
        summary: truncateForEvent(summary),
        metrics,
        status: "completed",
        recoverable: false,
        terminalReason: "completed",
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      const isCancelled =
        message.includes("cancelled") || message.includes("aborted");

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
    }
  }
}

function truncateForEvent(text: string, maxLen = 4096): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "... [truncated]";
}
