import type { AgentEngine, RunTaskInput, EventSink } from "@forgelet/sdk-core";
import type { AgentEvent, AgentRunMetrics } from "@forgelet/shared-types";
import type { ChatMessage, LlmConfig } from "./types.js";
import { AgentLoop } from "./agent-loop.js";
import { PlanExecutor } from "./plan-execute.js";
import { detectWorkspaceContext, type PromptContext } from "./prompt.js";
import { SessionStore, resolveHarnessSessionDir, type SessionData } from "./session-store.js";
import {
  PermissionGuard,
  type PermissionCallback,
  type PermissionPolicy,
} from "./permissions.js";
import type { HarnessHooks } from "./hooks.js";

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
  private promptContext?: PromptContext;

  constructor(options: HarnessEngineOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.config = options.config;
    this.maxTurns = options.maxTurns;
    this.usePlanExecute = options.usePlanExecute ?? false;
    this.sessionStore =
      options.sessionStore ??
      new SessionStore(resolveHarnessSessionDir(options.workspaceRoot));
    this.persistSession = options.persistSession ?? true;
    this.permissionGuard = new PermissionGuard(
      options.permissionPolicy,
      options.onPermissionConfirm,
    );
    this.hooks = options.hooks;
    this.promptContext = options.promptContext;
  }

  getPermissionGuard(): PermissionGuard {
    return this.permissionGuard;
  }

  async runTask(input: RunTaskInput, emit: EventSink): Promise<void> {
    const { sessionId, prompt, signal } = input;
    const taskId = `harness-${Date.now().toString(36)}`;
    const startTime = Date.now();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let sessionCreatedAt = new Date().toISOString();

    if (!this.promptContext) {
      this.promptContext = await detectWorkspaceContext(this.workspaceRoot);
    }

    let initialMessages: ChatMessage[] | undefined;
    if (input.runMode === "resume" && this.sessionStore) {
      const existing = await this.sessionStore.load(sessionId);
      if (existing?.messages?.length) {
        initialMessages = existing.messages;
        sessionCreatedAt = existing.createdAt;
        totalInputTokens = existing.metadata.totalInputTokens ?? 0;
        totalOutputTokens = existing.metadata.totalOutputTokens ?? 0;
      }
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

    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const flushSession = async (messages: ChatMessage[], turnCount: number): Promise<void> => {
      if (!this.persistSession || !this.sessionStore) return;
      const data: SessionData = {
        id: sessionId,
        createdAt: sessionCreatedAt,
        updatedAt: new Date().toISOString(),
        messages,
        metadata: {
          model: this.config.model,
          workspaceRoot: this.workspaceRoot,
          turnCount,
          totalInputTokens,
          totalOutputTokens,
        },
      };
      await this.sessionStore.save(data);
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
        initialMessages,
        sessionId,
        permissionGuard: this.permissionGuard,
        hooks: this.hooks,
        onMessagesChanged: (messages) => {
          const turns = messages.filter((m) => m.role === "user").length;
          scheduleSave(messages, turns);
        },
      });

      const result = await loop.run(prompt);
      if (saveTimer) clearTimeout(saveTimer);
      await flushSession(result.messages, result.turnCount);
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
    }
  }
}

function truncateForEvent(text: string, maxLen = 4096): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "... [truncated]";
}
