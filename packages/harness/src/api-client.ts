import type {
  ChatCompletionChunk,
  ChatMessage,
  LlmConfig,
  ToolDefinition,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 16384;

export interface StreamRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export class LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly thinking: boolean;
  private readonly reasoningEffort?: string;

  constructor(config: LlmConfig) {
    if (!config.apiKey) {
      throw new Error("API key is required");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = config.model || DEFAULT_MODEL;
    this.maxTokens = config.maxTokens || DEFAULT_MAX_TOKENS;
    this.temperature = config.temperature ?? 0;
    this.thinking = config.thinking ?? false;
    this.reasoningEffort = config.reasoningEffort;
  }

  async *stream(request: StreamRequest): AsyncGenerator<ChatCompletionChunk> {
    const url = `${this.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = "auto";
    }

    if (this.thinking) {
      body.thinking = { type: "enabled" };
      if (this.reasoningEffort) {
        body.reasoning_effort = this.reasoningEffort;
      }
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new LlmApiError(
        `LLM API error ${response.status}: ${errorText}`,
        response.status,
        errorText,
      );
    }

    if (!response.body) {
      throw new LlmApiError("Response body is null", 0, "");
    }

    yield* this.parseSSEStream(response.body);
  }

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<ChatCompletionChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6);
            if (data === "[DONE]") return;

            try {
              const chunk = JSON.parse(data) as ChatCompletionChunk;
              yield chunk;
            } catch {
              // skip malformed JSON
            }
          }
        }
      }

      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
          try {
            const chunk = JSON.parse(trimmed.slice(6)) as ChatCompletionChunk;
            yield chunk;
          } catch {
            // skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export class LlmApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = "LlmApiError";
  }
}
