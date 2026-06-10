import type { AgentEvent, AgentImageAttachment, AgentRunMode } from "@lattice-code/shared-types";

export interface RunTaskInput {
  sessionId: string;
  prompt: string;
  attachments?: AgentImageAttachment[];
  signal?: AbortSignal;
  runMode?: AgentRunMode;
}

export type EventSink = (event: AgentEvent) => void;

export interface AgentEngine {
  runTask(input: RunTaskInput, emit: EventSink): Promise<void>;
}
