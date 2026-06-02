import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_INDEX_TIMEOUT_MS = 300_000;

/** Disable with FORGELET_CODE_GRAPH=0. Override binary with FORGELET_CODEBASE_MEMORY_BIN. */
export function isCodeGraphDisabled(): boolean {
  const raw = process.env.FORGELET_CODE_GRAPH?.trim().toLowerCase();
  return raw === "0" || raw === "off" || raw === "false";
}

async function fileExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function whichOnPath(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\/$/, "")}/${name}`;
    if (await fileExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the codebase-memory-mcp CLI. Returns null if disabled or not installed.
 */
export async function resolveCodebaseMemoryBinary(): Promise<string | null> {
  if (isCodeGraphDisabled()) return null;

  const explicit = process.env.FORGELET_CODEBASE_MEMORY_BIN?.trim();
  if (explicit && (await fileExecutable(explicit))) return explicit;

  const onPath = await whichOnPath("codebase-memory-mcp");
  if (onPath) return onPath;

  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const local = `${home}/.local/bin/codebase-memory-mcp`;
    if (await fileExecutable(local)) return local;
  }

  return null;
}

export interface CodebaseMemoryCliResult {
  ok: boolean;
  output: string;
  parsed?: unknown;
}

/**
 * Thin wrapper around `codebase-memory-mcp cli <tool> '<json>'`.
 * See https://github.com/DeusData/codebase-memory-mcp
 */
export class CodebaseMemoryClient {
  /** Set after a successful index_repository (required for subsequent queries). */
  projectName?: string;

  constructor(
    readonly binaryPath: string,
    readonly workspaceRoot: string,
  ) {}

  static async create(workspaceRoot: string): Promise<CodebaseMemoryClient | null> {
    const binaryPath = await resolveCodebaseMemoryBinary();
    if (!binaryPath) return null;
    return new CodebaseMemoryClient(binaryPath, workspaceRoot);
  }

  async cli(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
  ): Promise<CodebaseMemoryCliResult> {
    const withProject =
      this.projectName && args.project === undefined
        ? { ...args, project: this.projectName }
        : args;
    const payload = JSON.stringify(withProject);
    try {
      const { stdout, stderr } = await execFileAsync(
        this.binaryPath,
        ["cli", toolName, payload],
        {
          cwd: this.workspaceRoot,
          maxBuffer: 8 * 1024 * 1024,
          timeout: timeoutMs,
          env: { ...process.env },
        },
      );
      return this.parseCliResult(stdout, stderr);
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      if (typeof err.stdout === "string" || typeof err.stderr === "string") {
        return this.parseCliResult(err.stdout ?? "", err.stderr ?? "");
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `codebase-memory-mcp ${toolName} failed: ${message}` };
    }
  }

  private parseCliResult(stdout: string, stderr: string): CodebaseMemoryCliResult {
    const parsed = extractJsonFromCliOutput(stdout, stderr);
    const logTail = stderr
      .split("\n")
      .filter((l) => l.startsWith("level="))
      .slice(-3)
      .join("\n");
    const ok = parsed !== undefined && !isErrorPayload(parsed);
    const body = formatCliOutput(parsed, stdout.trim() || stderr.trim());
    const output = logTail ? `${logTail}\n${body}` : body;
    return { ok, output, parsed };
  }

  async indexRepository(timeoutMs = DEFAULT_INDEX_TIMEOUT_MS): Promise<CodebaseMemoryCliResult> {
    const result = await this.cli(
      "index_repository",
      { repo_path: this.workspaceRoot },
      timeoutMs,
    );
    if (result.ok && result.parsed && typeof result.parsed === "object") {
      const project = (result.parsed as Record<string, unknown>).project;
      if (typeof project === "string" && project.trim()) {
        this.projectName = project.trim();
      }
    }
    return result;
  }

  async getArchitecture(args?: {
    aspects?: string[];
  }): Promise<CodebaseMemoryCliResult> {
    const aspects =
      args?.aspects?.length && args.aspects.every((a) => typeof a === "string")
        ? args.aspects
        : ["all"];
    return this.cli("get_architecture", { aspects });
  }

  async searchGraph(args: {
    name_pattern?: string;
    label?: string;
    file_pattern?: string;
    limit?: number;
  }): Promise<CodebaseMemoryCliResult> {
    return this.cli("search_graph", {
      name_pattern: args.name_pattern ?? ".*",
      ...(args.label ? { label: args.label } : {}),
      ...(args.file_pattern ? { file_pattern: args.file_pattern } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : { limit: 50 }),
    });
  }

  async traceCallPath(args: {
    function_name: string;
    direction?: "inbound" | "outbound" | "both";
    depth?: number;
  }): Promise<CodebaseMemoryCliResult> {
    return this.cli("trace_call_path", {
      function_name: args.function_name,
      direction: args.direction ?? "both",
      depth: args.depth ?? 3,
    });
  }

  async detectChanges(): Promise<CodebaseMemoryCliResult> {
    return this.cli("detect_changes", {});
  }
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** codebase-memory-mcp logs to stderr; JSON payload is usually the last line of stdout. */
function extractJsonFromCliOutput(stdout: string, stderr: string): unknown | undefined {
  for (const chunk of [stdout, stderr]) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith("{") || line.startsWith("[")) {
        const parsed = tryParseJson(line);
        if (parsed !== undefined) return parsed;
      }
    }
  }
  return tryParseJson(stdout) ?? tryParseJson(stderr);
}

function isErrorPayload(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  if (obj.error) return true;
  if (obj.ok === false) return true;
  return false;
}

function formatCliOutput(parsed: unknown | undefined, raw: string): string {
  if (parsed === undefined) return raw || "(no output)";
  return JSON.stringify(parsed, null, 2);
}
