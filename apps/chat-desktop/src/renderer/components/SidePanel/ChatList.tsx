import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatListItem } from "./ChatListItem";
import { useApp } from "@/context/AppContext";
import { getDesktopConfig } from "@/hooks/useDesktopConfig";
import type { ImageAttachment, Message, SerializedMessage } from "@/types";

function restoreAttachments(
  attachments: ImageAttachment[] | undefined,
  messageIndex: number,
): ImageAttachment[] {
  return (attachments ?? []).map((attachment, attachmentIndex) => ({
    ...attachment,
    id: attachment.id || `restored-${messageIndex}-att-${attachmentIndex}`,
  }));
}

function toRestoredMessages(messages: SerializedMessage[]): Message[] {
  return messages.map((m, i) => ({
    id: `restored-${i}`,
    role: m.role,
    body: m.body,
    attachments: restoreAttachments(m.attachments, i),
    toolCalls: m.toolCalls,
  }));
}

function restoreSnapshotMessages(
  sessionMessages: SerializedMessage[],
  localMessages: SerializedMessage[] | undefined,
): Message[] {
  const localByBody = new Map<string, SerializedMessage[]>();
  for (const message of localMessages ?? []) {
    if (!message.attachments || message.attachments.length === 0) continue;
    const key = `${message.role}\n${message.body}`;
    const bucket = localByBody.get(key) ?? [];
    bucket.push(message);
    localByBody.set(key, bucket);
  }

  return sessionMessages.map((m, i) => {
    const sameSlot = localMessages?.[i];
    let attachments =
      sameSlot?.role === m.role && sameSlot.body === m.body
        ? sameSlot.attachments
        : undefined;

    if (!attachments || attachments.length === 0) {
      const bucket = localByBody.get(`${m.role}\n${m.body}`);
      attachments = bucket?.shift()?.attachments;
    }

    return {
      id: `restored-${i}`,
      role: m.role,
      body: m.body,
      attachments: restoreAttachments(attachments, i),
      toolCalls: m.toolCalls,
    };
  });
}

export function ChatList() {
  const { workspace, agentRun } = useApp();
  const { threadGroups, threadId, setThreadId, startNewChat, findLocalThread, currentWorkspace,
    upsertLocalThread, saveThreadSnapshot, deleteThread } =
    workspace;
  const { isRunBusy, resetConversation, setMessages, setSessionId } =
    agentRun;
  const config = getDesktopConfig();

  const handleSelectThread = async (id: string) => {
    if (isRunBusy) return;
    setThreadId(id);
    resetConversation();
    if (!currentWorkspace) return;

    const local = findLocalThread(currentWorkspace.path, id);
    const hasLocalMessages = local && local.messages.length > 0;
    const hasToolCalls = hasLocalMessages && local.messages.some(
      (m) => m.toolCalls && m.toolCalls.length > 0,
    );

    if (hasLocalMessages && hasToolCalls) {
      setMessages(toRestoredMessages(local.messages));
      setSessionId(local.runSessionIds[0] ?? id);
      return;
    }

    const sessionThreadId = local?.runSessionIds[0] ?? id;
    const canLoadSnapshot = !!config.loadSessionThread;

    if (canLoadSnapshot) {
      try {
        const session = await config.loadSessionThread!(currentWorkspace.path, sessionThreadId);
        if (session && session.messages.length > 0) {
          const restoredMessages = restoreSnapshotMessages(session.messages, local?.messages);
          setMessages(restoredMessages);
          setSessionId(sessionThreadId);

          const thread = {
            id: local?.id ?? session.id,
            title: local?.title ?? session.title,
            summary: local?.summary ?? session.summary,
            updatedAt: local?.updatedAt ?? session.updatedAt,
            runSessionIds: local?.runSessionIds ?? [session.id],
            messages: restoredMessages.map(({ id: _id, ...message }) => ({
              ...message,
              attachments: message.attachments.length > 0 ? message.attachments : undefined,
            })),
          };
          upsertLocalThread(currentWorkspace.path, thread);
          void saveThreadSnapshot(currentWorkspace.path, thread);
          return;
        }
      } catch {
        /* fall through to local fallback */
      }
    }

    if (hasLocalMessages) {
      setMessages(toRestoredMessages(local.messages));
      setSessionId(local.runSessionIds[0] ?? id);
    } else if (local) {
      setSessionId(local.runSessionIds[0] ?? id);
    }
  };

  const handleDeleteThread = async (id: string) => {
    if (isRunBusy || !currentWorkspace) return;
    if (id === threadId) {
      setThreadId(null);
      resetConversation();
    }
    await deleteThread(currentWorkspace.path, id);
  };

  const handleNewChat = () => {
    if (isRunBusy) return;
    startNewChat();
    resetConversation();
  };

  return (
    <div className="flex flex-col min-h-0 flex-1 gap-2">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-medium text-soft uppercase tracking-wider">
          Chats
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleNewChat}
          disabled={isRunBusy}
          className="h-7 px-2 text-xs gap-1"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="grid gap-1 pr-2">
          {threadGroups.length === 0 ? (
            <p className="text-xs text-muted px-3 py-4 border border-line rounded-2xl bg-white/60">
              No saved threads yet for this codebase.
            </p>
          ) : (
            threadGroups.map((group) => (
              <div key={group.label} className="grid gap-1">
                <p className="text-[11px] font-medium text-soft uppercase tracking-wider px-1 pt-2">
                  {group.label}
                </p>
                {group.threads.map((thread) => (
                  <ChatListItem
                    key={thread.id}
                    thread={thread}
                    isSelected={thread.id === threadId}
                    disabled={isRunBusy}
                    onClick={() => void handleSelectThread(thread.id)}
                    onDelete={() => void handleDeleteThread(thread.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
