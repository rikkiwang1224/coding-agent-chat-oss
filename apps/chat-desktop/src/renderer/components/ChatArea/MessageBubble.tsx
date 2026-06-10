import { useState } from "react";
import { User, Bot, Wrench, Brain, AlertCircle } from "lucide-react";
import { ToolCallCard } from "./ToolCallCard";
import { MarkdownContent } from "./MarkdownContent";
import { toFileUrl } from "@/lib/file-url";
import { formatCostUsd } from "@lattice-code/sdk-runtime";
import { collapseDuplicateAssistantTextItems } from "@/lib/message-dedupe";
import type { ImageAttachment, Message, MessageTurnCost, ToolCallInfo } from "@/types";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderBody(body: string) {
  return { __html: escapeHtml(body).replaceAll("\n", "<br />") };
}

/* ------------------------------------------------------------------ */
/*  User Turn  (right-aligned)                                        */
/* ------------------------------------------------------------------ */

interface UserTurnProps {
  message: Message;
}

function AttachmentFigure({ attachment }: { attachment: ImageAttachment }) {
  const [failed, setFailed] = useState(false);

  return (
    <figure className="w-36 overflow-hidden rounded-xl border border-line bg-white/90 shadow-sm">
      {failed ? (
        <div className="flex h-[100px] flex-col items-center justify-center gap-1 bg-line/55 px-3 text-center text-xs text-muted">
          <AlertCircle className="h-4 w-4" />
          <span>Image unavailable</span>
        </div>
      ) : (
        <img
          src={toFileUrl(attachment.path)}
          alt={attachment.name}
          className="block w-full h-[100px] object-cover bg-line"
          onError={() => setFailed(true)}
        />
      )}
      <figcaption className="px-2.5 py-2 text-xs text-muted truncate">
        {attachment.name}
      </figcaption>
    </figure>
  );
}

export function UserTurn({ message }: UserTurnProps) {
  const hasBody = message.body.trim().length > 0;

  return (
    <div className="flex items-start gap-2.5 justify-end">
      <div className="grid gap-2 justify-items-end max-w-[70%]">
        <span className="text-[11px] font-semibold text-soft uppercase tracking-wider pr-1">
          User
        </span>

        {message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-end">
            {message.attachments.map((att) => (
              <AttachmentFigure key={att.id ?? att.path} attachment={att} />
            ))}
          </div>
        )}

        {hasBody && (
          <div
            className="rounded-2xl bg-accent text-[#fffdf9] border border-accent/20 px-4 py-3 text-[15px] leading-relaxed break-words"
            dangerouslySetInnerHTML={renderBody(message.body)}
          />
        )}
      </div>

      <div className="shrink-0 w-7 h-7 rounded-full bg-accent/10 flex items-center justify-center mt-0.5">
        <User className="h-3.5 w-3.5 text-accent/70" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Assistant Turn  (left-aligned, inline tool cards in message flow)  */
/* ------------------------------------------------------------------ */

type TurnItem =
  | { kind: "text"; msg: Message }
  | { kind: "toolCalls"; toolCalls: ToolCallInfo[]; msgId: string }
  | { kind: "error"; msg: Message };

function buildTurnItems(messages: Message[]): TurnItem[] {
  const items: TurnItem[] = [];
  for (const msg of messages) {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      items.push({ kind: "toolCalls", toolCalls: msg.toolCalls, msgId: msg.id });
    } else if (msg.role === "error") {
      items.push({ kind: "error", msg });
    } else if (msg.role === "assistant" && msg.body.trim()) {
      items.push({ kind: "text", msg });
    }
  }
  return collapseDuplicateAssistantTextItems(items);
}

interface AssistantTurnProps {
  messages: Message[];
  turnCost?: MessageTurnCost;
  isLast: boolean;
  isRunning: boolean;
}

export function AssistantTurn({
  messages,
  turnCost,
  isLast,
  isRunning,
}: AssistantTurnProps) {
  const items = buildTurnItems(messages);
  const allToolCalls = messages.flatMap((m) => m.toolCalls ?? []);
  const hasPendingTools = allToolCalls.some((tc) => tc.status === "pending");
  const showStatus = isLast && isRunning;

  if (items.length === 0 && !showStatus) return null;

  return (
    <div className="flex gap-3 max-w-[760px]">
      <div className="shrink-0 w-7 h-7 rounded-full bg-positive/12 flex items-center justify-center mt-0.5">
        <Bot className="h-3.5 w-3.5 text-positive" />
      </div>

      <div className="flex-1 min-w-0 grid gap-2">
        <span className="text-[11px] font-semibold text-soft uppercase tracking-wider">
          Agent
        </span>

        {items.map((item) => {
          switch (item.kind) {
            case "text":
              return (
                <MarkdownContent
                  key={item.msg.id}
                  content={item.msg.body}
                  className="text-[15px] leading-relaxed text-text"
                />
              );
            case "toolCalls":
              return (
                <div key={item.msgId} className="grid gap-1">
                  {item.toolCalls.map((tc) => (
                    <ToolCallCard key={tc.id} toolCall={tc} />
                  ))}
                </div>
              );
            case "error":
              return (
                <div
                  key={item.msg.id}
                  className="flex items-start gap-2 rounded-xl bg-error/5 border border-error/10 px-3.5 py-2.5 text-sm text-error"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span dangerouslySetInnerHTML={renderBody(item.msg.body)} />
                </div>
              );
          }
        })}

        {showStatus && (
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium bg-warning/10 text-warning animate-pulse">
              {hasPendingTools ? (
                <>
                  <Wrench className="h-3 w-3" />
                  Using Tools
                </>
              ) : (
                <>
                  <Brain className="h-3 w-3" />
                  Thinking
                </>
              )}
            </div>
          </div>
        )}

        {turnCost && !showStatus && (
          <p
            className="text-[11px] text-muted pt-0.5"
            title="Estimated API cost for this reply"
          >
            {formatCostUsd(turnCost.costUsd)}
            {turnCost.inputTokens !== undefined && turnCost.outputTokens !== undefined
              ? ` · ${turnCost.inputTokens.toLocaleString()} in / ${turnCost.outputTokens.toLocaleString()} out`
              : ""}
          </p>
        )}
      </div>
    </div>
  );
}
