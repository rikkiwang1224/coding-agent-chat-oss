import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { PermissionCallback } from "@lattice-code/harness";
import type { PermissionRequestOutcome } from "@lattice-code/shared-types";

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingPermission {
  resolve: (allowed: boolean) => void;
  sessionId: string;
  toolName: string;
  commandKey: string;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingPermissions = new Map<string, PendingPermission>();

function commandKey(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "run_command") {
    return String(args.command || "").trim();
  }
  return toolName;
}

export function createPermissionCallback(
  sender: WebContents,
  sessionId: string,
  emitAgentEvent: (sender: WebContents, payload: unknown) => void,
  onAllowAlways?: (toolName: string, key: string) => void,
): PermissionCallback {
  return (toolName, args, reason) =>
    new Promise<boolean>((resolve) => {
      const requestId = randomUUID();
      const key = commandKey(toolName, args);
      const timeout = setTimeout(() => {
        const pending = pendingPermissions.get(requestId);
        if (pending) {
          pendingPermissions.delete(requestId);
          resolve(false);
        }
      }, PERMISSION_TIMEOUT_MS);

      pendingPermissions.set(requestId, {
        resolve,
        sessionId,
        toolName,
        commandKey: key,
        timeout,
      });

      emitAgentEvent(sender, {
        type: "tool.permission_request",
        sessionId,
        taskId: "chat-desktop-transport",
        timestamp: new Date().toISOString(),
        payload: {
          requestId,
          toolName,
          args,
          reason,
          decision: "ask",
        },
      });
    });
}

export function respondPermission(
  requestId: string,
  outcome: PermissionRequestOutcome,
  onAllowAlways?: (toolName: string, key: string) => void,
): boolean {
  const pending = pendingPermissions.get(requestId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingPermissions.delete(requestId);

  if (outcome === "deny") {
    pending.resolve(false);
    return true;
  }

  if (outcome === "allow_always") {
    onAllowAlways?.(pending.toolName, pending.commandKey);
  }

  pending.resolve(true);
  return true;
}

export function denyAllPendingPermissions(senderSessionId?: string): void {
  for (const [id, pending] of pendingPermissions) {
    if (senderSessionId && pending.sessionId !== senderSessionId) continue;
    clearTimeout(pending.timeout);
    pending.resolve(false);
    pendingPermissions.delete(id);
  }
}
