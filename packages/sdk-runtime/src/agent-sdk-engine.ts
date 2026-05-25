import { randomUUID } from "node:crypto";
import {
  buildClaudeCodeRuntimeOptions,
  type AgentEngine,
  type AgentSessionSnapshot,
  type ClaudeCodePermissionMode,
  type EventSink,
  type RunTaskInput
} from "@forgelet/sdk-core";
import type {
  AgentEvent,
  AgentTaskStatus,
  AgentTerminalReason,
  AgentToolMetadata
} from "@forgelet/shared-types";
import { formatSessionTranscriptEntry } from "@forgelet/storage-core";
import { AgentRuntime } from "./agent-runtime.js";
import { buildSystemPrompt } from "./agent-sdk-prompt.js";
import { ensureClaudeAttributionDisabled } from "./project-settings.js";
import { ClaudeCodeSessionStore } from "./session-store.js";
import {
  appendToolCalledEvent,
  appendToolErrorEvent,
  appendToolOutputEvent
} from "./session-tool-events.js";
import type { LlmConfig } from "./types/providers.js";
import { buildSdkEnv, resolveModel, resolveProvider, resolveSdkModelOption } from "./providers/env.js";
import { accumulateMetrics, buildMetricsFromResult } from "./cost/estimator.js";
import type { SdkMessage } from "./types/sdk-messages.js";

const DEFAULT_SETTING_SOURCES = ["project"] as const;

export type McpServerConfig =
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

export interface AgentSdkEngineOptions {
  workspaceRoot: string;
  sessionStoreDir?: string;
  /** Overrides env-based permission mode when a caller wants explicit behavior. */
  permissionMode?: ClaudeCodePermissionMode;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * LLM config sourced from chat-desktop Settings UI. When present, takes priority
   * over process.env and drives provider preset resolution (baseUrl, auth header
   * style, model aliasing). Without this, the SDK would silently fall back to
   * `.env` / system env which causes Settings UI changes to appear to do nothing.
   */
  llmConfig?: LlmConfig;
}

/**
 * Local alias for the SDK's result/stream message shape. Re-exported from the shared
 * `types/sdk-messages.ts` so AgentSdkEngine and AgentRuntime reason about
 * the same wire type.
 */
type AgentSdkMessage = SdkMessage;

interface LiveAssistantState {
  emittedText: string;
}

export class AgentSdkEngine implements AgentEngine {
  constructor(private readonly options: AgentSdkEngineOptions) {}

