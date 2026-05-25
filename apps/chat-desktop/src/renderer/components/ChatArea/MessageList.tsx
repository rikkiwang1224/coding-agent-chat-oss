import { useCallback, useEffect, useRef } from "react";
import { Bot, Brain } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { UserTurn, AssistantTurn } from "./MessageBubble";
import { useApp } from "@/context/AppContext";
import type { Message } from "@/types";

interface ConversationTurn {
  id: string;
  type: "user" | "assistant";
  messages: Message[];
}

function groupIntoTurns(messages: Message[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      turns.push({ id: msg.id, type: "user", messages: [msg] });
    } else {
      const last = turns[turns.length - 1];
      if (last && last.type === "assistant") {
        last.messages.push(msg);
      } else {
        turns.push({ id: msg.id, type: "assistant", messages: [msg] });
      }
    }
  }

  return turns;
}

export function MessageList() {
  const { agentRun } = useApp();
  const { messages, runState } = agentRun;
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const displayMessages = messages.filter(
    (m) => m.role !== "system" || (m.toolCalls && m.toolCalls.length > 0),
  );

  const turns = groupIntoTurns(displayMessages);
  const isRunning = runState === "running" || runState === "connecting";

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 150;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [displayMessages.length, runState]);

  if (turns.length === 0 && !isRunning) return null;

  const lastTurnIsAssistant =
    turns.length > 0 && turns[turns.length - 1].type === "assistant";

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="grid gap-6 px-2 py-4 max-w-[920px] mx-auto"
      >
        {turns.map((turn, idx) =>
          turn.type === "user" ? (
            <UserTurn key={turn.id} message={turn.messages[0]} />
          ) : (
            <AssistantTurn
              key={turn.id}
              messages={turn.messages}
              isLast={idx === turns.length - 1}
              isRunning={isRunning}
            />
          ),
        )}

        {isRunning && !lastTurnIsAssistant && (
          <div className="flex gap-3 max-w-[760px]">
            <div className="shrink-0 w-7 h-7 rounded-full bg-positive/12 flex items-center justify-center mt-0.5">
              <Bot className="h-3.5 w-3.5 text-positive" />
            </div>
            <div className="pt-1">
              <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium bg-warning/10 text-warning animate-pulse">
                <Brain className="h-3 w-3" />
                Thinking
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
