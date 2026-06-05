import type {
  ChatCompletionChunk,
  ChatMessage,
  LlmConfig,
  StreamToolCallDelta,
  ToolCallMessage,
} from "./types.js";
import { LlmClient } from "./api-client.js";
import { buildToolDefinitions } from "./code-graph/index.js";
import type { CodebaseMemoryClient } from "./code-graph/codebase-memory.js";
import { ToolExecutor } from "./tools/index.js";
import type { ToolDefinition } from "./types.js";
import { buildSystemPrompt, type PromptContext } from "./prompt.js";
import { ContextCompressor, estimateTokens } from "./context-compressor.js";
import type { HarnessHooks } from "./hooks.js";
import type { PermissionGuard, PermissionCallback } from "./permissions.js";
import { buildActivityDigest } from "./activity-digest.js";
import { runReason, formatReasonFeedback, type ReasonResult } from "./reason.js";

export interface AgentLoopCallbacks {
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>, callId: string) => void;
  onToolResult?: (toolName: string, result: string, ok: boolean, callId: string) => void;
  onTurnStart?: (turnIndex: number) => void;
  onTurnEnd?: (turnIndex: number) => void;
  onUsageUpdate?: (usage: TokenUsage) => void;
  onComplete?: (summary: string) => void;
  onError?: (error: Error) => void;
  /** Fired when the Reason sensor returns a verdict (only when reason hook enabled). */
  onReasonVerdict?: (round: number, result: ReasonResult) => void;
}

/**
 * Reason sensor configuration. When enabled, the agent loop invokes an
 * independent LLM "code reviewer" before declaring a run completed. If the
 * reviewer says "revise", its feedback is injected as a user message and
 * the agent loop continues. See `reason.ts` for the rationale.
 */
export interface ReasonHookConfig {
  enabled: boolean;
  /**
   * Original task / issue text the agent is trying to solve. Can be a
   * static string or a function for callers that mutate the issue across
   * runs (e.g. interactive CLI: each user prompt becomes a fresh issue).
   */
  issueText: string | (() => string);
  /**
   * Returns the current diff (e.g. `git diff HEAD`) so the sensor can see
   * what the agent actually changed. Should return "" if no diff.
   */
  getCurrentDiff: () => Promise<string>;
  /** Max number of revise→retry cycles before forcing completion. Default 2. */
  maxRounds?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * Sum of `prompt_cache_hit_tokens` across all turns (DeepSeek-style
   * automatic prefix caching). These tokens are still counted in
   * `inputTokens` (server-reported `prompt_tokens` is the full prompt size)
   * but are billed at the cache-read rate by the provider, so the cost
   * estimator subtracts the discount when populating `totalCostUsd`.
   *
   * For Anthropic-style explicit cache_control caching, see the cache-
   * creation / cache-read split surfaced via the same field.
   */
  cacheReadInputTokens?: number;
}

/** Why the agent loop returned to its caller. */
export type AgentLoopStopReason = "completed" | "max_turns";

export interface AgentLoopResult {
  messages: ChatMessage[];
  turnCount: number;
  tokenUsage: TokenUsage;
  /**
   * Why the loop stopped. `completed` means the model produced an assistant
   * message with no tool_calls (natural finish). `max_turns` means the loop
   * exhausted its turn budget — partial work is still in `messages`.
   */
  stopReason: AgentLoopStopReason;
  /** Number of Reason sensor rounds invoked (0 if hook disabled). */
  reasonRoundsUsed?: number;
  /** Verdicts produced by the Reason sensor, in order. */
  reasonVerdicts?: ReasonResult[];
  /** Number of exploration nudges injected (0 if guard disabled or never triggered). */
  explorationNudges?: number;
}

