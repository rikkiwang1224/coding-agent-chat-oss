import type {
  ChatCompletionChunk,
  ChatMessage,
  LlmConfig,
  StreamToolCallDelta,
  ToolCallMessage,
} from "./types.js";
import { LlmClient } from "./api-client.js";
import { TOOL_DEFINITIONS, ToolExecutor } from "./tools/index.js";
import { buildSystemPrompt } from "./prompt.js";

export interface AgentLoopCallbacks {
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>, callId: string) => void;
  onToolResult?: (toolName: string, result: string, ok: boolean, callId: string) => void;
  onTurnStart?: (turnIndex: number) => void;
  onTurnEnd?: (turnIndex: number) => void;
  onComplete?: (summary: string) => void;
  onError?: (error: Error) => void;
}

export interface AgentLoopOptions {
  config: LlmConfig;
  workspaceRoot: string;
  maxTurns?: number;
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
  private readonly signal?: AbortSignal;
  private readonly callbacks: AgentLoopCallbacks;
  private readonly messages: ChatMessage[];

  private turnCount = 0;

  constructor(options: AgentLoopOptions) {
    this.client = new LlmClient(options.config);
    this.executor = new ToolExecutor({ workspaceRoot: options.workspaceRoot });
    this.workspaceRoot = options.workspaceRoot;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.signal = options.signal;
    this.callbacks = options.callbacks;

    this.messages = [
      { role: "system", content: buildSystemPrompt(options.workspaceRoot) },
      ...(options.threadContext || []),
    ];
  }

  async run(userPrompt: string): Promise<{ messages: ChatMessage[]; turnCount: number }> {
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
        return { messages: this.messages, turnCount: this.turnCount };
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
    const stream = this.client.stream({
      messages: this.messages,
      tools: TOOL_DEFINITIONS,
      signal: this.signal,
    });

    let fullContent = "";
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

      // Reasoning content (thinking mode)
      if (delta.reasoning_content) {
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

    // Build the complete assistant message
    const message: ChatMessage = {
      role: "assistant",
      content: fullContent || null,
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
    const results: ChatMessage[] = [];

    for (const toolCall of toolCalls) {
      if (this.signal?.aborted) {
        throw new Error("Agent run cancelled");
      }

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        const errorResult: ChatMessage = {
          role: "tool",
          content: `Error: Failed to parse tool arguments as JSON: ${toolCall.function.arguments}`,
          tool_call_id: toolCall.id,
        };
        results.push(errorResult);
        this.callbacks.onToolResult?.(toolCall.function.name, errorResult.content!, false, toolCall.id);
        continue;
      }

      const executionResult = await this.executor.execute(toolCall.function.name, args);

      const resultMessage: ChatMessage = {
        role: "tool",
        content: executionResult.output,
        tool_call_id: toolCall.id,
      };
      results.push(resultMessage);

      this.callbacks.onToolResult?.(
        toolCall.function.name,
        executionResult.output,
        executionResult.ok,
        toolCall.id,
      );
    }

    return results;
  }
}
