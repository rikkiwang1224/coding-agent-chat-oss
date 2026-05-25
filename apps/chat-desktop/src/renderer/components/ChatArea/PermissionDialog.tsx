import { Button } from "@/components/ui/button";
import type { PermissionRequestOutcome } from "@forgelet/shared-types";

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
}

interface PermissionDialogProps {
  request: PendingPermissionRequest | null;
  onRespond: (outcome: PermissionRequestOutcome) => void;
}

function formatArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "run_command") {
    return String(args.command ?? "");
  }
  if (args.path) return String(args.path);
  return JSON.stringify(args, null, 2);
}

export function PermissionDialog({ request, onRespond }: PermissionDialogProps) {
  if (!request) return null;

  const detail = formatArgs(request.toolName, request.args);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="permission-dialog-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-line-strong bg-bg p-5 shadow-card">
        <h2 id="permission-dialog-title" className="text-base font-semibold text-text">
          Allow tool execution?
        </h2>
        <p className="mt-2 text-sm text-muted">{request.reason}</p>
        <div className="mt-3 rounded-md border border-line bg-surface p-3">
          <p className="text-xs font-medium text-muted">Tool: {request.toolName}</p>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs text-text">
            {detail}
          </pre>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => onRespond("deny")}>
            Deny
          </Button>
          <Button variant="secondary" onClick={() => onRespond("allow_once")}>
            Allow once
          </Button>
          <Button onClick={() => onRespond("allow_always")}>
            Always allow
          </Button>
        </div>
      </div>
    </div>
  );
}