export interface AgentLoopOptions {
  config: LlmConfig;
  workspaceRoot: string;
  promptContext?: PromptContext;
  maxTurns?: number;
  maxTokens?: number;
  maxContextTokens?: number;
  signal?: AbortSignal;
  callbacks: AgentLoopCallbacks;
  /** @deprecated Prefer initialMessages for resume */
  threadContext?: ChatMessage[];
  /** Restored conversation (e.g. from SessionStore on resume) */
  initialMessages?: ChatMessage[];
  onMessagesChanged?: (messages: ChatMessage[]) => void;
  sessionId?: string;
  permissionGuard?: PermissionGuard;
  onPermissionConfirm?: PermissionCallback;
  hooks?: HarnessHooks;
  /** Reason-as-Sensor configuration (independent reviewer before completion). */
  reason?: ReasonHookConfig;
  /**
   * Max consecutive read-only turns before injecting a nudge message telling
   * the agent to stop exploring and start editing. Set to `false` to disable.
   * Default: 15.
   */
  explorationBudget?: number | false;
  /**
   * Path patterns that block write operations. Passed through to ToolExecutor.
   * Used by SWE-bench to prevent editing test files.
   */
  protectedPathPatterns?: string[];
  /** When set, registers code_graph_* tools and wires the CLI client. */
  codeGraph?: CodebaseMemoryClient;
}

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_REASON_ROUNDS = 2;
const DEFAULT_EXPLORATION_BUDGET = 15;
const MAX_EXPLORATION_NUDGES = 2;

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "grep_search",
  "list_directory",
  "glob_search",
  "todo_write",
  "code_graph_architecture",
  "code_graph_search",
  "code_graph_trace",
  "code_graph_impact",
  "code_graph_semantic_search",
  "code_graph_code_search",
  "code_graph_snippet",
]);

export class AgentLoop {
  private readonly client: LlmClient;
  private readonly executor: ToolExecutor;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly workspaceRoot: string;
  private readonly maxTurns: number;
  private readonly maxTotalTokens: number;
  private readonly compressor: ContextCompressor;
  private readonly signal?: AbortSignal;
  private readonly callbacks: AgentLoopCallbacks;
  private readonly onMessagesChanged?: (messages: ChatMessage[]) => void;
  /** LLM config stored so the Reason sensor can reuse the same provider/model. */
  private readonly llmConfig: LlmConfig;
  private readonly reason?: ReasonHookConfig;
  private readonly reasonMaxRounds: number;
  private messages: ChatMessage[];

  private turnCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadInputTokens = 0;
  private reasonRoundsUsed = 0;
  private readonly reasonVerdicts: ReasonResult[] = [];
  private consecutiveReadOnlyTurns = 0;
  private nudgesInjected = 0;
  private readonly explorationBudget: number | false;
  /** Provider's reported `prompt_tokens` from the most recent turn — used to
   * size context compression off the real tokenizer rather than our heuristic. */
  private lastPromptTokens = 0;

