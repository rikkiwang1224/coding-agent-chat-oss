import type {
  ChatCompletionChunk,
  ChatMessage,
  LlmConfig,
  ToolDefinition,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 16384;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

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
  private readonly responseFormat?: "json_object";
  private readonly maxRetries: number;

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
    this.responseFormat = config.responseFormat;
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
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

    // DeepSeek defaults thinking to enabled — must send explicit disabled when off,
    // otherwise the model burns the output budget on reasoning_content and leaves
    // content empty (breaks JSON-mode sensors like Reason).
    body.thinking = this.thinking ? { type: "enabled" } : { type: "disabled" };
    if (this.thinking && this.reasoningEffort) {
      body.reasoning_effort = this.reasoningEffort;
    }

    if (this.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }

    const response = await this.fetchWithRetry(url, body, request.signal);

    if (!response.body) {
      throw new LlmApiError("Response body is null", 0, "");
    }

    yield* this.parseSSEStream(response.body);
  }

  private async fetchWithRetry(
    url: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new Error("Request aborted");
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        if (response.ok) {
          return response;
        }

        const errorText = await response.text().catch(() => "unknown error");

        if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === this.maxRetries) {
          throw new LlmApiError(
            `LLM API error ${response.status}: ${errorText}`,
            response.status,
            errorText,
          );
        }

        lastError = new LlmApiError(
          `LLM API error ${response.status}: ${errorText}`,
          response.status,
          errorText,
        );

        // Use Retry-After header if available (for 429)
        const retryAfter = response.headers.get("retry-after");
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;

        await this.sleep(delayMs, signal);
      } catch (error) {
        if (error instanceof LlmApiError) throw error;
        if (signal?.aborted) throw error;

        // Network errors (ECONNRESET, ETIMEDOUT, etc.) are retryable
        if (attempt === this.maxRetries) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        await this.sleep(delayMs, signal);
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Request aborted"));
      }, { once: true });
    });
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
