/**
 * Public input/output types for `AgentRuntime.run()`.
 */
import type { SdkMessage } from "./sdk-messages.js";
import type { LlmConfig, LlmProvider } from "./providers.js";

export interface AgentTaskConfig {
  prompt: string;
  cwd: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  permissionMode?: string;
  mcpServers?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  /** LLM config from Settings UI — takes priority over .env */
  llm?: LlmConfig;
  /**
   * Prefer the light model (e.g. Haiku / V4-Flash / GLM-4.5-air) for this run.
   *
   * Set on low-stakes internal tasks so the heavy primary model
   * (Sonnet / V4-Pro) is reserved for work that actually needs it.
   *
   * Implementation: passes `"haiku"` as `options.model` to the Claude Code CLI,
   * which the env's `ANTHROPIC_DEFAULT_HAIKU_MODEL` then rewrites to the
   * provider-specific light model id on the wire.
   */
  preferLight?: boolean;
  signal?: AbortSignal;
  resume?: string;
  /** Extra options passed through to the SDK query() call */
  extra?: Record<string, unknown>;
  /**
   * When provided, a session snapshot is saved to ~/.forgelet/sessions/.
   * Pass a label like "chat" or "codegen" to identify the agent type.
   */
  sessionLabel?: string;
}

export interface AgentTaskResult {
  fullText: string;
  messages: SdkMessage[];
  sdkSessionId?: string;
  metrics?: AgentRunMetrics;
}

/**
 * Per-session metrics persisted on snapshots and returned from `AgentRuntime.run`.
 * `totalCostUsd` is always a number after a normal finish (computed locally when
 * the provider doesn't report it); only `undefined` when the run aborted before
 * any cost was attributable.
 */
export interface AgentRunMetrics {
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  totalCostUsd?: number;
  /** True when totalCostUsd was computed locally from usage+pricing, not from SDK. */
  costIsEstimated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Provider used for the run (preserved so historical snapshots can be repriced). */
  provider?: LlmProvider;
  /** Resolved model id used for the main agent. */
  model?: string;
}