  async runTask(input: RunTaskInput, emit: EventSink): Promise<void> {
    const sessionStore = new ClaudeCodeSessionStore({
      workspaceRoot: this.options.workspaceRoot,
      directory: this.options.sessionStoreDir
    });
    const existingSnapshot = await sessionStore.load(input.sessionId);
    await ensureClaudeAttributionDisabled(this.options.workspaceRoot);
    const taskId = randomUUID();
    const snapshot = buildInitialSnapshot(input, this.options.workspaceRoot, taskId, existingSnapshot);

    emitEvent(emit, input.sessionId, taskId, "agent.started", {
      prompt: input.prompt,
      status: "running",
      recoverable: snapshot.recoverable,
      runMode: input.runMode
    });

    const runtime = AgentRuntime.shared();

    const runtimeOptions = buildClaudeCodeRuntimeOptions(this.options.workspaceRoot);
    const abortController = new AbortController();
    input.signal?.addEventListener("abort", () => abortController.abort(input.signal?.reason), { once: true });
    const queryOptions = buildQueryOptions(
      this.options.workspaceRoot,
      runtimeOptions,
      input,
      abortController,
      existingSnapshot?.sdkSessionId,
      this.options.mcpServers,
      this.options.llmConfig,
      this.options.permissionMode
    );
    const queryPrompt = buildSystemPrompt(input.prompt);

    let stream: AsyncIterable<AgentSdkMessage>;
    try {
      stream = await runtime.stream(queryPrompt, queryOptions);
    } catch {
      await failRun(
        sessionStore,
        snapshot,
        emit,
        "Claude Agent SDK is unavailable. Install @anthropic-ai/claude-agent-sdk to enable Agent SDK preview.",
        "failed",
        "failed_terminal"
      );
      return;
    }

    const runStartMs = Date.now();
    try {
      const liveAssistantState: LiveAssistantState = {
        emittedText: ""
      };
      // tool_result blocks carry only `tool_use_id`; map to a real tool name
      // recorded from the originating `tool_use` block, so tool.output events
      // get the right Read/Edit/Bash label instead of falling back to "tool".
      const toolNameByUseId = new Map<string, string>();
      for await (const message of stream) {
        handleSdkMessage(
          message,
          input,
          taskId,
          emit,
          snapshot,
          liveAssistantState,
          this.options.llmConfig,
          runStartMs,
          toolNameByUseId,
        );
      }

      snapshot.taskStatus = snapshot.taskStatus === "failed" ? "failed" : "completed";
      snapshot.updatedAt = new Date().toISOString();
      await sessionStore.save(snapshot);

      if (snapshot.taskStatus === "failed") {
        emitEvent(emit, input.sessionId, taskId, "agent.error", {
          error: snapshot.lastError ?? "Agent SDK run failed",
          status: "failed",
          recoverable: snapshot.recoverable,
          metrics: snapshot.metrics,
          terminalReason: "failed_terminal"
        });
        return;
      }

      emitEvent(emit, input.sessionId, taskId, "agent.done", {
        summary: snapshot.lastSummary ?? "",
        status: "completed",
        recoverable: snapshot.recoverable,
        terminalReason: "completed",
        metrics: snapshot.metrics,
        sdkSessionId: snapshot.sdkSessionId
      });
    } catch (error) {
      // Always write minimal metrics for failed / cancelled runs so the snapshot
      // carries durationMs + provider + model even when the SDK never emitted a
      // `result` message.
      // Use the accumulator so this turn's partial duration is added on top of
      // any prior successful turns within the same session, not overwriting them.
      const provider = resolveProvider(this.options.llmConfig);
      const model = resolveModel(this.options.llmConfig);
      const partialMetrics = buildMetricsFromResult({}, provider, model, runStartMs);
      snapshot.metrics = accumulateMetrics(snapshot.metrics, partialMetrics);
      await failRun(
        sessionStore,
        snapshot,
        emit,
        error instanceof Error ? error.message : String(error),
        input.signal?.aborted ? "cancelled" : "failed",
        input.signal?.aborted ? "cancelled" : "failed_terminal"
      );
    }
  }
}

function buildInitialSnapshot(
  input: RunTaskInput,
  workspaceRoot: string,
  taskId: string,
  existingSnapshot: AgentSessionSnapshot | null
): AgentSessionSnapshot {
  const createdAt = existingSnapshot?.createdAt ?? new Date().toISOString();
  const isResume = input.runMode === "resume";

  const eventTitle = isResume
    ? "session.resume"
    : input.runMode === "retry"
      ? "session.retry"
      : "session.start";
  const eventDetail = isResume
    ? `Resuming Agent SDK session ${input.sessionId}`
    : input.runMode === "retry"
      ? `Retrying Agent SDK session ${input.sessionId}`
      : `Starting Agent SDK session ${input.sessionId}`;

  return {
    sessionId: input.sessionId,
    sdkSessionId: isResume ? existingSnapshot?.sdkSessionId : undefined,
    workspaceRoot,
    createdAt,
    taskId,
    taskStatus: "running",
    recoverable: isResume ? true : false,
    originalPrompt: input.prompt,
    transcriptEntries: [
      ...(isResume ? (existingSnapshot?.transcriptEntries ?? []) : []),
      formatSessionTranscriptEntry(`User:\n${input.prompt}`)
    ],
    historyEvents: [
      ...(isResume ? (existingSnapshot?.historyEvents ?? []) : []),
      {
        title: eventTitle,
        detail: eventDetail,
        timestamp: new Date().toISOString(),
        tone: "info"
      }
    ],
    toolEvents: isResume ? (existingSnapshot?.toolEvents ?? []) : [],
    updatedAt: createdAt
  };
}

