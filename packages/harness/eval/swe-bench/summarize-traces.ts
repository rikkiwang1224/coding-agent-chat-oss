#!/usr/bin/env node
/**
 * Summarize SWE-bench agent traces for failure analysis.
 *
 * Usage:
 *   pnpm eval:swe:traces -- --run-id trace-rerun
 *   pnpm eval:swe:traces -- --run-id trace-rerun --instance astropy__astropy-14182
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { resolveSweBenchTraceDir } from "@forgelet/storage-core";
import type { AgentEvent } from "@forgelet/shared-types";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const runId = getArg("run-id");
const instanceFilter = getArg("instance");

if (!runId) {
  console.error("Usage: eval:swe:traces -- --run-id <id> [--instance <instance_id>]");
  process.exit(1);
}

interface TraceRecord {
  event: AgentEvent;
}

async function summarizeFile(filePath: string, instanceId: string): Promise<void> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const events = lines.map((l) => JSON.parse(l) as TraceRecord).map((r) => r.event);

  const toolCalls = events.filter((e) => e.type === "tool.called");
  const toolNames = toolCalls.map(
    (e) => (e.payload as { toolName?: string }).toolName ?? "unknown",
  );
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const completed = events.find((e) => e.type === "agent.completed");
  const failed = events.find((e) => e.type === "agent.failed");
  const lastTools = toolCalls.slice(-5).map((e) => {
    const p = e.payload as { toolName?: string; args?: Record<string, unknown> };
    const argPreview =
      p.args && typeof p.args.path === "string"
        ? p.args.path
        : p.args && typeof p.args.command === "string"
          ? String(p.args.command).slice(0, 80)
          : "";
    return `${p.toolName}${argPreview ? ` (${argPreview})` : ""}`;
  });

  console.log(`\n## ${instanceId}`);
  console.log(`   Events:     ${events.length}`);
  console.log(`   Tool calls: ${toolCalls.length}`);
  if (counts.size > 0) {
    console.log(`   Tools:      ${[...counts.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`);
  }
  if (completed) {
    const p = completed.payload as { status?: string; summary?: string };
    console.log(`   Completed:  ${p.status ?? "ok"}${p.summary ? ` — ${p.summary.slice(0, 120)}` : ""}`);
  }
  if (failed) {
    const p = failed.payload as { error?: string };
    console.log(`   Failed:     ${p.error?.slice(0, 200) ?? "yes"}`);
  }
  if (lastTools.length > 0) {
    console.log(`   Last tools:`);
    for (const t of lastTools) {
      console.log(`     - ${t}`);
    }
  }
}

async function main(): Promise<void> {
  const traceDir = path.join(resolveSweBenchTraceDir(runId), "instances");
  let files: string[];
  try {
    files = (await readdir(traceDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    console.error(`No traces at ${traceDir}`);
    console.error(`Expected: ~/.forgelet/traces/swe-bench/eval-${runId}/instances/`);
    process.exit(1);
  }

  if (instanceFilter) {
    const match = files.find((f) => f.startsWith(instanceFilter.replace(/[^a-zA-Z0-9._-]/g, "_")));
    if (!match) {
      console.error(`Instance trace not found: ${instanceFilter}`);
      process.exit(1);
    }
    files = [match];
  }

  console.log(`\nTrace summary — run ${runId}`);
  console.log(`Directory: ${traceDir}`);

  for (const file of files.sort()) {
    const instanceId = file.replace(/\.jsonl$/, "");
    await summarizeFile(path.join(traceDir, file), instanceId);
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
