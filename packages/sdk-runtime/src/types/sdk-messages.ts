/**
 * Types mirroring the Claude Agent SDK's wire format. Kept loose (`[key: string]: unknown`)
 * so we don't break when the SDK adds new fields.
 */

/** Token-level usage reported in SDK result messages (mirrors Anthropic shape). */
export interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Per-model usage breakdown returned in `SDKResultMessage.modelUsage`.
 * Uses camelCase to match the SDK's actual ModelUsage type. All fields are
 * optional because translation layers (custom proxies) sometimes
 * omit fields they don't track.
 */
export interface SdkModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  /** SDK's own cost estimate for this model. Often wrong for aggregators. */
  costUSD?: number;
}

export interface SdkMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  tools?: string[];
  model?: string;
  content?: unknown;
  message?: { content?: unknown };
  event?: Record<string, unknown>;
  total_cost_usd?: number;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: SdkUsage;
  modelUsage?: Record<string, SdkModelUsage>;
  [key: string]: unknown;
}

/** Shape of the SDK's `query()` function, captured here to keep the runtime decoupled. */
export type SdkQueryFn = (input: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<SdkMessage>;