  constructor(options: AgentLoopOptions) {
    this.llmConfig = options.config;
    this.client = new LlmClient(options.config);
    const codeGraphEnabled = Boolean(options.codeGraph);
    this.toolDefinitions = buildToolDefinitions(codeGraphEnabled);
    this.executor = new ToolExecutor({
      workspaceRoot: options.workspaceRoot,
      permissionGuard: options.permissionGuard,
      onPermissionConfirm: options.onPermissionConfirm,
      hooks: options.hooks,
      sessionId: options.sessionId,
      protectedPathPatterns: options.protectedPathPatterns,
      codeGraph: options.codeGraph,
    });
    this.workspaceRoot = options.workspaceRoot;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxTotalTokens = options.maxTokens ?? Infinity;
    this.compressor = new ContextCompressor({
      config: options.config,
      maxContextTokens: options.maxContextTokens,
    });
    this.signal = options.signal;
    this.callbacks = options.callbacks;
    this.onMessagesChanged = options.onMessagesChanged;
    this.reason = options.reason?.enabled ? options.reason : undefined;
    this.reasonMaxRounds = options.reason?.maxRounds ?? DEFAULT_REASON_ROUNDS;
    this.explorationBudget = options.explorationBudget !== false
      ? (options.explorationBudget ?? DEFAULT_EXPLORATION_BUDGET)
      : false;

    if (options.initialMessages && options.initialMessages.length > 0) {
      this.messages = [...options.initialMessages];
    } else {
      this.messages = [
        { role: "system", content: buildSystemPrompt(options.promptContext ?? options.workspaceRoot) },
        ...(options.threadContext || []),
      ];
    }
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  destroy(): void {
    this.executor.destroy();
  }

  private notifyMessagesChanged(): void {
    this.onMessagesChanged?.(this.messages);
  }

  async run(userPrompt: string): Promise<AgentLoopResult> {
    this.messages.push({ role: "user", content: userPrompt });
    this.notifyMessagesChanged();

    while (this.turnCount < this.maxTurns) {
      if (this.signal?.aborted) {
        throw new Error("Agent run cancelled");
      }

      this.turnCount++;
      this.callbacks.onTurnStart?.(this.turnCount);

      const assistantMessage = await this.executeTurn();
      this.messages.push(assistantMessage);
      this.notifyMessagesChanged();

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // No tool calls — the model thinks it's done. Before we accept that,
        // consult the Reason sensor (LLM reviewer) if enabled.
        this.callbacks.onTurnEnd?.(this.turnCount);

        const reviseFeedback = await this.maybeRunReason();
        if (reviseFeedback) {
          this.messages.push({ role: "user", content: reviseFeedback });
          this.notifyMessagesChanged();
          continue;
        }

        const finalText = assistantMessage.content || "";
        this.callbacks.onComplete?.(finalText);
        this.notifyMessagesChanged();
        return this.buildResult("completed");
      }

      // Execute all tool calls and add results
      const toolResults = await this.executeToolCalls(assistantMessage.tool_calls);
      for (const result of toolResults) {
        this.messages.push(result);
      }
      this.notifyMessagesChanged();

      // Exploration budget guard: detect consecutive read-only turns
      if (this.explorationBudget !== false) {
        const allReadOnly = assistantMessage.tool_calls.every(
          (tc) => READ_ONLY_TOOLS.has(tc.function.name),
        );
        if (allReadOnly) {
          this.consecutiveReadOnlyTurns++;
        } else {
          this.consecutiveReadOnlyTurns = 0;
        }

        if (
          this.consecutiveReadOnlyTurns >= this.explorationBudget &&
          this.nudgesInjected < MAX_EXPLORATION_NUDGES
        ) {
          this.nudgesInjected++;
          this.consecutiveReadOnlyTurns = 0;
          const nudge =
            `[System] You have spent ${this.explorationBudget} consecutive turns ` +
            `reading/searching. Based on your exploration so far, please take action: ` +
            `if the task requires code changes, attempt a minimal edit now — you can iterate after seeing results. ` +
            `If the task is a question, summarize your findings and answer now. ` +
            `Do not continue exploring files you have already seen or directories you have already listed.`;
          this.messages.push({ role: "user", content: nudge });
          this.notifyMessagesChanged();
        }
      }

      this.callbacks.onTurnEnd?.(this.turnCount);
    }

    // Max turns reached — return whatever the agent produced so far instead of
    // throwing. Callers should treat this as a "budget exceeded" terminal state,
    // not a hard error: the partial work (patches, file edits) is still useful.
    return this.buildResult("max_turns");
  }

  private buildResult(stopReason: AgentLoopStopReason): AgentLoopResult {
    return {
      messages: this.messages,
      turnCount: this.turnCount,
      tokenUsage: {
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
        totalTokens: this.totalInputTokens + this.totalOutputTokens,
        cacheReadInputTokens: this.totalCacheReadInputTokens || undefined,
      },
      stopReason,
      reasonRoundsUsed: this.reason ? this.reasonRoundsUsed : undefined,
      reasonVerdicts: this.reason && this.reasonVerdicts.length > 0 ? this.reasonVerdicts : undefined,
      explorationNudges: this.nudgesInjected || undefined,
    };
  }

