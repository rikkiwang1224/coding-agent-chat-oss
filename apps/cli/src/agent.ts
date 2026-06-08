import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  HarnessEngine,
  SessionStore,
  detectRepoFromGitRemote,
  type ReasonHookConfig,
  type TraceConfig,
} from "@forgelet/harness";
import type { AgentEvent } from "@forgelet/shared-types";

const execFileAsync = promisify(execFile);

/**
 * Build the Reason-as-Sensor hook from env config.
 *
 *   FORGELET_REASON=1      → enabled, 2 rounds (default cap)
 *   FORGELET_REASON=3      → enabled, 3 rounds
 *   FORGELET_REASON=0      → disabled (or any falsy)
 *   FORGELET_REASON unset  → disabled
 *
 * The sensor uses `git diff HEAD` of the workspace as "current diff" and
 * the user's raw prompt as "issue text". For non-git workspaces, the diff
 * comes back empty — the sensor's prompt is tuned to revise empty-diff
 * cases for non-trivial issues.
 */
function buildCliReasonHook(
  workspaceRoot: string,
  getIssueText: () => string,
): ReasonHookConfig | undefined {
  const raw = (process.env.FORGELET_REASON || "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off" || raw === "false") return undefined;

  let maxRounds = 2;
  if (raw !== "1" && raw !== "on" && raw !== "true") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 5) maxRounds = n;
  }

  return {
    enabled: true,
    issueText: getIssueText,
    maxRounds,
    getCurrentDiff: async () => {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", "HEAD", "--no-color", "--", "."],
          { cwd: workspaceRoot, maxBuffer: 16 * 1024 * 1024 },
        );
        const trimmed = stdout.trimEnd();
        return trimmed ? `${trimmed}\n` : "";
      } catch {
        return "";
      }
    },
  };
}

import type { CliArgs } from "./argv.js";
import { resolveLlmConfig } from "./config.js";
import {
  buildAgentPromptEnvelope,
  buildResumePrompt,
  extractUserRequest,
} from "./prompt.js";
import {
  createAutoApproveCallback,
  createInteractivePermissionCallback,
} from "./permissions.js";
import { TerminalWriter } from "./terminal.js";

export interface RunCliOptions {
  args: CliArgs;
  workspaceRoot: string;
}

async function readStdinPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Trace routing for CLI inside SWE-bench Docker:
 * - Batch/smoke default: `--no-trace` (no JSONL).
 * - Debug: omit `--no-trace`, set `SWE_INSTANCE_ID` + `FORGELET_TRACE_RUN_ID` →
 *   `~/.forgelet/traces/swe-bench/eval-<runId>/instances/<id>.jsonl`
 *   (summarize with `pnpm eval:swe:traces -- --run-id <runId>`).
 */
function buildCliTraceConfig(
  noTrace: boolean,
  workspaceRoot: string,
  sessionId: string,
): TraceConfig | undefined {
  if (noTrace) return undefined;

  const sweInstanceId = process.env.SWE_INSTANCE_ID?.trim();
  if (sweInstanceId) {
    const runId = process.env.FORGELET_TRACE_RUN_ID?.trim() || "docker-debug";
    return {
      enabled: true,
      runKind: "swe-bench",
      runId,
      instanceId: sweInstanceId,
      workspaceRoot,
    };
  }

  return {
    enabled: true,
    runKind: "cli",
    runId: sessionId,
    workspaceRoot,
  };
}

function buildRunPrompt(
  userPrompt: string,
  workspaceRoot: string,
  harnessResume: boolean,
): string {
  const userRequest = extractUserRequest(userPrompt) || userPrompt;
  return harnessResume
    ? buildResumePrompt(workspaceRoot, userRequest)
    : buildAgentPromptEnvelope({ prompt: userRequest, workspaceRoot });
}

