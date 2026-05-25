import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { PROVIDER_PRESETS, type LlmProvider } from "@forgelet/sdk-runtime";

const SETTINGS_FILENAME = "chat-desktop-settings.json";

export interface AppSettings {
  general: {
    /** LLM provider preset — drives default baseUrl + pricing for cost accounting. */
    provider: LlmProvider;
    /** Primary model used for chat turns. Vendor-neutral field name. */
    primaryModel: string;
    /** Optional light model used by Claude Code for lightweight internal tasks. */
    lightModel: string;
    apiKey: string;
    baseUrl: string;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    provider: "deepseek",
    primaryModel: "deepseek-v4-pro",
    lightModel: "deepseek-v4-flash",
    apiKey: "",
    baseUrl: "",
  },
};

function getSettingsFilePath(): string {
  return path.join(app.getPath("userData"), SETTINGS_FILENAME);
}

export async function loadSettings(): Promise<AppSettings> {
  const filePath = getSettingsFilePath();
  try {
    const raw = await readFile(filePath, "utf8");
    const saved = JSON.parse(raw) as Partial<AppSettings>;
    return normalizeSettings(saved);
  } catch {
    return normalizeSettings({});
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const filePath = getSettingsFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(normalizeSettings(settings), null, 2), "utf8");
}

function normalizeSettings(saved: Partial<AppSettings>): AppSettings {
  return {
    general: normalizeGeneral((saved.general ?? {}) as LegacyGeneral),
  };
}

// Migration: support reading three historical schemas of the model fields
//   1. legacy single `model` string (pre-split)
//   2. `modelSonnet` / `modelHaiku` (Anthropic-flavoured names)
//   3. current `primaryModel` / `lightModel` (vendor-neutral)
// Writes always use #3.
type LegacyGeneral = Partial<AppSettings["general"]> & {
  model?: string;
  modelSonnet?: string;
  modelHaiku?: string;
};

const VALID_PROVIDERS: ReadonlySet<LlmProvider> = new Set<LlmProvider>([
  "anthropic",
  "deepseek",
  "kimi",
  "glm",
  "bedrock",
  "vertex",
  "custom",
]);

function pickString(...candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

function normalizeGeneral(saved?: LegacyGeneral): AppSettings["general"] {
  const base = DEFAULT_SETTINGS.general;
  const rawProvider = typeof saved?.provider === "string" ? saved.provider.trim().toLowerCase() : "";
  const provider = VALID_PROVIDERS.has(rawProvider as LlmProvider)
    ? (rawProvider as LlmProvider)
    : base.provider;
  const primaryModel =
    pickString(saved?.primaryModel, saved?.modelSonnet, saved?.model) ?? base.primaryModel;
  const lightModelRaw = pickString(saved?.lightModel, saved?.modelHaiku);
  return {
    provider,
    apiKey: saved?.apiKey ?? base.apiKey,
    baseUrl: saved?.baseUrl ?? base.baseUrl,
    primaryModel,
    lightModel: lightModelRaw ?? base.lightModel,
  };
}

/** LLM config passed into the agent engine. */
export function buildLlmConfigFromSettingsGeneral(
  general: AppSettings["general"],
):
  | {
      provider: LlmProvider;
      apiKey: string;
      baseUrl?: string;
      primaryModel?: string;
      lightModel?: string;
    }
  | undefined {
  if (!general.apiKey?.trim()) return undefined;
  const provider = general.provider ?? "deepseek";

  const DEEPSEEK_DEFAULTS = {
    baseUrl: "https://api.deepseek.com",
    defaultPrimaryModel: "deepseek-v4-pro",
    defaultLightModel: "deepseek-v4-flash",
  };

  const preset =
    provider in PROVIDER_PRESETS
      ? PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS]
      : provider === "deepseek"
        ? DEEPSEEK_DEFAULTS
        : undefined;

  return {
    provider,
    apiKey: general.apiKey.trim(),
    baseUrl: general.baseUrl.trim() || preset?.baseUrl,
    primaryModel: general.primaryModel.trim() || preset?.defaultPrimaryModel,
    lightModel: general.lightModel.trim() || preset?.defaultLightModel,
  };
}
