import type {
  ChatCompletionChunk,
  ChatMessage,
  LlmConfig,
  StreamToolCallDelta,
  ToolCallMessage,
} from "./types.js";
import { LlmClient } from "./api-client.js";
import { TOOL_DEFINITIONS, ToolExecutor } from "./tools/index.js";
import { buildSystemPrompt, type PromptContext } from "./prompt.js";
import { ContextCompressor, estimateTokens } from "./context-compressor.js";

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
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
  threadContext?: ChatMessage[];
}

const DEFAULT_MAX_TURNS = 50;

export class AgentLoop {
  private readonly client: LlmClient;
  private readonly executor: ToolExecutor;
  private readonly workspaceRoot: string;
  private readonly maxTurns: number;
  private readonly maxTotalTokens: number;
  private readonly compressor: ContextCompressor;
  private readonly signal?: AbortSignal;
  private readonly callbacks: AgentLoopCallbacks;
  private messages: ChatMessage[];

  private turnCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  constructor(options: AgentLoopOptions) {
    this.client = new LlmClient(options.config);
    this.executor = new ToolExecutor({ workspaceRoot: options.workspaceRoot });
    this.workspaceRoot = options.workspaceRoot;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxTotalTokens = options.maxTokens ?? Infinity;
    this.compressor = new ContextCompressor({
      config: options.config,
      maxContextTokens: options.maxContextTokens,
    });
    this.signal = options.signal;
    this.callbacks = options.callbacks;

    this.messages = [
      { role: "system", content: buildSystemPrompt(options.promptContext ?? options.workspaceRoot) },
      ...(options.threadContext || []),
    ];
  }

  destroy(): void {
    this.executor.destroy();
  }

  async run(userPrompt: string): Promise<{ messages: ChatMessage[]; turnCount: number; tokenUsage: TokenUsage }> {
    this.messages.push({ role: "user", content: userPrompt });

    while (this.turnCount < this.maxTurns) {
      if (this.signal?.aborted) {
        throw new Error("Agent run cancelled");
      }

      this.turnCount++;
      this.callbacks.onTurnStart?.(this.turnCount);

      const assistantMessage = await this.executeTurn();
      this.messages.push(assistantMessage);

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // No tool calls — the model is done
        this.callbacks.onTurnEnd?.(this.turnCount);
        const finalText = assistantMessage.content || "";
        this.callbacks.onComplete?.(finalText);
        return {
          messages: this.messages,
          turnCount: this.turnCount,
          tokenUsage: {
            inputTokens: this.totalInputTokens,
            outputTokens: this.totalOutputTokens,
            totalTokens: this.totalInputTokens + this.totalOutputTokens,
          },
        };
      }

      // Execute all tool calls and add results
      const toolResults = await this.executeToolCalls(assistantMessage.tool_calls);
      for (const result of toolResults) {
        this.messages.push(result);
      }

      this.callbacks.onTurnEnd?.(this.turnCount);
    }

    throw new Error(`Agent exceeded max turns (${this.maxTurns})`);
  }

  private async executeTurn(): Promise<ChatMessage> {
    // Compress context if it's getting too long
    if (this.compressor.shouldCompress(this.messages)) {
      this.messages = await this.compressor.compress(this.messages, this.signal);
    }

    const stream = this.client.stream({
      messages: this.messages,
      tools: TOOL_DEFINITIONS,
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
      this.callbacks.onUsageUpdate?.({
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
        totalTokens: this.totalInputTokens + this.totalOutputTokens,
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

    // Separate tool calls into parallelizable and sequential groups
    const SEQUENTIAL_TOOLS = new Set(["bash", "run_command", "write_file", "edit_file"]);

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

    const executionResult = await this.executor.execute(toolCall.function.name, args);

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