export async function runCliAgent(options: RunCliOptions): Promise<number> {
  const { args, workspaceRoot } = options;
  const llm = await resolveLlmConfig(args);

  if (!llm.apiKey) {
    process.stderr.write(
      "Error: API key required. Set DEEPSEEK_API_KEY or FORGELET_API_KEY, pass --api-key, or add apiKey to ~/.forgelet/config.json\n",
    );
    return 1;
  }

  const sessionId = args.sessionId?.trim() || randomUUID();
  const sessionStore = SessionStore.forWorkspace(workspaceRoot);
  const terminal = new TerminalWriter({ verbose: args.verbose });

  const canPrompt = !args.yes && process.stdin.isTTY && process.stdout.isTTY;

  if (args.interactive && !canPrompt) {
    process.stderr.write("Error: interactive mode requires a TTY. Use -y in non-interactive environments.\n");
    return 1;
  }

  const rl = canPrompt ? readline.createInterface({ input, output, terminal: true }) : null;

  let engine: HarnessEngine | undefined;

  const autoApprove = args.yes || !canPrompt;
  if (autoApprove && !args.yes && !args.interactive) {
    process.stderr.write("Note: auto-approving tool permissions (non-interactive). Pass -y to silence.\n");
  }

  const onPermissionConfirm = autoApprove
    ? createAutoApproveCallback()
    : createInteractivePermissionCallback(rl!, (toolName, key) => {
        engine?.getPermissionGuard().addAlwaysAllow(key || toolName);
      });

  // Mutable issue text — updated per runOnce so interactive mode gives the
  // reviewer a fresh task on each user turn instead of stale first-prompt context.
  let currentIssueText = args.prompt?.trim() ?? "";
  const reasonHook = buildCliReasonHook(workspaceRoot, () => currentIssueText);
  engine = new HarnessEngine({
    workspaceRoot,
    sessionStore,
    persistSession: true,
    trace: buildCliTraceConfig(args.noTrace, workspaceRoot, sessionId),
    config: {
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      provider: llm.provider,
      ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
      ...(llm.thinking !== undefined ? { thinking: llm.thinking } : {}),
      ...(llm.reasoningEffort ? { reasoningEffort: llm.reasoningEffort } : {}),
    },
    onPermissionConfirm,
    reason: reasonHook,
  });

  const emit = (event: AgentEvent) => {
    terminal.handle(event);
  };

  const runOnce = async (userPrompt: string, resume: boolean): Promise<boolean> => {
    currentIssueText = userPrompt;
    let harnessResume = false;
    if (resume) {
      const existing = await sessionStore.load(sessionId);
      harnessResume = Boolean(existing?.messages?.length);
    }

    const runPrompt = buildRunPrompt(userPrompt, workspaceRoot, harnessResume);
    const controller = new AbortController();

    const onSigint = () => {
      controller.abort("User cancelled");
    };
    process.once("SIGINT", onSigint);

    try {
      await engine!.runTask(
        {
          sessionId,
          prompt: runPrompt,
          signal: controller.signal,
          runMode: harnessResume ? "resume" : undefined,
        },
        emit,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\nError: ${message}\n`);
      return false;
    } finally {
      process.off("SIGINT", onSigint);
    }
  };

  try {
    if (args.interactive) {
      process.stderr.write(
        `Forgelet CLI · ${path.basename(workspaceRoot)} · session ${sessionId.slice(0, 8)}\n`,
      );
      process.stderr.write(`Model: ${llm.model} (${llm.provider})\n`);
      process.stderr.write(`Type a message, or /exit to quit.\n\n`);

      while (true) {
        const line = (await rl!.question("› ")).trim();
        if (!line) continue;
        if (line === "/exit" || line === "/quit") break;
        const ok = await runOnce(line, true);
        if (!ok) return 1;
        process.stderr.write("\n");
      }
      return 0;
    }

    let prompt = args.prompt?.trim() ?? "";
    if (!prompt && !input.isTTY) {
      prompt = await readStdinPrompt();
    }
    if (!prompt) {
      process.stderr.write("Error: provide a prompt argument, use -i for interactive mode, or pipe stdin.\n");
      return 1;
    }

    const ok = await runOnce(prompt, args.resume);
    return ok ? 0 : 1;
  } finally {
    rl?.close();
  }
}
