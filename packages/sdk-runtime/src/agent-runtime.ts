import { randomUUID } from "node:crypto";
import type { AgentSessionSnapshot } from "@forgelet/sdk-core";
import { formatSessionTranscriptEntry } from "@forgelet/storage-core";
import { loadAgentSdkModule } from "./agent-sdk-loader.js";
import { ClaudeCodeSessionStore } from "./session-store.js";

import type { SdkMessage, SdkQueryFn } from "./types/sdk-messages.js";
import type {
  AgentRunMetrics,
  AgentTaskConfig,
  AgentTaskResult,
} from "./types/agent-config.js";
import { buildSdkEnv, resolveModel, resolveProvider, resolveSdkModelOption } from "./providers/env.js";
import { buildMetricsFromResult } from "./cost/estimator.js";
import { ensureClaudeAttributionDisabled } from "./project-settings.js";
import {
  extractTextFromMessage,
  extractToolCalls,
  extractToolResults,
} from "./messages/extractors.js";

/**
 * High-level orchestration of a Claude Agent SDK session: streams SDK messages,
 * maintains an on-disk snapshot, and surfaces metrics.
 *
 * Types and stateless helpers live in sibling modules:
 *  - `types/*`         : message + config + metrics shapes
 *  - `providers/*`     : preset registry + env resolution
 *  - `cost/*`          : pricing lookup + cost estimation
 *  - `messages/*`      : SDK content-block extractors
 */
export class AgentRuntime {
  private static instance: AgentRuntime | null = null;
  private sdkQuery: SdkQueryFn | null = null;
  private loading: Promise<SdkQueryFn | null> | null = null;

  static shared(): AgentRuntime {
    if (!AgentRuntime.instance) {
      AgentRuntime.instance = new AgentRuntime();
    }
    return AgentRuntime.instance;
  }

  private async ensureSdk(): Promise<SdkQueryFn> {
    if (this.sdkQuery) return this.sdkQuery;

    if (!this.loading) {
      this.loading = (async () => {
        const mod = await loadAgentSdkModule();
        if (!mod || typeof mod.query !== "function") return null;
        return mod.query as SdkQueryFn;
      })();
    }

    const queryFn = await this.loading;
    if (!queryFn) {
      this.loading = null;
      throw new Error(
        "Claude Agent SDK is unavailable. Install @anthropic-ai/claude-agent-sdk to enable Agent SDK.",
      );
    }

    this.sdkQuery = queryFn;
    return queryFn;
  }

  /**
   * Low-level: get the raw SDK stream for per-message processing.
   * Used by AgentSdkEngine which needs fine-grained control.
   */
  async stream(
    prompt: string,
    options: Record<string, unknown>,
  ): Promise<AsyncIterable<SdkMessage>> {
    const queryFn = await this.ensureSdk();
    return queryFn({ prompt, options });
  }

  /**
   * High-level: run an agent task to completion.
   * Streams SDK messages, collects full text, returns structured result.
   * When `config.sessionLabel` is set, a session snapshot is automatically
   * saved to ~/.forgelet/sessions/ (same location as the chat agent).
   */
  async run(
    config: AgentTaskConfig,
    onMessage?: (msg: SdkMessage) => void,
  ): Promise<AgentTaskResult> {
    const abortController = new AbortController();
    if (config.signal) {
      config.signal.addEventListener("abort", () => abortController.abort(config.signal!.reason), { once: true });
    }

    await ensureClaudeAttributionDisabled(config.cwd);

    const options: Record<string, unknown> = {
      cwd: config.cwd,
      maxTurns: config.maxTurns ?? 30,
      permissionMode: config.permissionMode ?? "default",
      abortController,
      ...config.extra,
    };
    if (config.allowedTools) options.allowedTools = config.allowedTools;
    if (config.disallowedTools) options.disallowedTools = config.disallowedTools;
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      options.mcpServers = config.mcpServers;
    }
    // Pass an SDK-acceptable model alias here. For non-Anthropic providers this is
    // `"sonnet"` (or `"haiku"` for light-mode runs), and the env's
    // `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` rewrites
    // it to the real id on the wire. Without aliasing, Claude Code CLI rejects
    // third-party model ids in its local allowlist check.
    const sdkModel = resolveSdkModelOption(config.llm, { preferLight: config.preferLight });
    if (sdkModel) options.model = sdkModel;
    // Build SDK env: base (Settings UI > AGENT_LLM_* .env > system env) + caller overrides
    const sdkEnv = buildSdkEnv(config.llm);
    options.env = config.env ? { ...sdkEnv, ...config.env } : sdkEnv;
    if (config.resume) options.resume = config.resume;

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const snapshot: AgentSessionSnapshot = {
      sessionId,
      workspaceRoot: config.cwd,
      createdAt: now,
      updatedAt: now,
      taskId: sessionId,
      taskStatus: "running",
      recoverable: false,
      originalPrompt: config.prompt,
      transcriptEntries: [formatSessionTranscriptEntry(`User:\n${config.prompt}`)],
      historyEvents: [{
        title: config.sessionLabel ? `${config.sessionLabel}.start` : "session.start",
        detail: `Starting agent session ${sessionId}`,
        timestamp: now,
        tone: "info",
      }],
      toolEvents: [],
    };

