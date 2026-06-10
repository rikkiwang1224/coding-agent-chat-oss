/**
 * Reason — an independent "Sensor" LLM call that critically reviews whether
 * the agent's claimed-done state actually solves the task.
 *
 * Inspired by Cairn's Reason task (independent decision-maker reading the
 * Fact Board). Adapted as a "Path C / Hybrid" sensor:
 *
 *   Input  = (issue text, current diff, recent activity digest)
 *   Output = { verdict: "ship" | "revise", missed_cases, suggestions, ... }
 *
 * The Sensor sees a fresh model context with no memory of the agent's
 * reasoning, so its judgment is less biased than a self-check. It does
 * still see a structured activity digest (tool calls + outputs) so it knows
 * what the agent tried — without inheriting the agent's framing.
 *
 * Cost guard:
 *   - bounded by `maxRounds` (default 2): after 2 revise verdicts in a row,
 *     ship anyway so we don't spin forever.
 *   - typical per-call cost ≈ $0.003 on deepseek-v4-pro (5k in / 500 out).
 *
 * Failure mode:
 *   - if the LLM call errors, fall back to `ship` so a broken Sensor never blocks.
 *   - if output is unparseable after one retry, fall back to `revise` with generic
 *     scope/symmetry guidance so the agent at least re-checks before shipping.
 */
import type { ChatMessage, LlmConfig } from "./types.js";
import { LlmClient } from "./api-client.js";
import { renderActivityDigest, type ActivityDigest } from "./activity-digest.js";

export type ReasonVerdict = "ship" | "revise";

export interface ReasonMissedCase {
  what: string;
  where?: string;
}

export interface ReasonResult {
  verdict: ReasonVerdict;
  confidence?: "high" | "medium" | "low";
  rationale?: string;
  missed_cases?: ReasonMissedCase[];
  suggestions?: string[];
  /** Raw text returned by the model (for debugging / trace). */
  rawText?: string;
  /** Tokens used by this Sensor call. */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
  };
}

export interface ReasonInput {
  /** The original task / issue text. Required. */
  issueText: string;
  /** Current `git diff` against the baseline. May be empty if no changes yet. */
  currentDiff: string;
  /** Structured digest of recent agent activity (see activity-digest.ts). */
  digest: ActivityDigest;
}

export interface ReasonOptions {
  /** LLM config to use. Typically reuse the agent's config. */
  config: LlmConfig;
  /** Override the system prompt. Defaults to the adversarial reviewer template. */
  systemPromptOverride?: string;
  /** Abort signal — should propagate from the agent loop. */
  signal?: AbortSignal;
}

const DEFAULT_SYSTEM_PROMPT = `You are an independent, adversarial code reviewer. The coding agent thinks it's done. Find what's missing — do not assume the agent is correct.

Check ruthlessly:
1. Issue specifics: class names, error codes, types, examples from the issue.
2. Edge cases: empty/None, Unicode, nested structures, alternate code paths.
3. Wrong layer: fix at init vs update handler? utility vs call site?
4. Symmetry: horizontal↔vertical, get↔set, encode↔decode — same fix everywhere?
5. Hidden grading cases: the issue shows one reproduction; eval may test others you cannot run locally.

Reply with ONE JSON object only (no markdown, no prose before/after):
{"verdict":"ship"|"revise","confidence":"high"|"medium"|"low","rationale":"one sentence","missed_cases":[{"what":"...","where":"file or test"}],"suggestions":["concrete fix"]}

Rules:
- "ship" only if the diff fully covers the issue with no obvious gaps.
- Empty diff on a non-trivial issue → always "revise".
- Keep rationale under 200 chars; at most 5 missed_cases and 5 suggestions.`;

const REASON_MAX_TOKENS = 2048;
const REASON_ISSUE_MAX_CHARS = 6000;
const JSON_RETRY_USER = `Your previous reply was not valid JSON. Output ONLY one JSON object starting with { — no markdown fences, no explanation.`;

type ParsedReason = Omit<ReasonResult, "rawText" | "tokenUsage">;

interface ReasonCallResult {
  content: string;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

export async function runReason(input: ReasonInput, options: ReasonOptions): Promise<ReasonResult> {
  const client = new LlmClient({
    ...options.config,
    // Force non-thinking mode — JSON lands in `content`, not `reasoning_content`.
    thinking: false,
    reasoningEffort: undefined,
    responseFormat: "json_object",
    maxTokens: REASON_MAX_TOKENS,
  });

  const systemPrompt = options.systemPromptOverride ?? DEFAULT_SYSTEM_PROMPT;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildUserPrompt(input) },
  ];

  try {
    let call = await invokeReason(client, messages, options.signal);
    let parsed = parseReasonOutput(pickReasonText(call));

    if (isParseFallback(parsed)) {
      messages.push({
        role: "assistant",
        content: pickReasonText(call) || "(empty sensor output)",
      });
      messages.push({ role: "user", content: JSON_RETRY_USER });
      call = await invokeReason(client, messages, options.signal);
      parsed = parseReasonOutput(pickReasonText(call));
    }

    if (isParseFallback(parsed)) {
      parsed = defaultRevise(
        parsed.rationale ?? "Sensor output was not parseable JSON after retry",
      );
    }

    return {
      ...parsed,
      rawText: pickReasonText(call),
      tokenUsage: {
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cacheReadInputTokens: call.cacheReadInputTokens,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verdict: "ship",
      confidence: "low",
      rationale: `Reason sensor failed: ${msg.slice(0, 200)} (defaulting to ship)`,
    };
  }
}

