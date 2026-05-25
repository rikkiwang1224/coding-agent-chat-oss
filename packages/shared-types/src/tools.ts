export interface ReadFileInput {
  path: string;
}

export interface SearchRgInput {
  query: string;
  cwd?: string;
  glob?: string;
}

export interface RunCmdInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface ToolInputMap {
  read_file: ReadFileInput;
  search_rg: SearchRgInput;
  run_cmd: RunCmdInput;
  write_file: WriteFileInput;
}

export type ToolName = keyof ToolInputMap;
export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionMode = "plan" | "default" | "acceptEdits" | "dontAsk";

export type ToolPermissionKind = "read" | "search" | "execute" | "write";

export interface ToolTimeoutPolicy {
  defaultMs?: number;
  maxMs?: number;
}

export interface AgentToolMetadata {
  name: string;
  displayName?: string;
  description?: string;
  readOnly?: boolean;
  destructive?: boolean;
  concurrencySafe?: boolean;
  permissionKind?: string;
  timeoutPolicy?: ToolTimeoutPolicy;
}

export interface ToolMetadata<TName extends ToolName = ToolName> extends AgentToolMetadata {
  name: TName;
  displayName: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  permissionKind: ToolPermissionKind;
  timeoutPolicy?: ToolTimeoutPolicy;
}

export type ToolCall<TName extends ToolName = ToolName> = {
  [T in TName]: {
    toolName: T;
    args: ToolInputMap[T];
  };
}[TName];

export interface ToolResult {
  ok: boolean;
  output: string;
  code?: number;
  decision?: PermissionDecision;
}

export function asToolRecord(call: ToolCall): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(call.args).filter(([, value]) => value !== undefined)
  );
}
