import type { AgentEngine, RunTaskInput, EventSink } from "@forgelet/sdk-core";
import type { AgentEvent, AgentRunMetrics } from "@forgelet/shared-types";
import type { LlmConfig } from "./types.js";
import { AgentLoop } from "./agent-loop.js";

export interface HarnessEngineOptions {
  workspaceRoot: string;
  config: LlmConfig;
  maxTurns?: number;
}

export class HarnessEngine implements AgentEngine {
  private readonly workspaceRoot: string;
  private readonly config: LlmConfig;
  private readonly maxTurns?: number;

  constructor(options: HarnessEngineOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.config = options.config;
    this.maxTurns = options.maxTurns;
  }

  async runTask(input: RunTaskInput, emit: EventSink): Promise<void> {
    const { sessionId, prompt, signal } = input;
    const taskId = `harness-${Date.now().toString(36)}`;
    const startTime = Date.now();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

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

    emitEvent("agent.progress", {
      stage: "execute",
      message: `Starting agent loop with ${this.config.model || "unknown model"}`,
      status: "running",
    });

    const loop = new AgentLoop({
      config: this.config,
      workspaceRoot: this.workspaceRoot,
      maxTurns: this.maxTurns,
      signal,
      callbacks: {
        onTextDelta: (delta) => {
          emitEvent("agent.delta", { delta });
        },

        onToolCall: (toolName, args, callId) => {
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

        onToolResult: (toolName, output, ok, callId) => {
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

        onError: (error) => {
          emitEvent("agent.error", {
            error: error.message,
            status: "failed",
            recoverable: false,
            terminalReason: "failed_terminal",
          });
        },
      },
    });

    try {
      const result = await loop.run(prompt);
      const durationMs = Date.now() - startTime;

      const finalMessage = result.messages[result.messages.length - 1];
      const summary =
        finalMessage?.role === "assistant" && finalMessage.content
          ? finalMessage.content
          : "Agent task completed.";

      const metrics: AgentRunMetrics = {
        durationMs,
        numTurns: result.turnCount,
        inputTokens: totalInputTokens || undefined,
        outputTokens: totalOutputTokens || undefined,
        totalTokens:
          totalInputTokens || totalOutputTokens
            ? totalInputTokens + totalOutputTokens
            : undefined,
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
