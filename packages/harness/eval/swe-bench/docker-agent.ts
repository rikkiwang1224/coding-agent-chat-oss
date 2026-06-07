#!/usr/bin/env node
/**
 * In-container SWE-bench agent entry point (used by docker-batch.sh).
 *
 * Unlike the generic Forgelet CLI, this script always applies SWE-bench
 * prompts, test-file guards, filtered patch extraction, and trace routing.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalEnv } from "../load-env.js";
import { isBatchFatalApiStatus, runSweBenchAgent } from "./agent-task.js";

/**
 * Exit code signalling the batch driver that the run failed on an exhausted
 * account / bad credentials (402/401/403). Distinct from `timeout`'s 124 and
 * docker's 125-127 so docker-batch.sh can fast-abort and stay resume-safe.
 */
const EXIT_API_FATAL = 75;
import { SweBenchAgentTerminal } from "./agent-terminal.js";
import { resolveLlmConfigFromEnv } from "./llm-config.js";
import type { SweBenchInstance } from "./types.js";

loadEvalEnv(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

async function main(): Promise<number> {
  const workspaceRoot = getArg("workspace") || "/testbed";
  const instancePath = getArg("instance") || "/work/instance.json";
  const patchOut = getArg("patch-out") || "/work/agent.patch";
  const maxTurns = Number(process.env.FORGELET_MAX_TURNS || getArg("max-turns") || "75");
  const timeoutMs =
    Number(process.env.FORGELET_TIMEOUT_S || getArg("timeout-s") || "600") * 1000;
  const traceRunId = process.env.FORGELET_TRACE_RUN_ID?.trim();
  const saveTraces =
    !hasFlag("no-trace") &&
    process.env.FORGELET_SAVE_TRACE !== "0" &&
    process.env.FORGELET_SAVE_TRACE !== "off" &&
    process.env.FORGELET_SAVE_TRACE !== "false";

  const config = resolveLlmConfigFromEnv();
  if (!config.apiKey) {
    process.stderr.write(
      "Error: API key required. Set DEEPSEEK_API_KEY or FORGELET_API_KEY.\n",
    );
    return 1;
  }

  const instance = JSON.parse(await readFile(instancePath, "utf8")) as SweBenchInstance;
  const terminal = new SweBenchAgentTerminal();

  const result = await runSweBenchAgent({
    workspaceRoot,
    instance,
    config,
    maxTurns,
    timeoutMs,
    traceRunId,
    saveTraces,
    emit: (event) => terminal.handle(event),
  });

  // Always persist whatever patch the agent produced before failing, so
  // partial work is never silently discarded.
  await writeFile(patchOut, result.modelPatch);

  if (isBatchFatalApiStatus(result.apiErrorStatus)) {
    process.stderr.write(
      `Fatal LLM API error ${result.apiErrorStatus} (account exhausted or invalid credentials): ` +
        `${result.apiErrorMessage ?? ""}\n`,
    );
    return EXIT_API_FATAL;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  });
