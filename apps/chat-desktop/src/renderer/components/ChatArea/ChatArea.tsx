import { ChatTopBar } from "./ChatTopBar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { useApp } from "@/context/AppContext";
import { Settings } from "@/components/Settings/Settings";

function HeroView() {
  const { workspace } = useApp();
  const { currentWorkspace } = workspace;
  const name = currentWorkspace?.name ?? "your codebase";

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 text-center px-4 pb-40">
      <div className="relative w-16 h-16">
        <span className="absolute w-7 h-7 rounded-full border-[3px] border-accent top-0 left-[18px]" />
        <span className="absolute w-7 h-7 rounded-full border-[3px] border-accent top-[18px] right-0" />
        <span className="absolute w-7 h-7 rounded-full border-[3px] border-accent bottom-0 left-[18px]" />
        <span className="absolute w-7 h-7 rounded-full border-[3px] border-accent top-[18px] left-0" />
        <span className="absolute inset-[22px] rounded-full border-[3px] border-accent bg-panel-solid" />
      </div>
      <h1 className="text-[clamp(38px,5vw,56px)] font-semibold tracking-tight leading-none">
        Ask about {name}
      </h1>
    </div>
  );
}

export function ChatArea() {
  const { mode, agentRun } = useApp();
  const hasConversation =
    agentRun.messages.filter((m) => m.role !== "system" || (m.toolCalls && m.toolCalls.length > 0)).length > 0;

  if (mode === "settings") {
    return <Settings />;
  }

  return (
    <div className="relative flex flex-col min-w-0 min-h-0 h-full overflow-hidden p-4">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(255,255,255,0.95),transparent_26%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_100%,rgba(236,229,218,0.85),transparent_36%)]" />
      </div>

      <div className="relative z-10 flex flex-col min-h-0 h-full">
        <ChatTopBar />
        {hasConversation ? <MessageList /> : <HeroView />}
        <div className="mt-auto pt-3">
          <Composer />
        </div>
      </div>
    </div>
  );
}
