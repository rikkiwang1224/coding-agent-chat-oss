/**
 * Provider env-resolution: turn an `LlmConfig` (+ process env + preset defaults)
 * into the environment variables the Claude Agent SDK reads.
 *
 * Pure functions — no side effects beyond reading `process.env`.
 */
import type { LlmConfig, LlmProvider } from "../types/providers.js";
import { isClaudeAttributionEnabled } from "../project-settings.js";
import { PROVIDER_PRESETS } from "./presets.js";

function trim(v: string | undefined): string | undefined {
  return v?.trim() || undefined;
}

/**
 * Resolve the LLM provider preset.
 * Priority: explicit llm.provider > AGENT_LLM_PROVIDER env > "anthropic" default.
 */
export function resolveProvider(llm?: LlmConfig): LlmProvider {
  const raw = (llm?.provider ?? process.env.AGENT_LLM_PROVIDER ?? "anthropic").trim().toLowerCase();
  if (
    raw === "anthropic" ||
    raw === "deepseek" ||
    raw === "kimi" ||
    raw === "glm" ||
    raw === "bedrock" ||
    raw === "vertex" ||
    raw === "custom"
  ) {
    return raw;
  }
  return "anthropic";
}

/**
 * Resolve the value to pass as `options.model` to the Claude Agent SDK.
 *
 * Claude Code CLI v2.x validates `options.model` against an internal allowlist:
 * it only accepts the aliases `sonnet` / `opus` / `haiku` or `claude-*` ids,
 * and rejects anything else with "model may not exist or you may not have access"
 * — *before any HTTP request leaves the process*. So for third-party providers
 * (DeepSeek, Kimi, GLM, …) we MUST send `"sonnet"` here and let the
 * env's `ANTHROPIC_DEFAULT_SONNET_MODEL` rewrite it to the real id on the wire.
 *
 * For native Anthropic + Bedrock + Vertex we pass the explicit id through so the
 * user can pin a specific Claude version.
 */
export function resolveSdkModelOption(
  llm?: LlmConfig,
  opts?: { preferLight?: boolean },
): string | undefined {
  const provider = resolveProvider(llm);
  const isAnthropicNative = provider === "anthropic" || provider === "bedrock" || provider === "vertex";
  // Light-mode path: always pass the "haiku" alias and let the SDK env
  // (ANTHROPIC_DEFAULT_HAIKU_MODEL) rewrite it to the provider's light model.
  // Works for both native Anthropic and third-party Anthropic-compatible providers.
  if (opts?.preferLight) return "haiku";
  if (isAnthropicNative) {
    return trim(llm?.primaryModel) ?? trim(process.env.ANTHROPIC_MODEL) ?? trim(process.env.AGENT_LLM_MODEL);
  }
  return "sonnet";
}

/**
 * Resolve the model id given a config.
 * - Default: primary model (Settings UI > ANTHROPIC_MODEL > AGENT_LLM_MODEL > preset default).
 * - When `opts.preferLight`: light model (Settings UI > preset default light > falls back to primary).
 *
 * Used both for displaying the configured model in metrics and for env construction.
 */
export function resolveModel(
  llm?: LlmConfig,
  opts?: { preferLight?: boolean },
): string | undefined {
  const provider = resolveProvider(llm);
  const preset =
    provider in PROVIDER_PRESETS
      ? PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS]
      : undefined;
  if (opts?.preferLight) {
    return trim(llm?.lightModel) ?? preset?.defaultLightModel ?? resolveModel(llm);
  }
  return (
    trim(llm?.primaryModel)
    ?? trim(process.env.ANTHROPIC_MODEL)
    ?? trim(process.env.AGENT_LLM_MODEL)
    ?? preset?.defaultPrimaryModel
  );
}

/**
 * Build SDK env.
 * Priority: Settings UI (llm param) > AGENT_LLM_* .env > ANTHROPIC_* system env > provider preset
 *
 * Beyond `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`, we also emit
 * `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`
 * so third-party Anthropic-compatible endpoints (DeepSeek, etc.) can route Claude Code's internal
 * Sonnet/Opus/Haiku references to their equivalent models.
 */
export function buildSdkEnv(llm?: LlmConfig): Record<string, string | undefined> {
  const provider = resolveProvider(llm);
  const preset =
    provider in PROVIDER_PRESETS
      ? PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS]
      : undefined;

  const envToken = trim(process.env.AGENT_LLM_API_TOKEN);
  const envBaseUrl = trim(process.env.AGENT_LLM_BASE_URL);
  const envModel = trim(process.env.AGENT_LLM_MODEL);

  const apiKey = trim(llm?.apiKey) ?? trim(process.env.ANTHROPIC_API_KEY) ?? envToken;
  const baseUrl =
    trim(llm?.baseUrl)
    ?? trim(process.env.ANTHROPIC_BASE_URL)
    ?? envBaseUrl
    ?? preset?.baseUrl;
  // The variable names below are deliberately Anthropic-flavoured because they
  // map 1:1 to the env vars the Claude Code CLI reads
  // (ANTHROPIC_DEFAULT_SONNET_MODEL / ANTHROPIC_DEFAULT_HAIKU_MODEL). On the
  // wire those names persist; in our codebase we use `primaryModel` / `lightModel`
  // to stay vendor-neutral.
  const primaryModel =
    trim(llm?.primaryModel)
    ?? trim(process.env.ANTHROPIC_MODEL)
    ?? envModel
    ?? preset?.defaultPrimaryModel;
  const lightModel = trim(llm?.lightModel) ?? preset?.defaultLightModel ?? primaryModel;

  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: primaryModel,
    // Claude Code reads these to route built-in Sonnet/Opus/Haiku references to provider-specific
    // model ids. Required for DeepSeek / Kimi / GLM etc. to actually take effect.
    ANTHROPIC_DEFAULT_SONNET_MODEL: primaryModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: primaryModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: lightModel,
  };

  if (preset?.authTokenOnly) {
    // Some gateways reject requests when both ANTHROPIC_API_KEY and AUTH_TOKEN are set.
    // The empty-string assignment is intentional and load-bearing — leaving the var
    // unset would let any inherited ANTHROPIC_API_KEY from the parent env leak through.
    env.ANTHROPIC_API_KEY = "";
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
  } else {
    // All other Anthropic-compatible endpoints (DeepSeek, Kimi, GLM, anthropic.com itself,
    // and arbitrary custom proxies) accept the key via either header; set both for safety.
    env.ANTHROPIC_API_KEY = apiKey;
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
  }

  if (provider === "bedrock") {
    env.CLAUDE_CODE_USE_BEDROCK = env.CLAUDE_CODE_USE_BEDROCK ?? "1";
  } else if (provider === "vertex") {
    env.CLAUDE_CODE_USE_VERTEX = env.CLAUDE_CODE_USE_VERTEX ?? "1";
  }

  if (!isClaudeAttributionEnabled()) {
    // Overrides built-in git commit instructions that append Co-Authored-By trailers.
    env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = "1";
  }

  return env;
}
