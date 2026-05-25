import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

const RUNTIME_ENV_FILENAME = "chat-desktop.env";

let runtimeEnvLoaded = false;

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separator = trimmed.indexOf("=");
  if (separator <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    const commentIndex = value.indexOf(" #");
    if (commentIndex >= 0) {
      value = value.slice(0, commentIndex).trim();
    }
  }

  return key ? { key, value } : null;
}

function applyEnvFile(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }

  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/g)) {
    const parsed = parseEnvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) {
      continue;
    }

    process.env[parsed.key] = parsed.value;
  }

  return true;
}

function findNearestEnvFile(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function resolveEnvPath(rawPath: string | undefined): string | null {
  const normalized = rawPath?.trim();
  if (!normalized) {
    return null;
  }

  return path.isAbsolute(normalized) ? normalized : path.resolve(process.cwd(), normalized);
}

export function getRuntimeEnvFilePath(): string {
  return path.join(app.getPath("userData"), RUNTIME_ENV_FILENAME);
}

export function loadRuntimeEnv(dirname: string): void {
  if (runtimeEnvLoaded) {
    return;
  }

  const explicitEnvPath = resolveEnvPath(process.env.FORGELET_ENV_FILE);
  const candidatePaths = [
    explicitEnvPath,
    app.isPackaged ? getRuntimeEnvFilePath() : null,
    findNearestEnvFile(process.cwd()),
    path.resolve(process.cwd(), "apps/chat-desktop/.env"),
    findNearestEnvFile(dirname)
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of new Set(candidatePaths)) {
    if (applyEnvFile(candidate)) {
      break;
    }
  }

  runtimeEnvLoaded = true;
}
