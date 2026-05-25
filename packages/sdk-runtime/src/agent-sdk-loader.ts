import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PNPM_STORE_SEGMENT = path.join("node_modules", ".pnpm");

export async function loadAgentSdkModule(): Promise<Record<string, unknown> | null> {
  return importPackageWithFallback(
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai+claude-agent-sdk@",
    path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs")
  );
}

export async function loadZodModule(): Promise<Record<string, unknown> | null> {
  return importPackageWithFallback("zod", "zod@", path.join("node_modules", "zod", "index.js"));
}

async function importPackageWithFallback(
  specifier: string,
  storePrefix: string,
  entrySuffix: string
): Promise<Record<string, unknown> | null> {
  try {
    return (await importDynamic(specifier)) as Record<string, unknown>;
  } catch {
    const fallbackPath = resolvePnpmVirtualStoreEntry(storePrefix, entrySuffix);
    if (!fallbackPath) {
      return null;
    }

    try {
      return (await importDynamic(pathToFileURL(fallbackPath).href)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function resolvePnpmVirtualStoreEntry(storePrefix: string, entrySuffix: string): string | null {
  const storeRoot = path.join(process.cwd(), PNPM_STORE_SEGMENT);
  if (!existsSync(storeRoot)) {
    return null;
  }

  const candidates = readdirSync(storeRoot)
    .filter((entry) => entry.startsWith(storePrefix))
    .sort((left, right) => right.localeCompare(left));

  for (const candidate of candidates) {
    const entryPath = path.join(storeRoot, candidate, entrySuffix);
    if (existsSync(entryPath)) {
      return entryPath;
    }
  }

  return null;
}

function importDynamic(specifier: string): Promise<unknown> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (value: string) => Promise<unknown>;
  return dynamicImport(specifier);
}
