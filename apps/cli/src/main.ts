#!/usr/bin/env node
/**
 * Forgelet CLI — run the coding agent from your terminal.
 *
 * Usage:
 *   pnpm forgelet "fix the failing test"
 *   pnpm forgelet config set api-key sk-...
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parseArgv } from "./argv.js";
import { HELP_TEXT } from "./help.js";
import { runCliAgent } from "./agent.js";
import { loadCliEnv } from "./load-env.js";
import { runConfigCommand } from "./commands/config.js";

loadCliEnv(process.cwd());

const rawArgv = process.argv.slice(2);

if (rawArgv[0] === "config") {
  process.exit(await runConfigCommand(rawArgv.slice(1)));
}

const args = parseArgv(rawArgv);

if (args.help) {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}

if (args.version) {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    process.stdout.write(`${pkg.version ?? "0.0.0"}\n`);
  } catch {
    process.stdout.write("0.1.0\n");
  }
  process.exit(0);
}

const workspaceRoot = path.resolve(args.cwd?.trim() || process.cwd());
const exitCode = await runCliAgent({ args, workspaceRoot });
process.exit(exitCode);