    const sessionStore = config.sessionLabel
      ? new ClaudeCodeSessionStore({ workspaceRoot: config.cwd })
      : null;

    if (sessionStore) {
      await sessionStore.save(snapshot).catch(() => {});
    }

    console.log(`[AgentRuntime] Starting stream for ${config.sessionLabel ?? "unknown"} (cwd: ${config.cwd})`);
    const sdkStream = await this.stream(config.prompt, options);
    console.log(`[AgentRuntime] Stream created, entering message loop…`);

    // Resolve the provider once per run so cost accounting + metrics tagging stay consistent.
    const resolvedProvider = resolveProvider(config.llm);
    const resolvedModel = resolveModel(config.llm, { preferLight: config.preferLight });

    const runStartMs = Date.now();
    const messages: SdkMessage[] = [];
    let fullText = "";
    let sdkSessionId: string | undefined;
    let metrics: AgentRunMetrics | undefined;
    let pendingSaves = 0;
    let lastSaveAt = Date.now();
    // tool_result blocks carry only `tool_use_id`, never `tool_name`. Keep a
    // map populated from the originating `tool_use` blocks so we can attach a
    // human-readable name (Read/Edit/Bash/…) to each tool.output event.
    const toolNameByUseId = new Map<string, string>();

    const flushSnapshot = async () => {
      if (!sessionStore) return;
      snapshot.updatedAt = new Date().toISOString();
      await sessionStore.save(snapshot).catch(() => {});
      lastSaveAt = Date.now();
      pendingSaves = 0;
    };

    // Watchdog: warn if no messages arrive within 30 seconds
    let firstMessageReceived = false;
    const watchdog = setTimeout(() => {
      if (!firstMessageReceived) {
        console.warn(`[AgentRuntime] ⚠️  No messages received after 30s for ${config.sessionLabel ?? "unknown"} — SDK may be stuck`);
      }
    }, 30_000);

