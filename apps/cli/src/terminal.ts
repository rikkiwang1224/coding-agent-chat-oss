import type { AgentEvent } from "@forgelet/shared-types";
import type {
  AgentDeltaPayload,
  AgentDonePayload,
  AgentErrorPayload,
  AgentProgressPayload,
  ToolCalledPayload,
  ToolErrorPayload,
  ToolOutputPayload,
} from "@forgelet/shared-types";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

export interface TerminalWriterOptions {
  verbose: boolean;
}

export class TerminalWriter {
  private assistantStarted = false;
  private readonly verbose: boolean;

  constructor(options: TerminalWriterOptions) {
    this.verbose = options.verbose;
  }

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
        if (this.verbose) this.writeToolOutput(event.payload as ToolOutputPayload);
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
    const argsPreview = this.verbose ? ` ${DIM}${truncate(JSON.stringify(payload.args), 80)}${RESET}` : "";
    process.stderr.write(`${DIM}↳${RESET} ${payload.toolName}${argsPreview}\n`);
  }

  private writeToolOutput(payload: ToolOutputPayload): void {
    const out = truncate(payload.output, 400);
    if (!out.trim()) return;
    process.stderr.write(`${DIM}  └ ${payload.toolName}:${RESET}\n${out}\n`);
  }

  /**
   * Render reason hook progress events. We surface these so the
   * agent.log captures the gate's diagnostic info (what ran, pass/fail,
   * round count) without forcing on the trace sink. Plain agent progress
   * messages (planner stage transitions etc.) are skipped to keep output focused.
   */
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

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