  /**
   * Run the Reason sensor (if enabled and budget remains).
   * Returns the revise-feedback string to inject as a user message, or null
   * if the sensor said ship (or is disabled / out of budget).
   *
   * Token usage from the sensor call is accumulated into the agent's totals
   * so cost reports stay accurate.
   */
  private async maybeRunReason(): Promise<string | null> {
    if (!this.reason) return null;
    if (this.reasonRoundsUsed >= this.reasonMaxRounds) return null;
    if (this.signal?.aborted) return null;

    this.reasonRoundsUsed++;
    const round = this.reasonRoundsUsed;

    let currentDiff = "";
    try {
      currentDiff = await this.reason.getCurrentDiff();
    } catch {
      // diff unavailable — sensor still runs with an empty diff. The prompt
      // tells it to always REVISE if diff is empty + issue non-trivial.
    }

    const digest = buildActivityDigest(this.messages);
    const issueText =
      typeof this.reason.issueText === "function" ? this.reason.issueText() : this.reason.issueText;
    const result = await runReason(
      { issueText, currentDiff, digest },
      { config: this.llmConfig, signal: this.signal },
    );

    this.reasonVerdicts.push(result);
    this.callbacks.onReasonVerdict?.(round, result);

    if (result.tokenUsage) {
      this.totalInputTokens += result.tokenUsage.inputTokens;
      this.totalOutputTokens += result.tokenUsage.outputTokens;
      this.totalCacheReadInputTokens += result.tokenUsage.cacheReadInputTokens ?? 0;
      this.callbacks.onUsageUpdate?.({
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
        totalTokens: this.totalInputTokens + this.totalOutputTokens,
        cacheReadInputTokens: this.totalCacheReadInputTokens || undefined,
      });
    }

    if (result.verdict === "ship") return null;
    // At the budget cap, even a "revise" verdict ships: injecting feedback
    // now would produce work we have no budget left to re-review. The verdict
    // is still recorded in `reasonVerdicts` for trace analysis.
    if (this.reasonRoundsUsed >= this.reasonMaxRounds) return null;
    return formatReasonFeedback(result, round);
  }

  private async executeTurn(): Promise<ChatMessage> {
    // Compress context if it's getting too long. Use the provider's reported
    // `prompt_tokens` from the previous turn (if any) as the source of truth
    // for token size; falls back to the character heuristic on the first turn.
    if (this.compressor.shouldCompress(this.messages, this.lastPromptTokens)) {
      this.messages = await this.compressor.compress(
        this.messages,
        this.signal,
        this.lastPromptTokens,
      );
    }

    const stream = this.client.stream({
      messages: this.messages,
      tools: this.toolDefinitions,
      signal: this.signal,
    });

    let fullContent = "";
    let fullReasoning = "";
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let lastUsage: ChatCompletionChunk["usage"] | undefined;

    for await (const chunk of stream) {
      if (this.signal?.aborted) {
        throw new Error("Agent run cancelled");
      }

      const choice = chunk.choices?.[0];
      if (!choice) {
        if (chunk.usage) lastUsage = chunk.usage;
        continue;
      }

      const delta = choice.delta;

      // Text content streaming
      if (delta.content) {
        fullContent += delta.content;
        this.callbacks.onTextDelta?.(delta.content);
      }

      // Reasoning content (thinking mode) — must be preserved and passed back
      if (delta.reasoning_content) {
        fullReasoning += delta.reasoning_content;
        this.callbacks.onReasoningDelta?.(delta.reasoning_content);
      }

      // Tool call streaming — accumulate function name and arguments
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          this.accumulateToolCall(toolCalls, tc);
        }
      }

