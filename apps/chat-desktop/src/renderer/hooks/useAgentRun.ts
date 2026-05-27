import { useCallback, useEffect, useRef, useState } from "react";
import { getDesktopConfig } from "./useDesktopConfig";
import type {
  AgentEvent,
  Message,
  RunState,
  ImageAttachment,
  ToolCallInfo,
} from "@/types";
import type { AgentRunMetrics, PermissionRequestOutcome } from "@forgelet/shared-types";
import { tagLatestAssistantTurn } from "@/lib/run-cost";
import {
  applyAssistantSummary,
  dedupeAssistantTextsInLatestTurn,
} from "@/lib/message-dedupe";
import type { PendingPermissionRequest } from "@/components/ChatArea/PermissionDialog";

let messageCounter = 0;
function nextMessageId(): string {
  messageCounter += 1;
  return `msg-${messageCounter}`;
}

function updateToolCallStatus(
  msgs: Message[],
  toolCallId: string,
  status: "success" | "error",
  output: string | undefined,
  error: string | undefined,
): Message[] {
  if (toolCallId) {
    const idx = msgs.findIndex((m) =>
      m.toolCalls?.some((tc) => tc.id === toolCallId),
    );
    if (idx >= 0) {
      const updated = [...msgs];
      updated[idx] = {
        ...updated[idx],
        toolCalls: updated[idx].toolCalls!.map((tc) =>
          tc.id === toolCallId
            ? { ...tc, status, output: output ?? tc.output, error: error ?? tc.error }
            : tc,
        ),
      };
      return updated;
    }
  }

  for (let i = 0; i < msgs.length; i++) {
    const pending = msgs[i].toolCalls?.find((tc) => tc.status === "pending");
    if (pending) {
      const updated = [...msgs];
      updated[i] = {
        ...updated[i],
        toolCalls: updated[i].toolCalls!.map((tc) =>
          tc.id === pending.id
            ? { ...tc, status, output: output ?? tc.output, error: error ?? tc.error }
            : tc,
        ),
      };
      return updated;
    }
  }

  return msgs;
}

function sweepPendingToolCalls(msgs: Message[]): Message[] {
  let changed = false;
  const result = msgs.map((m) => {
    if (!m.toolCalls?.some((tc) => tc.status === "pending")) return m;
    changed = true;
    return {
      ...m,
      toolCalls: m.toolCalls!.map((tc) =>
        tc.status === "pending" ? { ...tc, status: "success" as const } : tc,
      ),
    };
  });
  return changed ? result : msgs;
}

export interface AgentRunHook {
  messages: Message[];
  runState: RunState;
  runError: string;
  sessionId: string | null;
  composerAttachments: ImageAttachment[];
  setComposerAttachments: React.Dispatch<
    React.SetStateAction<ImageAttachment[]>
  >;
  sendPrompt: (
    prompt: string,
    workspaceRoot: string,
  ) => Promise<{ sessionId?: string }>;
  resumePrompt: (
    prompt: string,
    workspaceRoot: string,
    sessionIdOverride?: string,
  ) => Promise<{ sessionId?: string }>;
  resetConversation: () => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  isRunBusy: boolean;
  pendingPermission: PendingPermissionRequest | null;
  respondToPermission: (outcome: PermissionRequestOutcome) => void;
  runMetrics: AgentRunMetrics | null;
}

