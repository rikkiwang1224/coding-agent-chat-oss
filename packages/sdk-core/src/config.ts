import path from "node:path";

export type AgentEngineMode = "claude_sdk" | "query_loop";
export type ClaudeCodePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export interface ClaudeCodeRuntimeOptions {
  cwd: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: ClaudeCodePermissionMode;
  executable?: string;
  executableArgs?: string[];
  pathToClaudeCodeExecutable?: string;
  resume?: string;
}

export function normalizeAgentEngineMode(
  value: string | undefined,
  sdkAvailable: boolean
): AgentEngineMode {
  switch (value) {
    case "claude_sdk":
    case "query_loop":
      return value;
    default:
      return sdkAvailable ? "claude_sdk" : "query_loop";
  }
}

export function buildClaudeCodeRuntimeOptions(
  workspaceRoot: string,
  overrides: Partial<ClaudeCodeRuntimeOptions> = {}
): ClaudeCodeRuntimeOptions {
  const options: ClaudeCodeRuntimeOptions = {
    cwd: path.resolve(workspaceRoot),
    model: readTrimmed(
      process.env.AGENT_LLM_MODEL ?? process.env.CLAUDE_MODEL ?? process.env.ANTHROPIC_MODEL
    ),
    maxTurns: parsePositiveInteger(process.env.AGENT_MAX_TURNS),
    allowedTools: parseList(process.env.AGENT_ALLOWED_TOOLS),
    disallowedTools: parseList(process.env.AGENT_DISALLOWED_TOOLS),
    permissionMode: normalizeClaudeCodePermissionMode(
      process.env.AGENT_PERMISSION_MODE ?? process.env.CLAUDE_PERMISSION_MODE
    ),
    executable: readTrimmed(
      process.env.CLAUDE_CODE_NODE_PATH ?? process.env.CLAUDE_CODE_EXECUTABLE
    ),
    executableArgs: parseWhitespaceSeparated(process.env.CLAUDE_CODE_EXECUTABLE_ARGS),
    pathToClaudeCodeExecutable: readTrimmed(process.env.CLAUDE_CODE_EXECUTABLE_PATH),
    ...overrides
  };

  return removeUndefinedValues(options);
}

export function normalizeClaudeCodePermissionMode(
  value: string | undefined
): ClaudeCodePermissionMode | undefined {
  switch (value) {
    case "plan":
    case "default":
    case "acceptEdits":
      return value;
    case "dontAsk":
      return "bypassPermissions";
    default:
      return undefined;
  }
}

function parseList(value: string | undefined): string[] | undefined {
  const normalized = readTrimmed(value);
  if (!normalized) {
    return undefined;
  }

  const items = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

function parseWhitespaceSeparated(value: string | undefined): string[] | undefined {
  const normalized = readTrimmed(value);
  if (!normalized) {
    return undefined;
  }

  const items = normalized
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readTrimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function removeUndefinedValues<T extends object>(input: T): T {
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== undefined)
  ) as T;
}