      if (chunk.usage) lastUsage = chunk.usage;
    }

    // Track token usage
    if (lastUsage) {
      this.totalInputTokens += lastUsage.prompt_tokens || 0;
      this.totalOutputTokens += lastUsage.completion_tokens || 0;
      this.totalCacheReadInputTokens += lastUsage.prompt_cache_hit_tokens || 0;
      this.lastPromptTokens = lastUsage.prompt_tokens || this.lastPromptTokens;
      this.callbacks.onUsageUpdate?.({
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
        totalTokens: this.totalInputTokens + this.totalOutputTokens,
        cacheReadInputTokens: this.totalCacheReadInputTokens || undefined,
      });

      // Check budget
      if (this.totalInputTokens + this.totalOutputTokens > this.maxTotalTokens) {
        throw new Error(
          `Token budget exceeded: ${this.totalInputTokens + this.totalOutputTokens} > ${this.maxTotalTokens}`,
        );
      }
    }

    // Build the complete assistant message
    const message: ChatMessage = {
      role: "assistant",
      content: fullContent || null,
      reasoning_content: fullReasoning || undefined,
    };

    if (toolCalls.size > 0) {
      message.tool_calls = Array.from(toolCalls.values()).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

      // Emit tool call events
      for (const tc of message.tool_calls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch {
          parsedArgs = { _raw: tc.function.arguments };
        }
        this.callbacks.onToolCall?.(tc.function.name, parsedArgs, tc.id);
      }
    }

    return message;
  }

  private accumulateToolCall(
    map: Map<number, { id: string; name: string; arguments: string }>,
    delta: StreamToolCallDelta,
  ): void {
    const existing = map.get(delta.index);

    if (existing) {
      if (delta.function?.name) {
        existing.name += delta.function.name;
      }
      if (delta.function?.arguments) {
        existing.arguments += delta.function.arguments;
      }
    } else {
      map.set(delta.index, {
        id: delta.id || `call_${delta.index}_${Date.now()}`,
        name: delta.function?.name || "",
        arguments: delta.function?.arguments || "",
      });
    }
  }

  private async executeToolCalls(toolCalls: ToolCallMessage[]): Promise<ChatMessage[]> {
    if (this.signal?.aborted) {
      throw new Error("Agent run cancelled");
    }

    // Separate tool calls into parallelizable and sequential groups.
    // Any tool that mutates the workspace or shared state must run in the order
    // the model produced it; only read-only tools are eligible for parallel
    // execution. `todo_write` is in-memory state and naturally serializable —
    // we keep it sequential for predictable per-call output ordering.
    const SEQUENTIAL_TOOLS = new Set([
      "bash",
      "run_command",
      "write_file",
      "edit_file",
      "multi_edit",
      "apply_patch",
      "todo_write",
    ]);

    // Strategy: run all read-only tools in parallel, then sequential tools in order
    const parallel: { index: number; toolCall: ToolCallMessage }[] = [];
    const sequential: { index: number; toolCall: ToolCallMessage }[] = [];

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (SEQUENTIAL_TOOLS.has(tc.function.name)) {
        sequential.push({ index: i, toolCall: tc });
      } else {
        parallel.push({ index: i, toolCall: tc });
      }
    }

    const results: (ChatMessage | null)[] = new Array(toolCalls.length).fill(null);

    // Execute parallelizable tools concurrently
    if (parallel.length > 0) {
      const parallelResults = await Promise.all(
        parallel.map(({ index, toolCall }) =>
          this.executeSingleTool(toolCall).then((msg) => ({ index, msg })),
        ),
      );
      for (const { index, msg } of parallelResults) {
        results[index] = msg;
      }
    }

    // Execute sequential tools in order
    for (const { index, toolCall } of sequential) {
      if (this.signal?.aborted) throw new Error("Agent run cancelled");
      results[index] = await this.executeSingleTool(toolCall);
    }

    return results.filter((r): r is ChatMessage => r !== null);
  }

  private async executeSingleTool(toolCall: ToolCallMessage): Promise<ChatMessage> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      const content = `Error: Failed to parse tool arguments as JSON: ${toolCall.function.arguments}`;
      this.callbacks.onToolResult?.(toolCall.function.name, content, false, toolCall.id);
      return { role: "tool", content, tool_call_id: toolCall.id };
    }

    const executionResult = await this.executor.execute(
      toolCall.function.name,
      args,
      this.signal,
    );

    this.callbacks.onToolResult?.(
      toolCall.function.name,
      executionResult.output,
      executionResult.ok,
      toolCall.id,
    );

    return {
      role: "tool",
      content: executionResult.output,
      tool_call_id: toolCall.id,
    };
  }
}
