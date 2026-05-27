import type { Message, MessageTurnCost, SerializedMessage } from "@/types";

export interface SessionRunSnapshot {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export function attachRunCostsToMessages<T extends Pick<Message, "role" | "turnCost">>(
  messages: T[],
  runs: SessionRunSnapshot[] | undefined,
): T[] {
  if (!runs?.length) return messages;

  const runsByTurn = new Map(runs.map((run) => [run.turnIndex, run]));
  const result = messages.map((message) => ({ ...message }));
  let userTurn = 0;

  for (let i = 0; i < result.length; i++) {
    if (result[i].role !== "user") continue;
    userTurn += 1;
    const run = runsByTurn.get(userTurn);
    if (!run || run.costUsd === undefined) continue;

    let tagIdx = i;
    for (let j = i + 1; j < result.length; j++) {
      if (result[j].role === "user") break;
      tagIdx = j;
    }
    if (tagIdx <= i) continue;

    const turnCost: MessageTurnCost = {
      costUsd: run.costUsd ?? 0,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
    };
    result[tagIdx] = { ...result[tagIdx], turnCost };
  }

  return result;
}

export function tagLatestAssistantTurn(
  messages: Message[],
  turnCost: MessageTurnCost,
): Message[] {
  const updated = messages.map((message) => ({ ...message }));
  let lastUserIdx = -1;
  for (let i = updated.length - 1; i >= 0; i--) {
    if (updated[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  let tagIdx = -1;
  for (let i = updated.length - 1; i > lastUserIdx; i--) {
    if (updated[i].role === "assistant" || updated[i].toolCalls?.length) {
      tagIdx = i;
      break;
    }
  }
  if (tagIdx < 0) return updated;

  updated[tagIdx] = { ...updated[tagIdx], turnCost };
  return updated;
}

export function serializeTurnCost(
  turnCost: MessageTurnCost | undefined,
): SerializedMessage["turnCost"] {
  if (!turnCost) return undefined;
  return {
    costUsd: turnCost.costUsd,
    inputTokens: turnCost.inputTokens,
    outputTokens: turnCost.outputTokens,
  };
}
