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
 *   - if the LLM call errors or the JSON output is unparseable, we fall back
 *     to `ship` so a broken Sensor never blocks a passing run.
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

const DEFAULT_SYSTEM_PROMPT = `You are an independent, adversarial code reviewer. The coding agent thinks it's done fixing the issue below. Your job is to find what's missing or wrong — do not be polite, do not assume the agent is correct.

Common failure modes to check (be ruthless):
1. Issue specifics ignored: did the patch handle the SPECIFIC class names, error codes, warning IDs, type names, or examples called out in the issue?
2. Edge cases dropped: nested structures, empty collections, None/null, Unicode, non-serializable objects, recursion, threading, generators.
3. Wrong abstraction layer: was the fix made at the call site instead of the utility, or vice versa? Is there an existing helper in the codebase the patch should have used instead of inlining logic?
4. Scope creep: did the patch modify unrelated files / change behavior the issue didn't ask for?
5. Verification skipped: did the agent run the EXACT failing test from the issue, or only generic tests / unrelated tests?
6. Imports / public API: are new imports correct? Were exports updated? Did private symbols leak?

Output a SINGLE JSON object — nothing else, no markdown fences:

{
  "verdict": "ship" | "revise",
  "confidence": "high" | "medium" | "low",
  "rationale": "one sentence: why ship or why revise",
  "missed_cases": [{"what": "...", "where": "file:line or test name"}],
  "suggestions": ["concrete change 1", "concrete change 2"]
}

Rules:
- Prefer "ship" only if the diff appears to fully address the issue with no obvious gaps.
- If the diff is EMPTY (no changes at all) and the issue is non-trivial, ALWAYS revise.
- "missed_cases" and "suggestions" should be specific and actionable, not generic advice.
- Output VALID JSON only. No prose before or after.`;

const REASON_MAX_TOKENS = 1024;

export async function runReason(input: ReasonInput, options: ReasonOptions): Promise<ReasonResult> {
  const client = new LlmClient({
    ...options.config,
    // Force non-thinking mode for the Sensor — we want a fast, structured verdict,
    // not a long chain-of-thought. Output is small (<1k tokens) so a thinking
    // budget would just inflate cost without changing the answer.
    thinking: false,
    reasoningEffort: undefined,
    maxTokens: REASON_MAX_TOKENS,
  });

  const userPrompt = buildUserPrompt(input);
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPromptOverride ?? DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  try {
    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens: number | undefined;

    for await (const chunk of client.stream({ messages, signal: options.signal })) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) fullText += delta.content;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        if (typeof chunk.usage.prompt_cache_hit_tokens === "number") {
          cacheReadInputTokens = chunk.usage.prompt_cache_hit_tokens;
        }
      }
    }

    const parsed = parseReasonOutput(fullText);
    return {
      ...parsed,
      rawText: fullText,
      tokenUsage: { inputTokens, outputTokens, cacheReadInputTokens },
    };
  } catch (err) {
    // Sensor failure should never block the agent — fall back to ship and
    // include the error in rationale so it's visible in trace.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verdict: "ship",
      confidence: "low",
      rationale: `Reason sensor failed: ${msg.slice(0, 200)} (defaulting to ship)`,
    };
  }
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

  const claim = input.digest.lastClaim
    ? `\n\n## Agent's final claim\n> ${input.digest.lastClaim}`
    : "";

  return [
    `## Task / Issue\n${input.issueText.trim()}`,
    `## Current diff\n${diffBlock}`,
    renderActivityDigest(input.digest),
    claim,
    `\n\nNow output your JSON verdict.`,
  ].join("\n\n");
}

/** Extract the first JSON object from the model's output, tolerant of stray prose. */
export function parseReasonOutput(text: string): Omit<ReasonResult, "rawText" | "tokenUsage"> {
  const cleaned = stripCodeFences(text);

  // Find the first balanced { ... } JSON object.
  const start = cleaned.indexOf("{");
  if (start === -1) {
    return defaultShip(`No JSON object found in Sensor output`);
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
    return defaultShip(`Unbalanced JSON in Sensor output`);
  }

  const slice = cleaned.slice(start, end + 1);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(slice) as Record<string, unknown>;
  } catch (err) {
    return defaultShip(`Sensor JSON parse error: ${(err as Error).message.slice(0, 100)}`);
  }

  const verdict = parsed.verdict === "revise" ? "revise" : "ship";
  const confidence =
    parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? (parsed.confidence as "high" | "medium" | "low")
      : undefined;

  const result: Omit<ReasonResult, "rawText" | "tokenUsage"> = { verdict };
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

function stripCodeFences(text: string): string {
  // Strip leading ```json or ``` fence and trailing ```.
  return text
    .replace(/^[\s\u200b]*```(?:json)?\s*/i, "")
    .replace(/\s*```[\s\u200b]*$/i, "")
    .trim();
}

function defaultShip(rationale: string): Omit<ReasonResult, "rawText" | "tokenUsage"> {
  return { verdict: "ship", confidence: "low", rationale };
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
