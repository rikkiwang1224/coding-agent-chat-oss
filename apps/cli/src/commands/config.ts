import type { LlmProvider } from "@forgelet/sdk-runtime";
import {
  loadCliConfigFile,
  saveCliConfig,
  getConfigFilePath,
  type CliConfig,
} from "../config.js";

export const CONFIG_SET_HELP = `forgelet config set — write ~/.forgelet/config.json

Usage:
  forgelet config set <key> <value> [<key> <value> ...]
  forgelet config set <key>=<value> [<key>=<value> ...]

Keys (aliases in parentheses):
  provider          LLM provider preset
  primaryModel      Primary model id (model, primary-model)
  apiKey            API key (api-key)
  baseUrl           API base URL (base-url)

Examples:
  forgelet config set provider deepseek
  forgelet config set api-key sk-...
  forgelet config set provider deepseek primaryModel deepseek-v4-pro
  forgelet config set provider=deepseek api-key=sk-...
`;

type ConfigField = keyof CliConfig;

const KEY_ALIASES: Record<string, ConfigField> = {
  provider: "provider",
  primarymodel: "primaryModel",
  "primary-model": "primaryModel",
  model: "primaryModel",
  apikey: "apiKey",
  "api-key": "apiKey",
  baseurl: "baseUrl",
  "base-url": "baseUrl",
};

function normalizeKey(raw: string): ConfigField | undefined {
  const key = raw.trim().toLowerCase();
  return KEY_ALIASES[key];
}

function assignUpdate(
  updates: Partial<CliConfig>,
  field: ConfigField,
  value: string,
): { error?: string } {
  if (field === "provider") {
    updates.provider = value.toLowerCase() as LlmProvider;
    return {};
  }
  updates[field] = value;
  return {};
}

function parseSetEntries(argv: string[]): { updates: Partial<CliConfig> } | { error: string } {
  const updates: Partial<CliConfig> = {};
  const tokens = argv.filter((a) => a !== "--");

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token.includes("=")) {
      const eq = token.indexOf("=");
      const key = normalizeKey(token.slice(0, eq));
      const value = token.slice(eq + 1);
      if (!key) return { error: `Unknown config key: ${token.slice(0, eq)}` };
      if (!value) return { error: `Missing value for key: ${token.slice(0, eq)}` };
      assignUpdate(updates, key, value);
      continue;
    }

    const key = normalizeKey(token);
    if (!key) return { error: `Unknown config key: ${token}` };

    const value = tokens[++i];
    if (value === undefined || normalizeKey(value)) {
      return { error: `Missing value for key: ${token}` };
    }

    assignUpdate(updates, key, value);
  }

  if (Object.keys(updates).length === 0) {
    return { error: "No config keys provided." };
  }

  return { updates };
}

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "(empty)";
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function formatValue(field: ConfigField, value: string): string {
  if (field === "apiKey") return maskApiKey(value);
  return value;
}

export async function runConfigCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "set") {
    if (rest.length === 0 || rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(CONFIG_SET_HELP);
      return rest.length === 0 ? 1 : 0;
    }

    const parsed = parseSetEntries(rest);
    if ("error" in parsed) {
      process.stderr.write(`Error: ${parsed.error}\n\n`);
      process.stdout.write(CONFIG_SET_HELP);
      return 1;
    }

    const current = await loadCliConfigFile();
    const next: CliConfig = { ...current, ...parsed.updates };
    await saveCliConfig(next);

    process.stdout.write(`Updated ${getConfigFilePath()}\n`);
    for (const [field, value] of Object.entries(parsed.updates)) {
      const key = field as ConfigField;
      process.stdout.write(`  ${key}: ${formatValue(key, String(value))}\n`);
    }
    return 0;
  }

  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(CONFIG_SET_HELP.replace("forgelet config set", "forgelet config"));
    return 0;
  }

  process.stderr.write(`Unknown config command: ${sub}\n\n`);
  process.stdout.write(CONFIG_SET_HELP.replace("forgelet config set", "forgelet config"));
  return 1;
}