export function useAgentRun(): AgentRunHook {
  const config = getDesktopConfig();
  const [messages, setMessages] = useState<Message[]>([]);
  const [runState, setRunState] = useState<RunState>("idle");
  const [runError, setRunError] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<
    ImageAttachment[]
  >([]);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermissionRequest | null>(null);
  const [runMetrics, setRunMetrics] = useState<AgentRunMetrics | null>(null);

  const activeAssistantIdRef = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const isRunBusy = runState === "connecting" || runState === "running";

  const appendAssistantDelta = useCallback((delta: string) => {
    if (!delta) return;
    setMessages((prev) => {
      const activeId = activeAssistantIdRef.current;
      if (activeId) {
        const idx = prev.findIndex((m) => m.id === activeId);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], body: updated[idx].body + delta };
          return updated;
        }
      }
      const id = nextMessageId();
      activeAssistantIdRef.current = id;
      return [
        ...prev,
        { id, role: "assistant", body: delta, attachments: [], toolCalls: [] },
      ];
    });
  }, []);

  const pushMessage = useCallback(
    (role: Message["role"], body: string) => {
      if (!body) return;
      setMessages((prev) => [
        ...prev,
        { id: nextMessageId(), role, body, attachments: [] },
      ]);
    },
    [],
  );

  const handleAgentEvent = useCallback(
    (event: AgentEvent) => {
      if (!event || typeof event !== "object") return;
      const payload = (event.payload ?? event) as Record<string, unknown>;
      const eventType = event.type ?? "agent.event";

      if (event.sessionId) setSessionId(event.sessionId);

      switch (eventType) {
        case "agent.started":
          setRunState("running");
          break;

        case "agent.progress": {
          setRunState("running");
          const stage = String(payload.stage ?? "progress");
          const msg = String(payload.message ?? "");
          pushMessage("system", msg ? `[${stage}] ${msg}` : `[${stage}]`);
          break;
        }

        case "agent.delta": {
          setRunState("running");
          appendAssistantDelta(String(payload.delta ?? ""));
          break;
        }

        case "tool.called": {
          activeAssistantIdRef.current = null;
          const toolName = String(payload.toolName ?? "tool");
          const toolCallId =
            String(payload.toolCallId ?? "") || nextMessageId();
          const input =
            (payload.input as Record<string, unknown> | undefined) ??
            (payload.args as Record<string, unknown> | undefined);
          const toolCall: ToolCallInfo = {
            id: toolCallId,
            toolName,
            status: "pending",
            input,
          };
          setMessages((prev) => [
            ...prev,
            {
              id: nextMessageId(),
              role: "system",
              body: `Calling ${toolName}`,
              attachments: [],
              toolCalls: [toolCall],
            },
          ]);
          break;
        }

        case "tool.output": {
          const toolCallId = String(payload.toolCallId ?? "");
          const output = String(payload.output ?? "");
          setMessages((prev) =>
            updateToolCallStatus(prev, toolCallId, "success", output, undefined),
          );
          break;
        }

        case "tool.error": {
          const toolName = String(payload.toolName ?? "tool");
          const error = String(payload.error ?? "Tool execution failed");
          const toolCallId = String(payload.toolCallId ?? "");
          const updated = updateToolCallStatus(
            messagesRef.current,
            toolCallId,
            "error",
            undefined,
            error,
          );
          if (updated !== messagesRef.current) {
            setMessages(updated);
          } else {
            pushMessage("error", `${toolName}: ${error}`);
          }
          break;
        }

        case "tool.permission_request": {
          const requestId = String(payload.requestId ?? "");
          if (!requestId) break;
          setPendingPermission({
            requestId,
            toolName: String(payload.toolName ?? "tool"),
            args: (payload.args as Record<string, unknown>) ?? {},
            reason: String(payload.reason ?? "Confirmation required"),
          });
          break;
        }

        case "agent.done": {
          setPendingPermission(null);
          setRunState("completed");
          setRunError("");
          const metrics = payload.metrics as AgentRunMetrics | undefined;
          if (metrics && typeof metrics === "object") {
            setRunMetrics(metrics);
          }
          const summary = String(payload.summary ?? "");
          setMessages((prev) => {
            let updated = sweepPendingToolCalls(prev);
            if (summary) {
              updated = applyAssistantSummary(
                updated,
                summary,
                activeAssistantIdRef.current,
                nextMessageId,
              );
              updated = dedupeAssistantTextsInLatestTurn(updated);
            }
            if (metrics?.totalCostUsd !== undefined) {
              updated = tagLatestAssistantTurn(updated, {
                costUsd: metrics.totalCostUsd,
                inputTokens: metrics.runInputTokens,
                outputTokens: metrics.runOutputTokens,
              });
            }
            return updated;
          });
          activeAssistantIdRef.current = null;
          break;
        }

        case "agent.error": {
          setPendingPermission(null);
          const error = String(
            (payload.error as string) || "Agent run failed",
          );
          const status = String(payload.status ?? "");
          setRunState(status === "cancelled" ? "cancelled" : "failed");
          setRunError(error);
          activeAssistantIdRef.current = null;
          setMessages((prev) => {
            const swept = sweepPendingToolCalls(prev);
            const errorMsg: Message = {
              id: nextMessageId(),
              role: error === "Run cancelled by user" ? "system" : "error",
              body: error,
              attachments: [],
            };
            return [...swept, errorMsg];
          });
          break;
        }
      }
    },
    [appendAssistantDelta, pushMessage, sessionId],
  );

  useEffect(() => {
    if (!config.onAgentEvent) return;
    config.onAgentEvent((event) => handleAgentEvent(event));
  }, [config, handleAgentEvent]);

  const prepareUserMessage = useCallback(
    (prompt: string) => {
      const imageAttachments = composerAttachments.map((a) => ({
        path: a.path,
        name: a.name,
        mediaType: a.mediaType,
      }));
      setMessages((prev) => [
        ...prev,
        {
          id: nextMessageId(),
          role: "user",
          body: prompt,
          attachments: [...composerAttachments],
        },
      ]);
      setComposerAttachments([]);
      setRunState("connecting");
      setRunError("");
      return imageAttachments;
    },
    [composerAttachments],
  );

  const sendPrompt = useCallback(
    async (
      prompt: string,
      workspaceRoot: string,
    ): Promise<{ sessionId?: string }> => {
      if (!config.startRun || isRunBusy) return {};
      const imageAttachments = prepareUserMessage(prompt);

      try {
        const result = await config.startRun({
          prompt,
          workspaceRoot,
          imageAttachments,
        });
        if (result?.sessionId) {
          setSessionId(result.sessionId);
        }
        setRunState("running");
        return { sessionId: result?.sessionId };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to dispatch the run";
        setRunState("failed");
        setRunError(msg);
        pushMessage("error", msg);
        return {};
      }
    },
    [config, isRunBusy, prepareUserMessage, pushMessage],
  );

  const resumePrompt = useCallback(
    async (
      prompt: string,
      workspaceRoot: string,
      sessionIdOverride?: string,
    ): Promise<{ sessionId?: string }> => {
      const activeSessionId = sessionIdOverride ?? sessionId;
      if (!config.resumeRun || isRunBusy || !activeSessionId) return {};
      const imageAttachments = prepareUserMessage(prompt);

      try {
        const result = await config.resumeRun({
          prompt,
          workspaceRoot,
          sessionId: activeSessionId,
          imageAttachments,
        });
        if (result?.sessionId) {
          setSessionId(result.sessionId);
        }
        setRunState("running");
        return { sessionId: result?.sessionId };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to resume the run";
        setRunState("failed");
        setRunError(msg);
        pushMessage("error", msg);
        return {};
      }
    },
    [config, isRunBusy, sessionId, prepareUserMessage, pushMessage],
  );

  const respondToPermission = useCallback(
    (outcome: PermissionRequestOutcome) => {
      if (!pendingPermission || !config.respondPermission) return;
      const { requestId } = pendingPermission;
      setPendingPermission(null);
      void config.respondPermission(requestId, outcome);
    },
    [config, pendingPermission],
  );

  const resetConversation = useCallback(() => {
    setMessages([]);
    setRunState("idle");
    setRunError("");
    setRunMetrics(null);
    setSessionId(null);
    setComposerAttachments([]);
    setPendingPermission(null);
    activeAssistantIdRef.current = null;
  }, []);

  return {
    messages,
    runState,
    runError,
    sessionId,
    composerAttachments,
    setComposerAttachments,
    sendPrompt,
    resumePrompt,
    resetConversation,
    setMessages,
    setSessionId,
    isRunBusy,
    pendingPermission,
    respondToPermission,
    runMetrics,
  };
}
