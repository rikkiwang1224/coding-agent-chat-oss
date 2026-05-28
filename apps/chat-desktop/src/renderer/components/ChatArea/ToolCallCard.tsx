import { useState } from "react";
import {
  FileText,
  Terminal,
  Search,
  FilePenLine,
  FolderOpen,
  Settings,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronRight,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolCallInfo } from "@/types";

const TOOL_LABEL: Record<string, string> = {
  read_file: "Read File",
  write_file: "Write File",
  run_cmd: "Run Terminal",
  search_rg: "Grep",
  Grep: "Grep",
  grep: "Grep",
  list_dir: "List Directory",
};

function prettifyToolName(name: string): string {
  if (TOOL_LABEL[name]) return TOOL_LABEL[name];

  const lower = name.toLowerCase();
  if (lower.includes("grep") || lower.includes("search_rg")) return "Grep";
  if (lower.includes("read_file")) return "Read File";
  if (lower.includes("write_file") || lower.includes("edit_file"))
    return "Write File";
  if (isTerminalTool(name)) return "Run Terminal";
  if (lower.includes("list_dir")) return "List Directory";

  const lastSegment = name.split("__").pop() || name;
  return lastSegment
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isTerminalTool(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "bash" ||
    lower.includes("run_cmd") ||
    lower.includes("run_command") ||
    lower.includes("terminal") ||
    lower.includes("shell")
  );
}

function getInputPreview(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  if (typeof input.command === "string") return input.command;
  const firstString = Object.values(input).find((v) => typeof v === "string");
  return typeof firstString === "string" ? firstString : undefined;
}

function getToolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("grep") || lower.includes("search")) return Search;
  if (lower.includes("read_file")) return FileText;
  if (lower.includes("write_file") || lower.includes("edit")) return FilePenLine;
  if (isTerminalTool(name)) return Terminal;
  if (lower.includes("list_dir") || lower.includes("list_directory"))
    return FolderOpen;
  if (lower.includes("config") || lower.includes("setting")) return Settings;
  return Terminal;
}

interface ToolCallCardProps {
  toolCall: ToolCallInfo;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const Icon = getToolIcon(toolCall.toolName);
  const label = prettifyToolName(toolCall.toolName);

  const inputPreview = getInputPreview(toolCall.input);
  const isTerminal = isTerminalTool(toolCall.toolName);
  const inlineSubtitle =
    !isTerminal && inputPreview
      ? inputPreview.length > 80
        ? `${inputPreview.slice(0, 80)}…`
        : inputPreview
      : undefined;

  const hasContent = Boolean(toolCall.output || toolCall.error);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild disabled={!hasContent}>
        <button
          className={cn(
            "flex w-full flex-col gap-1 rounded-lg px-3 py-1.5 text-left transition-colors",
            hasContent && "hover:bg-white/60 cursor-pointer",
            !hasContent && "cursor-default",
          )}
        >
          <div className="flex w-full min-w-0 items-center gap-2.5">
            {hasContent && (
              <ChevronRight
                className={cn(
                  "h-3 w-3 shrink-0 text-soft transition-transform",
                  open && "rotate-90",
                )}
              />
            )}
            {!hasContent && toolCall.status === "pending" && (
              <Loader2 className="h-3 w-3 shrink-0 text-warning animate-spin" />
            )}
            {!hasContent && toolCall.status !== "pending" && (
              <ChevronRight className="h-3 w-3 shrink-0 text-soft opacity-0" />
            )}
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="text-[13px] font-medium text-text">{label}</span>
            {inlineSubtitle && (
              <span
                className="min-w-0 flex-1 truncate text-xs text-soft"
                title={inputPreview}
              >
                {inlineSubtitle}
              </span>
            )}
            <div className="ml-auto flex items-center shrink-0">
              {toolCall.status === "pending" && hasContent && (
                <Loader2 className="h-3.5 w-3.5 text-warning animate-spin" />
              )}
              {toolCall.status === "success" && (
                <CheckCircle2 className="h-3.5 w-3.5 text-positive" />
              )}
              {toolCall.status === "error" && (
                <XCircle className="h-3.5 w-3.5 text-error" />
              )}
            </div>
          </div>
          {isTerminal && inputPreview && (
            <pre className="ml-[22px] mr-2 max-w-full overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-soft">
              {inputPreview}
            </pre>
          )}
        </button>
      </CollapsibleTrigger>
      {hasContent && (
        <CollapsibleContent>
          <pre className="ml-[22px] mr-2 mb-1 max-h-[200px] overflow-auto rounded-lg bg-accent/5 p-3 text-xs text-muted font-mono leading-relaxed whitespace-pre-wrap">
            {toolCall.error || toolCall.output || ""}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
