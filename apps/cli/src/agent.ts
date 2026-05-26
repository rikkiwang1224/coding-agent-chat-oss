import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { HarnessEngine, SessionStore } from "@forgelet/harness";
import type { AgentEvent } from "@forgelet/shared-types";
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

  engine = new HarnessEngine({
    workspaceRoot,
    sessionStore,
    persistSession: true,
    trace: args.noTrace
      ? undefined
      : {
          enabled: true,
          runKind: "cli",
          runId: sessionId,
          workspaceRoot,
        },
    config: {
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      provider: llm.provider,
    },
    onPermissionConfirm,
  });

  const emit = (event: AgentEvent) => {
    terminal.handle(event);
  };

  const runOnce = async (userPrompt: string, resume: boolean): Promise<boolean> => {
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
