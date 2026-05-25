import type { PermissionDecision } from "./tools.js";

export interface BridgeRequestMeta {
  sessionToken?: string;
  timestamp?: string;
}

export interface BridgeRequest {
  jsonrpc: "2.0";
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
  meta?: BridgeRequestMeta;
}

export interface BridgeResponse {
  jsonrpc: "2.0";
  id: string;
  result?: BridgeToolResult;
  error?: BridgeError;
}

export interface BridgeNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface BridgeError {
  code: number;
  message: string;
  data?: unknown;
}

export interface BridgeToolResult {
  ok: boolean;
  output: string;
  code?: number;
  decision?: PermissionDecision;
}

export type BridgeMethod =
  | "tool.execute"
  | "tool.list"
  | "bridge.capabilities"
  | "bridge.ping"
  | "workspace.resolve"
  | "preview.getPendingEdits"
  | "preview.acceptEdits"
  | "preview.rejectEdits";

export interface BridgeCapabilities {
  version: string;
  tools: string[];
  features: string[];
  platform: string;
  shell: string;
}

export const BRIDGE_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  PATH_OUTSIDE_WORKSPACE: 1001,
  PERMISSION_DENIED: 1002,
  TOOL_EXECUTION_TIMEOUT: 1003,
  TOOL_NOT_AVAILABLE: 1004,
  ABORT_REQUESTED: 1005
} as const;
