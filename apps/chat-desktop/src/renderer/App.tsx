import { AppProvider, useApp } from "@/context/AppContext";
import { ActivityBar } from "@/components/ActivityBar/ActivityBar";
import { SidePanel } from "@/components/SidePanel/SidePanel";
import { ChatArea } from "@/components/ChatArea/ChatArea";

function AppLayout() {
  const { mode } = useApp();
  const showSidePanel = mode === "chat";

  return (
    <div
      className={`grid h-screen overflow-hidden ${
        showSidePanel
          ? "grid-cols-[88px_280px_minmax(0,1fr)]"
          : "grid-cols-[88px_minmax(0,1fr)]"
      }`}
    >
      <ActivityBar />
      {showSidePanel ? <SidePanel /> : null}
      <div className="relative grid min-h-0 min-w-0 overflow-hidden">
        <ChatArea />
      </div>
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <AppLayout />
    </AppProvider>
  );
}
