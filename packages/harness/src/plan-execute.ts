/**
 * Plan-Execute mode for complex tasks.
 * 
 * Phase 1 (Plan): The LLM analyzes the task and produces a structured plan.
 * Phase 2 (Execute): Each step is executed sequentially, with the ability to
 * revise the plan based on intermediate results.
 */

import type { ChatMessage, LlmConfig } from "./types.js";
import { LlmClient } from "./api-client.js";
import { AgentLoop, type AgentLoopCallbacks, type TokenUsage } from "./agent-loop.js";
import type { PromptContext } from "./prompt.js";

export interface PlanStep {
  id: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  result?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  reasoning?: string;
}

export interface PlanExecuteOptions {
  config: LlmConfig;
  workspaceRoot: string;
  promptContext?: PromptContext;
  maxTurnsPerStep?: number;
  maxTotalTurns?: number;
  signal?: AbortSignal;
  callbacks: PlanExecuteCallbacks;
}

export interface PlanExecuteCallbacks extends AgentLoopCallbacks {
  onPlanCreated?: (plan: Plan) => void;
  onStepStarted?: (step: PlanStep) => void;
  onStepCompleted?: (step: PlanStep) => void;
  onPlanRevised?: (plan: Plan) => void;
}

const PLAN_SYSTEM_PROMPT = `You are a planning assistant. Given a task, create a step-by-step plan.

Output ONLY a JSON object with this structure:
{
  "goal": "one-line summary of what we're trying to achieve",
  "reasoning": "brief analysis of the task complexity",
  "steps": [
    { "id": 1, "description": "what to do in this step" },
    { "id": 2, "description": "what to do next" }
  ]
}

Rules:
- Keep plans to 3-8 steps
- Each step should be a single, concrete action (read a file, edit a function, run a test)
- Steps should be ordered logically
- Don't over-plan — simple tasks need simple plans`;

export class PlanExecutor {
  private readonly config: LlmConfig;
  private readonly workspaceRoot: string;
  private readonly promptContext?: PromptContext;
  private readonly maxTurnsPerStep: number;
  private readonly maxTotalTurns: number;
  private readonly signal?: AbortSignal;
  private readonly callbacks: PlanExecuteCallbacks;
  private readonly client: LlmClient;

  constructor(options: PlanExecuteOptions) {
    this.config = options.config;
    this.workspaceRoot = options.workspaceRoot;
    this.promptContext = options.promptContext;
    this.maxTurnsPerStep = options.maxTurnsPerStep ?? 10;
    this.maxTotalTurns = options.maxTotalTurns ?? 75;
    this.signal = options.signal;
    this.callbacks = options.callbacks;
    this.client = new LlmClient(options.config);
  }

  async run(userPrompt: string): Promise<{ plan: Plan; tokenUsage: TokenUsage }> {
    // Phase 1: Create the plan
    const plan = await this.createPlan(userPrompt);
    this.callbacks.onPlanCreated?.(plan);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTurns = 0;

    // Phase 2: Execute each step
    for (const step of plan.steps) {
      if (this.signal?.aborted) throw new Error("Agent run cancelled");
      if (totalTurns >= this.maxTotalTurns) break;

      step.status = "in_progress";
      this.callbacks.onStepStarted?.(step);

      const stepPrompt = this.buildStepPrompt(plan, step, userPrompt);

      const loop = new AgentLoop({
        config: this.config,
        workspaceRoot: this.workspaceRoot,
        promptContext: this.promptContext,
        maxTurns: Math.min(this.maxTurnsPerStep, this.maxTotalTurns - totalTurns),
        signal: this.signal,
        callbacks: this.callbacks,
      });

      try {
        const result = await loop.run(stepPrompt);
        const lastMsg = result.messages[result.messages.length - 1];
        const baseResult = lastMsg?.content || "Step completed";
        step.result =
          result.stopReason === "max_turns"
            ? `[Step stopped at max turns (${result.turnCount}) — partial work preserved]\n${baseResult}`
            : baseResult;
        step.status = "completed";
        totalTurns += result.turnCount;
        totalInputTokens += result.tokenUsage.inputTokens;
        totalOutputTokens += result.tokenUsage.outputTokens;
      } catch (error) {
        step.status = "failed";
        step.result = error instanceof Error ? error.message : String(error);
      } finally {
        loop.destroy();
      }

      this.callbacks.onStepCompleted?.(step);
    }

    return {
      plan,
      tokenUsage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
      },
    };
  }

  private async createPlan(userPrompt: string): Promise<Plan> {
    const messages: ChatMessage[] = [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    let response = "";
    const stream = this.client.stream({ messages, signal: this.signal });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) response += delta.content;
    }

    // Extract JSON from the response (might be wrapped in markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        goal: userPrompt,
        steps: [{ id: 1, description: userPrompt, status: "pending" }],
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as { goal?: string; reasoning?: string; steps?: { id?: number; description?: string }[] };
      return {
        goal: parsed.goal || userPrompt,
        reasoning: parsed.reasoning,
        steps: (parsed.steps || []).map((s, i) => ({
          id: s.id ?? i + 1,
          description: s.description || `Step ${i + 1}`,
          status: "pending" as const,
        })),
      };
    } catch {
      return {
        goal: userPrompt,
        steps: [{ id: 1, description: userPrompt, status: "pending" }],
      };
    }
  }

  private buildStepPrompt(plan: Plan, currentStep: PlanStep, originalPrompt: string): string {
    const completedSteps = plan.steps
      .filter((s) => s.status === "completed")
      .map((s) => `- Step ${s.id}: ${s.description} → ${s.result?.slice(0, 200) || "done"}`)
      .join("\n");

    let prompt = `Original task: ${originalPrompt}\n\n`;
    prompt += `Current step (${currentStep.id}/${plan.steps.length}): ${currentStep.description}\n`;

    if (completedSteps) {
      prompt += `\nPreviously completed:\n${completedSteps}\n`;
    }

    prompt += `\nFocus on completing this specific step. Be concise.`;
    return prompt;
  }
}
