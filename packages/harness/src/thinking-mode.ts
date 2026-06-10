import type { LlmConfig } from "./types.js";

/** DeepSeek thinking mode: off (default), high, or max. */
export type ThinkingModeSetting = "off" | "high" | "max";

export interface ParsedThinkingConfig {
  thinking: boolean;
  reasoningEffort?: "high" | "max";
}

const OFF_VALUES = new Set(["off", "disabled", "false", "0", "no"]);
const HIGH_VALUES = new Set(["on", "enabled", "true", "1", "yes", "high"]);
const MAX_VALUES = new Set(["max"]);

/**
 * Parse THINKING_MODE (or config file `thinkingMode`).
 * Unset/empty → undefined unless `defaultWhenUnset` is provided.
 */
export function parseThinkingMode(
  raw: string | undefined,
  defaultWhenUnset?: ThinkingModeSetting,
): ParsedThinkingConfig | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return defaultWhenUnset ? parseThinkingMode(defaultWhenUnset) : undefined;
  }
  const v = trimmed.toLowerCase();

  if (OFF_VALUES.has(v)) return { thinking: false };
  if (MAX_VALUES.has(v)) return { thinking: true, reasoningEffort: "max" };
  if (HIGH_VALUES.has(v)) return { thinking: true, reasoningEffort: "high" };

  throw new Error(`Invalid THINKING_MODE "${trimmed}": use off, high, or max`);
}

/** Read THINKING_MODE from the environment. */
export function resolveThinkingModeFromEnv(
  defaultWhenUnset?: ThinkingModeSetting,
): ParsedThinkingConfig | undefined {
  return parseThinkingMode(process.env.THINKING_MODE, defaultWhenUnset);
}

/** Merge parsed thinking settings into an LlmConfig when set. */
export function applyThinkingMode(
  config: LlmConfig,
  mode: ParsedThinkingConfig | undefined,
): LlmConfig {
  if (!mode) return config;
  return {
    ...config,
    thinking: mode.thinking,
    ...(mode.reasoningEffort ? { reasoningEffort: mode.reasoningEffort } : {}),
  };
}