function buildQueryOptions(
  workspaceRoot: string,
  runtimeOptions: ReturnType<typeof buildClaudeCodeRuntimeOptions>,
  input: RunTaskInput,
  abortController: AbortController,
  resumeSdkSessionId?: string,
  externalMcpServers?: Record<string, McpServerConfig>,
  llmConfig?: LlmConfig,
  permissionModeOverride?: ClaudeCodePermissionMode
): Record<string, unknown> {
  // See `resolveSdkModelOption` for why third-party providers must use the
  // "sonnet" alias here rather than their real model id.
  const modelForSdk = resolveSdkModelOption(llmConfig) ?? runtimeOptions.model;

  const options: Record<string, unknown> = {
    cwd: workspaceRoot,
    model: modelForSdk,
    maxTurns: runtimeOptions.maxTurns,
    permissionMode: permissionModeOverride ?? runtimeOptions.permissionMode,
    allowedTools: runtimeOptions.allowedTools,
    disallowedTools: runtimeOptions.disallowedTools,
    settingSources: parseSettingSources(process.env.CLAUDE_CODE_SETTING_SOURCES),
    includePartialMessages: true,
    env: buildSdkEnv(llmConfig),
    abortController
  };

  const mcpServers: Record<string, unknown> = { ...(externalMcpServers ?? {}) };

  if (Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
  }

  if (input.runMode === "resume" && resumeSdkSessionId) {
    options.resume = resumeSdkSessionId;
  }

  return removeUndefinedValues(options);
}

function handleSdkMessage(
  message: AgentSdkMessage,
  input: RunTaskInput,
  taskId: string,
  emit: EventSink,
  snapshot: AgentSessionSnapshot,
  liveAssistantState: LiveAssistantState,
  llmConfig: LlmConfig | undefined,
  runStartMs: number,
  toolNameByUseId: Map<string, string>,
): void {
  if (message.type === "system" && message.subtype === "init") {
    if (typeof message.session_id === "string" && message.session_id.trim()) {
      snapshot.sdkSessionId = message.session_id;
      snapshot.recoverable = true;
    }

    snapshot.historyEvents.push({
      title: "sdk.init",
      detail: `model=${typeof message.model === "string" ? message.model : "unknown"} tools=${Array.isArray(message.tools) ? message.tools.length : 0}`,
      timestamp: new Date().toISOString(),
      tone: "info"
    });
    emitEvent(emit, input.sessionId, taskId, "agent.progress", {
      stage: "plan",
      message: `Claude Agent SDK ready: model=${typeof message.model === "string" ? message.model : "unknown"} tools=${Array.isArray(message.tools) ? message.tools.length : 0}`,
      status: "running",
      recoverable: snapshot.recoverable
    });
    return;
  }

  if (message.type === "assistant") {
    const text = extractTextBlocks(message);
    if (text) {
      snapshot.transcriptEntries.push(formatSessionTranscriptEntry(`Assistant:\n${text}`));
      const delta = resolveAssistantDelta(text, liveAssistantState.emittedText);
      if (delta) {
        liveAssistantState.emittedText += delta;
        emitEvent(emit, input.sessionId, taskId, "agent.delta", { delta });
      }
    }

    for (const toolCall of extractToolCalls(message)) {
      if (toolCall.toolCallId) {
        toolNameByUseId.set(toolCall.toolCallId, toolCall.toolName);
      }
      appendToolCalledEvent(snapshot, {
        toolName: toolCall.toolName,
        args: toolCall.args,
        metadata: toolCall.metadata
      });
      emitEvent(emit, input.sessionId, taskId, "tool.called", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: toolCall.args,
        metadata: toolCall.metadata
      });
    }
    return;
  }

  if (message.type === "user") {
    liveAssistantState.emittedText = "";
    for (const toolResult of extractToolResults(message)) {
      const resolvedToolName = toolResult.toolCallId
        ? (toolNameByUseId.get(toolResult.toolCallId) ?? toolResult.toolName)
        : toolResult.toolName;
      if (toolResult.isError) {
        appendToolErrorEvent(snapshot, {
          toolName: resolvedToolName,
          error: toolResult.output
        });
      } else {
        appendToolOutputEvent(snapshot, {
          toolName: resolvedToolName,
          output: toolResult.output
        });
      }
      emitEvent(emit, input.sessionId, taskId, toolResult.isError ? "tool.error" : "tool.output", {
        toolCallId: toolResult.toolCallId,
        toolName: resolvedToolName,
        [toolResult.isError ? "error" : "output"]: toolResult.output
      });
    }
    return;
  }

  if (message.type === "result") {
    liveAssistantState.emittedText = "";
    const success = message.subtype === "success";
    snapshot.taskStatus = success ? "completed" : "failed";
    snapshot.lastSummary = typeof message.result === "string" ? message.result : snapshot.lastSummary;
    snapshot.lastError =
      success || typeof message.result !== "string"
        ? undefined
        : message.result;
    // Route chat-mode metrics through the same estimator AgentRuntime uses, so
    // third-party providers (Kimi / DeepSeek / GLM) get accurate cost based
    // on their own pricing instead of the SDK's Anthropic-priced `total_cost_usd`,
    // and so the snapshot carries provider / model / costIsEstimated / token counts.
    //
    // Chat mode reuses the same session across many user turns (one query() per
    // turn). The SDK reports per-turn usage; we accumulate so the snapshot's
    // metrics reflect *cumulative* session cost, not just the most recent turn.
    const provider = resolveProvider(llmConfig);
    const model = resolveModel(llmConfig);
    const turnMetrics = buildMetricsFromResult(message, provider, model, runStartMs);
    snapshot.metrics = accumulateMetrics(snapshot.metrics, turnMetrics);
    snapshot.updatedAt = new Date().toISOString();
    return;
  }

  if (message.type === "stream_event" && isRecord(message.event)) {
    const delta = extractStreamDelta(message.event);
    if (delta) {
      liveAssistantState.emittedText += delta;
      emitEvent(emit, input.sessionId, taskId, "agent.delta", { delta });
    }
  }
}

