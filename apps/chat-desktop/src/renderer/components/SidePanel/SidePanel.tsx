import { Separator } from "@/components/ui/separator";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { ChatList } from "./ChatList";

export function SidePanel() {
  return (
    <div className="flex flex-col min-h-0 gap-3 p-3 border-r border-line bg-linear-to-b from-white/70 to-[rgba(250,247,241,0.92)] backdrop-blur-[20px]">
      <WorkspaceSelector />
      <Separator />
      <ChatList />
    </div>
  );
}
