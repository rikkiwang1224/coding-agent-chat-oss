import type { Message } from "@/types";

function normalizeMessageBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

export function isDuplicateAssistantBody(a: string, b: string): boolean {
  const left = normalizeMessageBody(a);
  const right = normalizeMessageBody(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const minLen = Math.min(left.length, right.length);
  if (minLen < 80) return false;

  return left.startsWith(right) || right.startsWith(left);
}

function findLastAssistantWithBody(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].body.trim()) return i;
  }
  return -1;
}

export function applyAssistantSummary(
  messages: Message[],
  summary: string,
  activeId: string | null,
  createId: () => string,
): Message[] {
  const trimmed = summary.trim();
  if (!trimmed) return messages;

  if (activeId) {
    return messages.map((m) => (m.id === activeId ? { ...m, body: summary } : m));
  }

  const lastIdx = findLastAssistantWithBody(messages);
  if (lastIdx >= 0) {
    const existingBody = messages[lastIdx].body;
    if (isDuplicateAssistantBody(existingBody, summary)) {
      if (trimmed.length > existingBody.trim().length) {
        return messages.map((m, i) => (i === lastIdx ? { ...m, body: summary } : m));
      }
      return messages;
    }
  }

  return [
    ...messages,
    {
      id: createId(),
      role: "assistant" as const,
      body: summary,
      attachments: [],
    },
  ];
}

function dedupeAssistantTextsInSlice(slice: Message[]): Message[] {
  const assistantTexts = slice.filter(
    (m) => m.role === "assistant" && m.body.trim(),
  );
  if (assistantTexts.length <= 1) return slice;

  const canonical = assistantTexts.reduce((best, current) =>
    current.body.trim().length >= best.body.trim().length ? current : best,
  );

  const removeIds = new Set(
    assistantTexts
      .filter(
        (m) =>
          m.id !== canonical.id &&
          isDuplicateAssistantBody(m.body, canonical.body),
      )
      .map((m) => m.id),
  );

  if (removeIds.size === 0) return slice;
  return slice.filter((m) => !removeIds.has(m.id));
}

export function dedupeAssistantTextsInLatestTurn(messages: Message[]): Message[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const prefix = messages.slice(0, lastUserIdx + 1);
  const turn = messages.slice(lastUserIdx + 1);
  const dedupedTurn = dedupeAssistantTextsInSlice(turn);
  if (dedupedTurn.length === turn.length) return messages;
  return [...prefix, ...dedupedTurn];
}

export function dedupeAssistantTextsInAllTurns(messages: Message[]): Message[] {
  const output: Message[] = [];
  let turnBuffer: Message[] = [];

  const flushTurn = (): void => {
    if (turnBuffer.length === 0) return;
    output.push(...dedupeAssistantTextsInSlice(turnBuffer));
    turnBuffer = [];
  };

  for (const message of messages) {
    if (message.role === "user") {
      flushTurn();
      output.push(message);
    } else {
      turnBuffer.push(message);
    }
  }
  flushTurn();
  return output;
}

export function collapseDuplicateAssistantTextItems<T extends { kind: string; msg?: Message }>(
  items: T[],
): T[] {
  const collapsed: T[] = [];

  for (const item of items) {
    if (item.kind !== "text" || !item.msg) {
      collapsed.push(item);
      continue;
    }

    const prev = collapsed[collapsed.length - 1];
    if (prev?.kind === "text" && prev.msg) {
      const existing = prev.msg.body;
      const incoming = item.msg.body;
      if (isDuplicateAssistantBody(existing, incoming)) {
        if (incoming.trim().length >= existing.trim().length) {
          collapsed[collapsed.length - 1] = item;
        }
        continue;
      }
    }

    collapsed.push(item);
  }

  return collapsed;
}
