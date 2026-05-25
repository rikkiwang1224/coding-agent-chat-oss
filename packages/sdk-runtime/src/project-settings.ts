import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ClaudeProjectPaths {
  claudeRoot: string;
  claudeMdPath: string;
  settingsPath: string;
  settingsLocalPath: string;
  hasClaudeMd: boolean;
  hasSettings: boolean;
  hasSettingsLocal: boolean;
}

export function resolveClaudeProjectPaths(workspaceRoot: string): ClaudeProjectPaths {
  const claudeRoot = path.join(path.resolve(workspaceRoot), ".claude");
  const claudeMdPath = path.join(claudeRoot, "CLAUDE.md");
  const settingsPath = path.join(claudeRoot, "settings.json");
  const settingsLocalPath = path.join(claudeRoot, "settings.local.json");

  return {
    claudeRoot,
    claudeMdPath,
    settingsPath,
    settingsLocalPath,
    hasClaudeMd: existsSync(claudeMdPath),
    hasSettings: existsSync(settingsPath),
    hasSettingsLocal: existsSync(settingsLocalPath),
  };
}

/** Opt-in via FORGELET_CLAUDE_ATTRIBUTION=1|true|on to keep Claude Code Co-Authored-By trailers. */
export function isClaudeAttributionEnabled(): boolean {
  const raw = process.env.FORGELET_CLAUDE_ATTRIBUTION?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAttributionConfigComplete(settings: Record<string, unknown>): boolean {
  const attribution = settings.attribution;
  const attributionDisabled =
    isRecord(attribution) && attribution.commit === "" && attribution.pr === "";
  return (
    attributionDisabled &&
    settings.includeCoAuthoredBy === false &&
    settings.includeGitInstructions === false
  );
}

async function readSettingsFile(filePath: string, exists: boolean): Promise<Record<string, unknown>> {
  if (!exists) {
    return {};
  }
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function applyAttributionDisable(settings: Record<string, unknown>): Record<string, unknown> {
  const existingAttribution = isRecord(settings.attribution) ? settings.attribution : {};
  return {
    ...settings,
    attribution: {
      ...existingAttribution,
      commit: "",
      pr: "",
    },
    includeCoAuthoredBy: false,
    // Built-in git instructions inject Co-Authored-By even when attribution.commit is empty.
    includeGitInstructions: false,
  };
}

/**
 * Ensures Claude Code will not add `Co-Authored-By` trailers on git commits.
 * Writes `.claude/settings.local.json` (gitignored, highest project scope).
 */
export async function ensureClaudeAttributionDisabled(workspaceRoot: string): Promise<void> {
  if (isClaudeAttributionEnabled()) {
    return;
  }

  const paths = resolveClaudeProjectPaths(workspaceRoot);
  const localSettings = await readSettingsFile(paths.settingsLocalPath, paths.hasSettingsLocal);

  if (isAttributionConfigComplete(localSettings)) {
    return;
  }

  const nextSettings = applyAttributionDisable(localSettings);
  await mkdir(paths.claudeRoot, { recursive: true });
  await writeFile(paths.settingsLocalPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
}
