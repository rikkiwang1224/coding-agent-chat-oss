import { MessageSquare, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/context/AppContext";
import { cn } from "@/lib/utils";
import type { AppMode } from "@/types";

const modes: { id: AppMode; icon: typeof MessageSquare; label: string }[] = [
  { id: "chat", icon: MessageSquare, label: "Chat" },
];

function NavButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof MessageSquare;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative h-[72px] w-full flex-col gap-2 rounded-2xl border border-transparent px-2 py-2 text-muted shadow-none transition-all hover:border-line-strong hover:bg-line-strong hover:text-text hover:shadow-card",
        "[&_svg]:size-5",
        active &&
          "border-accent bg-accent text-[#fffdf9] shadow-card hover:border-accent hover:bg-accent hover:text-[#fffdf9]",
      )}
    >
      <Icon />
      <span className="text-[13px] font-semibold leading-none tracking-[-0.01em]">
        {label}
      </span>
      {active && (
        <span className="absolute inset-x-4 bottom-1.5 h-[3px] rounded-full bg-[#fffdf9]/75" />
      )}
    </Button>
  );
}

export function ActivityBar() {
  const { mode, setMode } = useApp();

  return (
    <nav
      className="flex flex-col gap-2 border-r border-line-strong bg-panel-solid px-2 py-3"
      aria-label="Main navigation"
    >
      {modes.map(({ id, icon, label }) => (
        <NavButton
          key={id}
          active={mode === id}
          onClick={() => setMode(id)}
          icon={icon}
          label={label}
        />
      ))}

      <div className="mt-auto">
        <NavButton
          active={mode === "settings"}
          onClick={() => setMode("settings")}
          icon={Settings}
          label="Settings"
        />
      </div>
    </nav>
  );
}
