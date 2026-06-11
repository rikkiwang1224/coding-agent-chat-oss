#!/usr/bin/env node
/**
 * Salvage CLI: extract the filtered model patch from a SWE-bench worktree.
 *
 * Used by docker-batch.sh / docker-bestofn.sh as a fallback when the agent
 * process is killed (wall-clock timeout, OOM, crash) before it could write
 * its own patch via docker-agent.ts. Edits already applied to the worktree
 * are real work — without this, a hard kill silently turns them into an
 * empty prediction (observed on 6/77 instances in the lite-77 thinking run).
 *
 * Needs no API key; only git. Applies the same test-file filtering as the
 * normal completion path (extractModelPatch).
 *
 * Usage:
 *   tsx extract-patch.ts --workspace /testbed --out /work/agent.patch
 */
import { writeFile } from "node:fs/promises";
import { extractModelPatch } from "./patch.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main(): Promise<number> {
  const workspaceRoot = getArg("workspace") || "/testbed";
  const out = getArg("out");
  if (!out) {
    process.stderr.write("Usage: extract-patch.ts --workspace <dir> --out <file>\n");
    return 1;
  }
  const patch = await extractModelPatch(workspaceRoot);
  await writeFile(out, patch);
  process.stderr.write(
    `[extract-patch] salvaged ${patch.length} chars from ${workspaceRoot} → ${out}\n`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  });
