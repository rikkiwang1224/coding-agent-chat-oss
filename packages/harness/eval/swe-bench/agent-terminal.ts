import type { AgentEvent } from "@lattice-code/shared-types";
import type {
  AgentDeltaPayload,
  AgentDonePayload,
  AgentErrorPayload,
  AgentProgressPayload,
  ToolCalledPayload,
  ToolErrorPayload,
} from "@lattice-code/shared-types";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

/** Minimal agent log renderer for SWE-bench Docker runs (cost-report footer compatible). */
export class SweBenchAgentTerminal {
  private assistantStarted = false;

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "agent.started":
        this.assistantStarted = false;
        break;
      case "agent.delta":
        this.writeDelta((event.payload as AgentDeltaPayload).delta);
        break;
      case "agent.progress":
        this.writeProgress(event.payload as AgentProgressPayload);
        break;
      case "tool.called":
        this.writeToolCalled(event.payload as ToolCalledPayload);
        break;
      case "tool.output":
        break;
      case "tool.error":
        this.writeToolError(event.payload as ToolErrorPayload);
        break;
      case "agent.done":
        this.finishAssistant();
        this.writeDone(event.payload as AgentDonePayload);
        break;
      case "agent.error":
        this.finishAssistant();
        this.writeError(event.payload as AgentErrorPayload);
        break;
      default:
        break;
    }
  }

  private writeDelta(delta: string): void {
    if (!delta) return;
    if (!this.assistantStarted) {
      process.stdout.write(`\n${CYAN}●${RESET} `);
      this.assistantStarted = true;
    }
    process.stdout.write(delta);
  }

  private finishAssistant(): void {
    if (this.assistantStarted) {
      process.stdout.write("\n");
      this.assistantStarted = false;
    }
  }

  private writeToolCalled(payload: ToolCalledPayload): void {
    this.finishAssistant();
    process.stderr.write(`${DIM}↳${RESET} ${payload.toolName}\n`);
  }

  private writeProgress(payload: AgentProgressPayload): void {
    const msg = payload.message ?? "";
    const lower = msg.toLowerCase();
    const show =
      msg.startsWith("[reason ") ||
      lower.includes("code graph") ||
      lower.includes("codebase-memory");
    if (!show) return;
    this.finishAssistant();
    process.stderr.write(`${DIM}↳ ${msg}${RESET}\n`);
  }

  private writeToolError(payload: ToolErrorPayload): void {
    this.finishAssistant();
    process.stderr.write(`${RED}✗ ${payload.toolName}: ${payload.error}${RESET}\n`);
  }

  private writeDone(payload: AgentDonePayload): void {
    const metrics = payload.metrics;
    const parts: string[] = [];
    if (metrics?.numTurns != null) parts.push(`${metrics.numTurns} turns`);
    if (metrics?.durationMs != null) parts.push(`${(metrics.durationMs / 1000).toFixed(1)}s`);
    if (metrics?.totalCostUsd != null) parts.push(`~$${metrics.totalCostUsd.toFixed(4)}`);
    if (metrics?.reasonRoundsUsed != null && metrics.reasonRoundsUsed > 0) {
      const v = metrics.reasonFinalVerdict ?? "?";
      parts.push(`reason: ${metrics.reasonRoundsUsed}r→${v}`);
    }
    if (parts.length) {
      process.stderr.write(`${DIM}${parts.join(" · ")}${RESET}\n`);
    }
    const summary = payload.summary?.trim();
    if (summary && !this.assistantStarted) {
      process.stdout.write(`\n${GREEN}${summary}${RESET}\n`);
    }
  }

  private writeError(payload: AgentErrorPayload): void {
    process.stderr.write(`${RED}Error: ${payload.error}${RESET}\n`);
  }
}
