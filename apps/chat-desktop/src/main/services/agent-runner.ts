import { randomUUID } from "node:crypto";
import { type IpcMainInvokeEvent, type WebContents } from "electron";
import { HarnessEngine, SessionStore } from "@lattice-code/harness";
import type { AgentEvent } from "@lattice-code/shared-types";
import type { PermissionRequestOutcome } from "@lattice-code/shared-types";
import { collapseText, readTextBlock, formatError } from "../utils/text.js";
import { readImageAttachments } from "../utils/image.js";
import { loadSettings, buildLlmConfigFromSettingsGeneral } from "./settings.js";
import {
  createPermissionCallback,
  respondPermission,
  denyAllPendingPermissions,
} from "./permission-handler.js";

// ── Types ──

export interface StartAgentRunInput {
  prompt?: string;
  workspaceRoot?: string;
  sessionId?: string;
  threadContext?: string;
  imageAttachments?: unknown[];
  runMode?: "run" | "resume";
}

export interface StartAgentRunResult {
  sessionId: string;
}

interface ActiveAgentConnection {
  sender: WebContents;
  sessionId: string;
  abortController: AbortController;
  engine: HarnessEngine;
}

// ── State ──

const activeAgentConnections = new Map<number, ActiveAgentConnection>();

// ── Helpers ──

function emitAgentEvent(sender: WebContents, payload: unknown): void {
  if (sender.isDestroyed()) return;
  sender.send("chat-desktop:agent-event", payload);
}

function buildAgentErrorEvent(sessionId: string, error: string): Record<string, unknown> {
  return {
    type: "agent.error",
    sessionId,
    taskId: "chat-desktop-transport",
    timestamp: new Date().toISOString(),
    payload: { error, status: "failed", recoverable: false },
  };
}

export function disconnectActiveAgent(senderId: number, expectedSessionId?: string): void {
  const conn = activeAgentConnections.get(senderId);
  if (!conn) return;
  if (expectedSessionId && conn.sessionId !== expectedSessionId) return;
  denyAllPendingPermissions(conn.sessionId);
  activeAgentConnections.delete(senderId);
  conn.abortController.abort("User cancelled or window closed");
}

export function disconnectAllAgents(): void {
  for (const senderId of activeAgentConnections.keys()) {
    disconnectActiveAgent(senderId);
  }
}

function extractUserRequest(rawPrompt: unknown): string {
  const prompt = typeof rawPrompt === "string" ? rawPrompt : "";
  if (!prompt) return "";
  const marker = "[USER_REQUEST]";
  const idx = prompt.lastIndexOf(marker);
  return idx < 0 ? prompt : prompt.slice(idx + marker.length).trim();
}

function buildAgentPromptEnvelope(input: { prompt: string; workspaceRoot: string; threadContext?: string }): string {
  const sections = [`[WORKSPACE_ROOT] ${input.workspaceRoot}`];
  const tc = input.threadContext?.trim();
  if (tc) sections.push("[THREAD_CONTEXT]", tc);
  sections.push("[USER_REQUEST]", input.prompt.trim() || "Please analyze the attached image(s).");
  return sections.join("\n");
}

function buildResumePrompt(workspaceRoot: string, userRequest: string): string {
  return [`[WORKSPACE_ROOT] ${workspaceRoot}`, "[USER_REQUEST]", userRequest || "Continue."].join("\n");
}

export function handleRespondPermission(
  requestId: string,
  outcome: PermissionRequestOutcome,
): boolean {
  return respondPermission(requestId, outcome, (toolName, key) => {
    for (const conn of activeAgentConnections.values()) {
      const guard = conn.engine.getPermissionGuard();
      guard.addAlwaysAllow(key || toolName);
    }
  });
}

// ── Run ──

export async function startAgentRun(
  event: IpcMainInvokeEvent,
  input: StartAgentRunInput | undefined,
): Promise<StartAgentRunResult> {
  const prompt = readTextBlock(input?.prompt);
  const threadContext = readTextBlock(input?.threadContext);
  const imageAttachments = readImageAttachments(input?.imageAttachments);
  const workspaceRoot = collapseText(input?.workspaceRoot);
  const runMode = input?.runMode === "resume" ? "resume" : "run";
  const sessionId =
    runMode === "resume" && collapseText(input?.sessionId)
      ? collapseText(input!.sessionId)!
      : collapseText(input?.sessionId) || randomUUID();
  const senderId = event.sender.id;

  if (!prompt && imageAttachments.length === 0) throw new Error("Prompt or image attachment is required");
  if (!workspaceRoot) throw new Error("Workspace root is required");
  if (activeAgentConnections.has(senderId)) throw new Error("An agent run is already in progress");

  const sessionStore = SessionStore.forWorkspace(workspaceRoot);
  let harnessResume = false;
  if (runMode === "resume") {
    const existing = await sessionStore.load(sessionId);
    harnessResume = Boolean(existing?.messages?.length);
  }

  const userRequest = extractUserRequest(prompt) || prompt;
  const runPrompt = harnessResume
    ? buildResumePrompt(workspaceRoot, userRequest)
    : buildAgentPromptEnvelope({ prompt: userRequest, workspaceRoot, threadContext });

  const abortController = new AbortController();
  const settings = await loadSettings();
  const llmConfig = buildLlmConfigFromSettingsGeneral(settings.general);

  if (!llmConfig?.apiKey) {
    throw new Error("API key is required. Please configure it in Settings.");
  }

  const engine = new HarnessEngine({
    workspaceRoot,
    sessionStore,
    persistSession: true,
    trace: {
      enabled: true,
      runKind: "desktop",
      runId: sessionId,
      workspaceRoot,
    },
    config: {
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl || "https://api.deepseek.com",
      model: llmConfig.primaryModel || "deepseek-v4-pro",
      provider: llmConfig.provider,
    },
    onPermissionConfirm: createPermissionCallback(
      event.sender,
      sessionId,
      emitAgentEvent,
      (toolName, key) => {
        engine.getPermissionGuard().addAlwaysAllow(key || toolName);
      },
    ),
  });

  activeAgentConnections.set(senderId, {
    sender: event.sender,
    sessionId,
    abortController,
    engine,
  });

  const emit = (agentEvent: AgentEvent) => {
    emitAgentEvent(event.sender, agentEvent);
    if (agentEvent.type === "agent.done" || agentEvent.type === "agent.error") {
      activeAgentConnections.delete(senderId);
    }
  };

  engine
    .runTask(
      {
        sessionId,
        prompt: runPrompt,
        signal: abortController.signal,
        runMode: runMode === "resume" ? "resume" : undefined,
      },
      emit,
    )
    .catch((error) => {
      emitAgentEvent(event.sender, buildAgentErrorEvent(sessionId, formatError(error)));
      activeAgentConnections.delete(senderId);
    });

  return { sessionId };
}
