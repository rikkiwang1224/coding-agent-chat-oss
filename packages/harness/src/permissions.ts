/**
 * Permission system for tool execution.
 * Controls which operations auto-execute vs require user approval.
 */

export type PermissionLevel = "auto" | "confirm" | "deny";

export interface PermissionPolicy {
  /** Default permission for unmatched tools */
  default: PermissionLevel;
  /** Per-tool overrides */
  tools?: Record<string, PermissionLevel>;
  /** Bash command patterns that are always denied */
  deniedCommands?: RegExp[];
  /** Bash command patterns that require confirmation */
  confirmCommands?: RegExp[];
}

export const DEFAULT_POLICY: PermissionPolicy = {
  default: "auto",
  tools: {
    read_file: "auto",
    list_directory: "auto",
    glob_search: "auto",
    grep_search: "auto",
    code_graph_architecture: "auto",
    code_graph_search: "auto",
    code_graph_trace: "auto",
    code_graph_impact: "auto",
    write_file: "auto",
    edit_file: "auto",
    bash: "auto",
  },
  deniedCommands: [
    /\brm\s+(-[rf]+\s+)?[\/~]/,          // rm -rf / or ~ paths
    /\bgit\s+push\s+.*--force/,           // force push
    /\bgit\s+reset\s+--hard/,             // hard reset
    /\bcurl\s+.*\|\s*(ba)?sh/,            // curl pipe to shell
    /\bsudo\b/,                           // any sudo commands
    /\b(shutdown|reboot|halt)\b/,         // system commands
    /\bchmod\s+777/,                      // overly permissive chmod
    /\bdd\s+.*of=\/dev/,                  // dd to devices
  ],
  confirmCommands: [
    /\bnpm\s+publish/,                    // publishing packages
    /\bgit\s+push/,                       // any git push
    /\brm\s+-/,                           // rm with flags
    /\bchmod\b/,                          // file permissions
    /\bchown\b/,                          // ownership changes
  ],
};

export type PermissionCallback = (
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
) => Promise<boolean>;

export class PermissionGuard {
  private readonly policy: PermissionPolicy;
  private readonly onConfirm?: PermissionCallback;
  private readonly sessionAllowlist = new Set<string>();

  constructor(policy?: PermissionPolicy, onConfirm?: PermissionCallback) {
    this.policy = policy ?? DEFAULT_POLICY;
    this.onConfirm = onConfirm;
  }

  /** Remember a command or tool pattern for the rest of this guard instance (e.g. allow_always). */
  addAlwaysAllow(key: string): void {
    const trimmed = key.trim();
    if (trimmed) this.sessionAllowlist.add(trimmed);
  }

  private isSessionAllowed(toolName: string, args: Record<string, unknown>): boolean {
    if (this.sessionAllowlist.has(toolName)) return true;
    const command = String(args.command || "");
    for (const entry of this.sessionAllowlist) {
      if (command && (command === entry || command.includes(entry))) return true;
    }
    return false;
  }

  /**
   * Check if a tool call is allowed.
   * Returns { allowed: true } or { allowed: false, reason: string }
   */
  async check(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (this.isSessionAllowed(toolName, args)) {
      return { allowed: true };
    }

    // Check tool-level permission
    const toolLevel = this.policy.tools?.[toolName] ?? this.policy.default;

    if (toolLevel === "deny") {
      return { allowed: false, reason: `Tool "${toolName}" is denied by policy` };
    }

    // For bash commands, check command patterns
    if (toolName === "bash" || toolName === "run_command") {
      const command = String(args.command || "");
      return this.checkCommand(command);
    }

    if (toolLevel === "confirm") {
      if (!this.onConfirm) {
        return { allowed: false, reason: `Tool "${toolName}" requires confirmation but no callback set` };
      }
      const approved = await this.onConfirm(toolName, args, "Tool requires confirmation");
      return approved
        ? { allowed: true }
        : { allowed: false, reason: "User denied the operation" };
    }

    return { allowed: true };
  }

  private async checkCommand(command: string): Promise<{ allowed: boolean; reason?: string }> {
    // Check denied patterns
    for (const pattern of this.policy.deniedCommands ?? []) {
      if (pattern.test(command)) {
        return { allowed: false, reason: `Command matches denied pattern: ${pattern}` };
      }
    }

    // Check confirm patterns
    for (const pattern of this.policy.confirmCommands ?? []) {
      if (pattern.test(command)) {
        if (!this.onConfirm) {
          return { allowed: false, reason: `Command "${command}" requires confirmation` };
        }
        const approved = await this.onConfirm("bash", { command }, `Command matches: ${pattern}`);
        return approved
          ? { allowed: true }
          : { allowed: false, reason: "User denied the command" };
      }
    }

    return { allowed: true };
  }
}
