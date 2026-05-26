import type { Interface } from "node:readline/promises";
import type { PermissionCallback } from "@forgelet/harness";

function commandKey(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "run_command") {
    return String(args.command || "").trim();
  }
  return toolName;
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "run_command") {
    const command = String(args.command || "").trim();
    return command.length > 120 ? `${command.slice(0, 120)}…` : command;
  }
  try {
    const raw = JSON.stringify(args);
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  } catch {
    return toolName;
  }
}

export function createAutoApproveCallback(): PermissionCallback {
  return async () => true;
}

export function createInteractivePermissionCallback(
  rl: Interface,
  onAllowAlways: (toolName: string, key: string) => void,
): PermissionCallback {
  return async (toolName, args, reason) => {
    const summary = summarizeArgs(toolName, args);
    process.stderr.write(`\n⚠ Permission required (${toolName})\n`);
    process.stderr.write(`  Reason: ${reason}\n`);
    process.stderr.write(`  ${summary}\n`);
    const answer = (await rl.question("Allow? [y]es / [n]o / [a]lways: ")).trim().toLowerCase();

    if (answer === "a" || answer === "always") {
      onAllowAlways(toolName, commandKey(toolName, args));
      return true;
    }
    return answer === "y" || answer === "yes" || answer === "";
  };
}
