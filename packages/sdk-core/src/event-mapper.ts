import type {
  AgentRunMetrics,
  AgentTaskStatus,
  AgentTerminalReason,
  AgentToolMetadata
} from "@forgelet/shared-types";
import type { AgentSessionHistoryEvent } from "./session-types.js";

export interface ClaudeCodeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}

export interface ClaudeCodeConversationMessage {
  role?: string;
  content?: ClaudeCodeContentBlock[];
}

export interface ClaudeCodeAssistantMessage {
  type: "assistant";
  session_id: string;
  message?: ClaudeCodeConversationMessage;
}

export interface ClaudeCodeUserMessage {
  type: "user";
  session_id: string;
  message?: ClaudeCodeConversationMessage;
}

export interface ClaudeCodeSystemInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd?: string;
  tools?: string[];
  model?: string;
  permissionMode?: string;
}

export interface ClaudeCodeResultMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | string;
  session_id: string;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  result?: string;
  total_cost_usd?: number;
}

export type ClaudeCodeSdkMessage =
  | ClaudeCodeAssistantMessage
  | ClaudeCodeUserMessage
  | ClaudeCodeSystemInitMessage
  | ClaudeCodeResultMessage
  | Record<string, unknown>;

export interface MappedToolCall {
  toolUseId?: string;
  toolName: string;
  args: Record<string, unknown>;
  metadata: AgentToolMetadata;
}

export interface MappedToolResult {
  toolUseId?: string;
  output: string;
  isError: boolean;
}

export interface MappedClaudeCodeMessage {
  sessionId?: string;
  init?: {
    model?: string;
    cwd?: string;
    tools: string[];
    permissionMode?: string;
  };
  deltas: string[];
  toolCalls: MappedToolCall[];
  toolResults: MappedToolResult[];
  transcriptEntries: string[];
  historyEvents: AgentSessionHistoryEvent[];
  result?: {
    status: Extract<AgentTaskStatus, "completed" | "failed">;
    recoverable: boolean;
    summary?: string;
    error?: string;
    terminalReason: AgentTerminalReason;
    metrics: AgentRunMetrics;
  };
}

export function mapClaudeCodeSdkMessage(input: ClaudeCodeSdkMessage): MappedClaudeCodeMessage {
  if (isSystemInitMessage(input)) {
    return {
      sessionId: input.session_id,
      init: {
        model: input.model,
        cwd: input.cwd,
        tools: Array.isArray(input.tools) ? input.tools : [],
        permissionMode: input.permissionMode
      },
      deltas: [],
      toolCalls: [],
      toolResults: [],
      transcriptEntries: [],
      historyEvents: [
        {
          title: "sdk.init",
          detail: `model=${input.model ?? "unknown"} cwd=${input.cwd ?? "unknown"}`,
          tone: "info"
        }
      ]
    };
  }

  if (isAssistantMessage(input)) {
    const blocks = Array.isArray(input.message?.content) ? input.message.content : [];
    const toolCalls = blocks
      .filter((block): block is ClaudeCodeContentBlock => block.type === "tool_use" && typeof block.name === "string")
      .map((block) => ({
        toolUseId: block.id,
        toolName: block.name ?? "tool",
        args: isRecord(block.input) ? block.input : {},
        metadata: {
          name: block.name ?? "tool",
          displayName: block.name ?? "tool",
          description: "Claude Code SDK tool"
        }
      }));

    const textParts = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "");
    const assistantText = textParts.join("");

    return {
      sessionId: input.session_id,
      deltas: textParts,
      toolCalls,
      toolResults: [],
      transcriptEntries: assistantText ? [`Assistant:\n${assistantText}`] : [],
      historyEvents: toolCalls.map((call) => ({
        title: "tool.called",
        detail: call.toolName,
        tone: "info"
      }))
    };
  }

  if (isUserMessage(input)) {
    const blocks = Array.isArray(input.message?.content) ? input.message.content : [];
    const toolResults = blocks
      .filter((block): block is ClaudeCodeContentBlock => block.type === "tool_result")
      .map((block) => ({
        toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        output: stringifyToolResultContent(block.content),
        isError: block.is_error === true
      }));

    return {
      sessionId: input.session_id,
      deltas: [],
      toolCalls: [],
      toolResults,
      transcriptEntries: toolResults.map((result) =>
        `${result.isError ? "Tool error" : "Tool output"}:\n${result.output}`
      ),
      historyEvents: toolResults.map((result) => ({
        title: result.isError ? "tool.error" : "tool.output",
        detail: truncateText(result.output, 240),
        tone: result.isError ? "danger" : "success"
      }))
    };
  }

  if (isResultMessage(input)) {
    const isSuccess = input.subtype === "success" && input.is_error !== true;
    const summary = typeof input.result === "string" && input.result.trim() ? input.result : undefined;
    const error =
      !isSuccess && typeof input.result === "string" && input.result.trim()
        ? input.result
        : !isSuccess
          ? `Claude Code SDK run ended with ${input.subtype}`
          : undefined;

    return {
      sessionId: input.session_id,
      deltas: [],
      toolCalls: [],
      toolResults: [],
      transcriptEntries: summary ? [`Result:\n${summary}`] : [],
      historyEvents: [
        {
          title: isSuccess ? "agent.done" : "agent.error",
          detail: isSuccess ? "Claude Code SDK run completed" : error ?? "Claude Code SDK run failed",
          tone: isSuccess ? "success" : "danger"
        }
      ],
      result: {
        status: isSuccess ? "completed" : "failed",
        recoverable: Boolean(input.session_id),
        summary,
        error,
        terminalReason: isSuccess ? "completed" : "failed_terminal",
        metrics: {
          durationMs: input.duration_ms,
          durationApiMs: input.duration_api_ms,
          numTurns: input.num_turns,
          totalCostUsd: input.total_cost_usd
        }
      }
    };
  }

  return {
    deltas: [],
    toolCalls: [],
    toolResults: [],
    transcriptEntries: [],
    historyEvents: []
  };
}

function isSystemInitMessage(input: ClaudeCodeSdkMessage): input is ClaudeCodeSystemInitMessage {
  return input.type === "system" && input.subtype === "init";
}

function isAssistantMessage(input: ClaudeCodeSdkMessage): input is ClaudeCodeAssistantMessage {
  return input.type === "assistant";
}

function isUserMessage(input: ClaudeCodeSdkMessage): input is ClaudeCodeUserMessage {
  return input.type === "user";
}

function isResultMessage(input: ClaudeCodeSdkMessage): input is ClaudeCodeResultMessage {
  return input.type === "result";
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (isRecord(entry) && typeof entry.text === "string") {
          return entry.text;
        }
        return safeStringify(entry);
      })
      .filter(Boolean);

    return textParts.join("\n");
  }

  return safeStringify(content);
}

function truncateText(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }

  return `${input.slice(0, maxLength).trimEnd()}...`;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
