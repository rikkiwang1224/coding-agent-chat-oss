import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const separator = trimmed.indexOf("=");
  if (separator <= 0) return null;

  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return key ? { key, value } : null;
}

function applyEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/g)) {
    const parsed = parseEnvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
  }
}

function findNearestEnvFile(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, ".env");
    if (existsSync(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Load repo-root `.env` when CLI env vars are not set (does not override existing env). */
export function loadEvalEnv(startDir?: string): void {
  if (loaded) return;
  loaded = true;

  const explicit = process.env.LATTICE_CODE_ENV_FILE?.trim();
  if (explicit) {
    applyEnvFile(path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit));
    return;
  }

  const base =
    startDir ??
    path.dirname(fileURLToPath(import.meta.url));
  const envPath = findNearestEnvFile(base);
  if (envPath) applyEnvFile(envPath);
}