async function invokeReason(
  client: LlmClient,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ReasonCallResult> {
  let content = "";
  let reasoning = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens: number | undefined;

  for await (const chunk of client.stream({ messages, signal })) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) content += delta.content;
    if (delta?.reasoning_content) reasoning += delta.reasoning_content;
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      if (typeof chunk.usage.prompt_cache_hit_tokens === "number") {
        cacheReadInputTokens = chunk.usage.prompt_cache_hit_tokens;
      }
    }
  }

  return { content, reasoning, inputTokens, outputTokens, cacheReadInputTokens };
}

function pickReasonText(call: ReasonCallResult): string {
  const content = call.content.trim();
  if (content) return call.content;
  return call.reasoning;
}

/** Truncate a diff so we don't blow the Sensor budget on huge patches. */
function truncateDiff(diff: string, maxChars = 8000): string {
  if (diff.length <= maxChars) return diff;
  const head = diff.slice(0, Math.floor(maxChars * 0.7));
  const tail = diff.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n\n... [truncated ${diff.length - maxChars} chars from middle of diff] ...\n\n${tail}`;
}

function buildUserPrompt(input: ReasonInput): string {
  const diff = input.currentDiff.trim();
  const diffBlock = diff
    ? `\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``
    : "(no changes yet — agent has not modified any files)";

  const issue = truncateText(input.issueText.trim(), REASON_ISSUE_MAX_CHARS);

  const claim = input.digest.lastClaim
    ? `\n\n## Agent's final claim\n> ${truncateText(input.digest.lastClaim, 800)}`
    : "";

  return [
    `## Task / Issue\n${issue}`,
    `## Current diff\n${diffBlock}`,
    renderActivityDigest(input.digest),
    claim,
    `\n\nOutput your JSON verdict now.`,
  ].join("\n\n");
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n... [truncated ${text.length - maxChars} chars] ...`;
}

/** Extract the first JSON object from the model's output, tolerant of stray prose. */
export function parseReasonOutput(text: string): ParsedReason {
  const cleaned = stripCodeFences(text);

  // Find the first balanced { ... } JSON object.
  const start = cleaned.indexOf("{");
  if (start === -1) {
    return parseFallback(`No JSON object found in Sensor output`);
  }

  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) {
    return parseFallback(`Unbalanced JSON in Sensor output`);
  }

  const slice = cleaned.slice(start, end + 1);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(slice) as Record<string, unknown>;
  } catch (err) {
    return parseFallback(`Sensor JSON parse error: ${(err as Error).message.slice(0, 100)}`);
  }

  const verdict = parsed.verdict === "revise" ? "revise" : "ship";
  const confidence =
    parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? (parsed.confidence as "high" | "medium" | "low")
      : undefined;

  const result: ParsedReason = { verdict };
  if (confidence) result.confidence = confidence;
  if (typeof parsed.rationale === "string") result.rationale = parsed.rationale.slice(0, 500);

  if (Array.isArray(parsed.missed_cases)) {
    result.missed_cases = (parsed.missed_cases as unknown[])
      .map((m) => {
        if (!m || typeof m !== "object") return null;
        const rec = m as Record<string, unknown>;
        const what = typeof rec.what === "string" ? rec.what : null;
        if (!what) return null;
        const where = typeof rec.where === "string" ? rec.where : undefined;
        return where ? { what, where } : { what };
      })
      .filter((m): m is ReasonMissedCase => m !== null)
      .slice(0, 10);
  }

  if (Array.isArray(parsed.suggestions)) {
    result.suggestions = (parsed.suggestions as unknown[])
      .filter((s): s is string => typeof s === "string")
      .slice(0, 10);
  }

  return result;
}

const PARSE_FALLBACK_MARK = "__reason_parse_fallback__";

function parseFallback(rationale: string): ParsedReason {
  return {
    verdict: "ship",
    confidence: "low",
    rationale: `${PARSE_FALLBACK_MARK}:${rationale}`,
  };
}

function isParseFallback(parsed: ParsedReason): boolean {
  return parsed.rationale?.startsWith(`${PARSE_FALLBACK_MARK}:`) ?? false;
}

function defaultRevise(rationale: string): ParsedReason {
  return {
    verdict: "revise",
    confidence: "low",
    rationale: rationale.replace(`${PARSE_FALLBACK_MARK}:`, ""),
    suggestions: [
      "Re-read the issue for cases beyond the reproduction example — grading tests may cover them.",
      "Check symmetric/paired methods and update handlers, not just initialization or the first code path you found.",
    ],
  };
}

function stripCodeFences(text: string): string {
  // Strip leading ```json or ``` fence and trailing ```.
  return text
    .replace(/^[\s\u200b]*```(?:json)?\s*/i, "")
    .replace(/\s*```[\s\u200b]*$/i, "")
    .trim();
}

/** Format a revise verdict as a user message to inject back into the agent loop. */
export function formatReasonFeedback(result: ReasonResult, round: number): string {
  const parts: string[] = [
    `[Independent reviewer feedback — round ${round}]`,
    `Verdict: REVISE${result.confidence ? ` (${result.confidence} confidence)` : ""}`,
  ];

  if (result.rationale) parts.push(`Rationale: ${result.rationale}`);

  if (result.missed_cases && result.missed_cases.length > 0) {
    parts.push("Missed cases:");
    for (const mc of result.missed_cases) {
      parts.push(`- ${mc.what}${mc.where ? ` (${mc.where})` : ""}`);
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    parts.push("Suggested fixes:");
    for (const s of result.suggestions) parts.push(`- ${s}`);
  }

  parts.push(
    "",
    "Please address these issues. When done, stop and produce a brief summary. If you believe the reviewer is wrong, explain why concisely instead of editing.",
  );

  return parts.join("\n");
}
