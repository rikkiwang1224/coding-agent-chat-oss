import { FolderGit2, ChevronDown, FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/context/AppContext";
import { cn } from "@/lib/utils";

export function WorkspaceSelector() {
  const { workspace } = useApp();
  const {
    currentWorkspace,
    workspaceData,
    selectWorkspace,
    chooseWorkspace,
  } = workspace;

  if (!currentWorkspace) {
    return (
      <button
        onClick={() => void chooseWorkspace()}
        className="flex w-full items-center gap-3 rounded-2xl border border-line-strong bg-surface p-3 text-left shadow-sm transition-[background-color,border-color,box-shadow,transform] hover:border-accent/20 hover:bg-white hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
      >
        <FolderOpen className="h-5 w-5 shrink-0 text-soft" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">Choose a codebase</p>
          <p className="text-xs text-muted truncate">
            Select a local workspace to begin
          </p>
        </div>
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-3 rounded-2xl border border-line-strong bg-surface p-3 text-left shadow-sm transition-[background-color,border-color,box-shadow,transform] hover:border-accent/20 hover:bg-white hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20">
          <FolderGit2 className="h-5 w-5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1 space-y-1">
            <span
              className="block truncate text-sm font-semibold"
              title={currentWorkspace.name}
            >
              {currentWorkspace.name}
            </span>
            <Badge
              variant="default"
              className="max-w-full self-start overflow-hidden text-ellipsis whitespace-nowrap px-1.5 py-0 text-[10px]"
              title={currentWorkspace.branch}
            >
              {currentWorkspace.branch}
            </Badge>
            <p className="truncate text-xs text-muted" title={currentWorkspace.path}>
              {currentWorkspace.path}
            </p>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-soft" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[260px]">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaceData.workspaces.map((ws) => (
          <DropdownMenuItem
            key={ws.path}
            onClick={() => void selectWorkspace(ws.path)}
            className={cn(
              ws.path === currentWorkspace.path && "bg-surface",
            )}
          >
            <div className="min-w-0">
              <span className="block truncate text-sm font-medium" title={ws.name}>
                {ws.name}
              </span>
              <Badge
                variant="default"
                className="mt-1 max-w-full self-start overflow-hidden text-ellipsis whitespace-nowrap px-1.5 py-0 text-[10px]"
                title={ws.branch}
              >
                {ws.branch}
              </Badge>
              <p className="mt-1 truncate text-xs text-muted" title={ws.path}>
                {ws.path}
              </p>
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void chooseWorkspace()}>
          <FolderOpen className="h-4 w-4 mr-2 text-soft" />
          Choose folder...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