    try {
      for await (const message of sdkStream) {
        if (!firstMessageReceived) {
          firstMessageReceived = true;
          clearTimeout(watchdog);
          console.log(`[AgentRuntime] First message received: type=${message.type} subtype=${message.subtype ?? "-"}`);
        }
        messages.push(message);
        onMessage?.(message);

        if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
          sdkSessionId = message.session_id;
          snapshot.sdkSessionId = sdkSessionId;
          snapshot.recoverable = true;
          snapshot.historyEvents.push({
            title: "sdk.init",
            detail: `model=${String(message.model ?? "unknown")} tools=${Array.isArray(message.tools) ? message.tools.length : 0}`,
            timestamp: new Date().toISOString(),
            tone: "info",
          });
          await flushSnapshot();
        }

        if (message.type === "assistant") {
          const text = extractTextFromMessage(message);
          if (text) {
            fullText += text;
            snapshot.transcriptEntries.push(formatSessionTranscriptEntry(`Assistant:\n${text}`));
            pendingSaves++;
          }

          for (const toolCall of extractToolCalls(message)) {
            if (toolCall.toolUseId) {
              toolNameByUseId.set(toolCall.toolUseId, toolCall.name);
            }
            snapshot.toolEvents.push({
              type: "tool.called",
              toolName: toolCall.name,
              args: toolCall.args,
              timestamp: new Date().toISOString(),
            });
            pendingSaves++;
          }
        }

        // Capture tool results (from user messages that contain tool_result blocks)
        if (message.type === "user" || message.type === "tool") {
          for (const tr of extractToolResults(message)) {
            snapshot.toolEvents.push({
              type: "tool.output",
              toolName: toolNameByUseId.get(tr.toolUseId) ?? "tool",
              output: tr.output,
              timestamp: new Date().toISOString(),
            });
            pendingSaves++;
          }
        }

        if (message.type === "result") {
          const resultText = typeof message.result === "string" ? message.result : "";
          if (resultText) fullText += resultText;
          metrics = buildMetricsFromResult(message, resolvedProvider, resolvedModel, runStartMs);
          const isError = message.subtype !== "success";
          snapshot.historyEvents.push({
            title: isError ? "sdk.error" : "sdk.result",
            detail: resultText ? resultText.slice(0, 200) : (message.subtype ?? "unknown"),
            timestamp: new Date().toISOString(),
            tone: isError ? "danger" : "info",
          });
          // Always flush on result (captures errors and completion)
          pendingSaves++;
        }

        // Flush every 5 tool calls / transcript entries, or every 10 seconds
        if (pendingSaves >= 5 || (pendingSaves > 0 && Date.now() - lastSaveAt > 10_000)) {
          await flushSnapshot();
        }
      }
    } catch (err) {
      clearTimeout(watchdog);
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[AgentRuntime] Stream error for ${config.sessionLabel ?? "unknown"}:`, errorMessage);

      // Preserve any metrics already collected from a result message received before the throw.
      // If none were collected (e.g. 402 before any tokens), record durationMs + provider so the
      // session is still identifiable; totalCostUsd stays undefined (not 0) to indicate "unknown".
      metrics = metrics ?? {
        durationMs: Date.now() - runStartMs,
        provider: resolvedProvider,
        model: resolvedModel,
      };

      snapshot.taskStatus = "failed";
      snapshot.lastError = errorMessage;
      snapshot.lastSummary = fullText.slice(0, 500) || undefined;
      snapshot.metrics = metrics;
      snapshot.updatedAt = new Date().toISOString();
      snapshot.historyEvents.push({
        title: "sdk.error",
        detail: errorMessage.slice(0, 200),
        timestamp: snapshot.updatedAt,
        tone: "danger",
      });

      if (sessionStore) {
        await sessionStore.save(snapshot).catch(() => {});
      }

      throw err;
    }

    clearTimeout(watchdog);
    console.log(`[AgentRuntime] Stream ended for ${config.sessionLabel ?? "unknown"}: ${messages.length} messages, ${fullText.length} chars, ${snapshot.toolEvents.length} tool calls`);

    // If a result message was received with a non-success subtype, the run technically
    // completed but with an error — keep taskStatus as "failed" so it's visible in the UI.
    const hadErrorResult = snapshot.historyEvents.some((e) => e.title === "sdk.error");
    snapshot.taskStatus = hadErrorResult ? "failed" : "completed";
    snapshot.lastSummary = fullText.slice(0, 500);
    // Ensure totalCostUsd is always present after a normal stream end (use 0 when neither the
    // SDK reported it nor local estimation produced anything — should be rare).
    metrics = {
      ...(metrics ?? {}),
      durationMs: metrics?.durationMs ?? (Date.now() - runStartMs),
      totalCostUsd: metrics?.totalCostUsd ?? 0,
      provider: metrics?.provider ?? resolvedProvider,
      model: metrics?.model ?? resolvedModel,
    };
    snapshot.metrics = metrics;
    snapshot.updatedAt = new Date().toISOString();
    snapshot.historyEvents.push({
      title: config.sessionLabel ? `${config.sessionLabel}.done` : "session.done",
      detail: `Session ${hadErrorResult ? "failed" : "completed"}. ${snapshot.toolEvents.length} tool calls.`,
      timestamp: snapshot.updatedAt,
      tone: hadErrorResult ? "danger" : "success",
    });

    if (sessionStore) {
      await sessionStore.save(snapshot).catch(() => {});
    }

    return { fullText, messages, sdkSessionId, metrics };
  }
}
