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
  if (
    lower.includes("run_cmd") ||
    lower.includes("terminal") ||
    lower.includes("shell")
  )
    return "Run Terminal";
  if (lower.includes("list_dir")) return "List Directory";

  const lastSegment = name.split("__").pop() || name;
  return lastSegment
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getToolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("grep") || lower.includes("search")) return Search;
  if (lower.includes("read_file")) return FileText;
  if (lower.includes("write_file") || lower.includes("edit")) return FilePenLine;
  if (
    lower.includes("run_cmd") ||
    lower.includes("terminal") ||
    lower.includes("shell")
  )
    return Terminal;
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

  const inputSummary = toolCall.input
    ? Object.values(toolCall.input).filter((v) => typeof v === "string")[0]
    : undefined;
  const subtitle =
    typeof inputSummary === "string"
      ? inputSummary.length > 60
        ? `${inputSummary.slice(0, 60)}…`
        : inputSummary
      : undefined;

  const hasContent = Boolean(toolCall.output || toolCall.error);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild disabled={!hasContent}>
        <button
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left transition-colors",
            hasContent && "hover:bg-white/60 cursor-pointer",
            !hasContent && "cursor-default",
          )}
        >
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
          {subtitle && (
            <span className="text-xs text-soft truncate">{subtitle}</span>
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