function resolveAssistantDelta(text: string, emittedText: string): string {
  if (!emittedText) {
    return text;
  }

  if (text.startsWith(emittedText)) {
    return text.slice(emittedText.length);
  }

  return "";
}

function extractTextBlocks(message: AgentSdkMessage): string {
  const content = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.message?.content)
      ? message.message.content
      : [];

  return content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
}

function extractToolCalls(message: AgentSdkMessage): Array<{ toolCallId?: string; toolName: string; args: Record<string, unknown>; metadata: AgentToolMetadata }> {
  const content = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.message?.content)
      ? message.message.content
      : [];

  return content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .filter((block) => block.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({
      toolCallId: typeof block.id === "string" ? block.id : undefined,
      toolName: String(block.name),
      args: isRecord(block.input) ? block.input : {},
      metadata: {
        name: String(block.name),
        displayName: String(block.name),
        description: "Claude Agent SDK tool"
      }
    }));
}

function extractToolResults(message: AgentSdkMessage): Array<{ toolCallId?: string; toolName: string; output: string; isError: boolean }> {
  const content = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.message?.content)
      ? message.message.content
      : [];

  return content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .filter((block) => block.type === "tool_result")
    .map((block) => ({
      toolCallId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
      toolName: typeof block.tool_name === "string" ? block.tool_name : "tool",
      output: stringifyUnknown(block.content ?? block.result ?? ""),
      isError: block.is_error === true
    }));
}

function extractStreamDelta(event: Record<string, unknown>): string {
  if (typeof event.text === "string") {
    return event.text;
  }

  if (isRecord(event.delta) && typeof event.delta.text === "string") {
    return event.delta.text;
  }

  return "";
}

async function failRun(
  sessionStore: ClaudeCodeSessionStore,
  snapshot: AgentSessionSnapshot,
  emit: EventSink,
  error: string,
  status: Extract<AgentTaskStatus, "failed" | "cancelled">,
  terminalReason: Exclude<AgentTerminalReason, "completed" | "tool_failure_recoverable">
): Promise<void> {
  snapshot.taskStatus = status;
  snapshot.lastError = error;
  snapshot.updatedAt = new Date().toISOString();
  snapshot.historyEvents.push({
    title: "agent.error",
    detail: error,
    timestamp: snapshot.updatedAt,
    tone: "danger"
  });
  await sessionStore.save(snapshot);

  emitEvent(emit, snapshot.sessionId, snapshot.taskId ?? "unknown", "agent.error", {
    error,
    status,
    recoverable: snapshot.recoverable,
    terminalReason
  });
}

function emitEvent(
  emit: EventSink,
  sessionId: string,
  taskId: string,
  type: AgentEvent["type"],
  payload: unknown
): void {
  emit({
    type,
    sessionId,
    taskId,
    payload,
    timestamp: new Date().toISOString()
  });
}

function parseSettingSources(value: string | undefined): string[] {
  const normalized = value?.trim();
  if (!normalized) {
    return [...DEFAULT_SETTING_SOURCES];
  }

  const items = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [...DEFAULT_SETTING_SOURCES];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function removeUndefinedValues<T extends object>(input: T): T {
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== undefined)
  ) as T;
}
