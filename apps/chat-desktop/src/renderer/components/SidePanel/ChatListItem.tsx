import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThreadSummary } from "@/types";

interface ChatListItemProps {
  thread: ThreadSummary;
  isSelected: boolean;
  disabled: boolean;
  onClick: () => void;
  onDelete?: () => void;
}

export function ChatListItem({
  thread,
  isSelected,
  disabled,
  onClick,
  onDelete,
}: ChatListItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "group relative flex w-full items-start gap-3 rounded-2xl border border-transparent p-3 text-left shadow-none transition-[background-color,border-color,box-shadow,transform] hover:border-line-strong hover:bg-white/95 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20",
        isSelected &&
          "border-line-strong bg-white/95 shadow-[inset_0_0_0_1px_rgba(32,27,20,0.06),var(--shadow-card)]",
        disabled && "opacity-55 cursor-not-allowed",
      )}
    >
      <div className="min-w-0 flex-1 grid gap-1">
        <p className="text-sm font-semibold truncate">{thread.title}</p>
        <p className="text-xs text-muted line-clamp-2 leading-relaxed">
          {thread.summary}
        </p>
      </div>
      <span className="text-xs text-soft whitespace-nowrap pt-0.5 group-hover:hidden">
        {thread.time}
      </span>
      {onDelete && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className={cn(
            "hidden group-hover:flex items-center justify-center",
            "h-6 w-6 rounded-lg text-soft hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 mt-0.5",
          )}
        >
          <X className="h-3.5 w-3.5" />
        </span>
      )}
    </button>
  );
}
