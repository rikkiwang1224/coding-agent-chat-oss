import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ShellSession } from "./shell-session.js";
import { PermissionGuard, type PermissionPolicy, type PermissionCallback } from "../permissions.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_SIZE = 32 * 1024; // 32KB limit for tool output
const MAX_OUTPUT_LINES = 500;

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
}

export interface ToolExecutorOptions {
  workspaceRoot: string;
  permissionPolicy?: PermissionPolicy;
  onPermissionConfirm?: PermissionCallback;
}

export class ToolExecutor {
  private readonly workspaceRoot: string;
  private readonly guard: PermissionGuard;
  private shell: ShellSession | null = null;

  constructor(options: ToolExecutorOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.guard = new PermissionGuard(options.permissionPolicy, options.onPermissionConfirm);
  }

  private getShell(): ShellSession {
    if (!this.shell) {
      this.shell = new ShellSession(this.workspaceRoot);
    }
    return this.shell;
  }

  destroy(): void {
    this.shell?.destroy();
    this.shell = null;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    // Permission check
    const permission = await this.guard.check(toolName, args);
    if (!permission.allowed) {
      return { ok: false, output: `Permission denied: ${permission.reason}` };
    }

    try {
      switch (toolName) {
        case "read_file":
          return await this.readFile(args);
        case "write_file":
          return await this.writeFile(args);
        case "edit_file":
          return await this.editFile(args);
        case "bash":
          return await this.bash(args);
        case "run_command":
          return await this.bash(args);
        case "glob_search":
          return await this.globSearch(args);
        case "grep_search":
          return await this.grepSearch(args);
        case "list_directory":
          return await this.listDirectory(args);
        default:
          return { ok: false, output: `Unknown tool: ${toolName}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `Error executing ${toolName}: ${message}` };
    }
  }

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      // Check that absolute paths are still within workspace
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(this.workspaceRoot)) {
        throw new Error(`Path "${filePath}" is outside the workspace`);
      }
      return resolved;
    }
    const resolved = path.resolve(this.workspaceRoot, filePath);
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new Error(`Path "${filePath}" resolves outside the workspace`);
    }
    return resolved;
  }

  private truncate(content: string): string {
    // First truncate by line count
    const lines = content.split("\n");
    let result = content;
    if (lines.length > MAX_OUTPUT_LINES) {
      const kept = lines.slice(0, MAX_OUTPUT_LINES);
      result = kept.join("\n") + `\n... [${lines.length - MAX_OUTPUT_LINES} more lines truncated]`;
    }
    // Then truncate by byte size
    if (result.length > MAX_OUTPUT_SIZE) {
      result = result.slice(0, MAX_OUTPUT_SIZE) + "\n... [output truncated at 32KB]";
    }
    return result;
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const filePath = this.resolvePath(String(args.path || ""));
    const content = await readFile(filePath, "utf8");

    const offset = typeof args.offset === "number" ? args.offset : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;

    if (offset !== undefined || limit !== undefined) {
      const lines = content.split("\n");
      const start = (offset ?? 1) - 1;
      const end = limit ? start + limit : lines.length;
      const sliced = lines.slice(Math.max(0, start), end);
      const numbered = sliced.map(
        (line, i) => `${String(start + i + 1).padStart(6)}|${line}`,
      );
      return { ok: true, output: this.truncate(numbered.join("\n")) };
    }

    const lines = content.split("\n");
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(6)}|${line}`);
    return { ok: true, output: this.truncate(numbered.join("\n")) };
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const filePath = this.resolvePath(String(args.path || ""));
    const content = String(args.content ?? "");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return { ok: true, output: `Successfully wrote ${content.length} bytes to ${filePath}` };
  }

  private async editFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const filePath = this.resolvePath(String(args.path || ""));
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");

    if (!oldString) {
      return { ok: false, output: "old_string cannot be empty" };
    }

    const content = await readFile(filePath, "utf8");
    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      return { ok: false, output: `old_string not found in ${filePath}` };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        output: `old_string found ${occurrences} times in ${filePath}. It must be unique. Include more context.`,
      };
    }

    const newContent = content.replace(oldString, newString);
    await writeFile(filePath, newContent, "utf8");
    return { ok: true, output: `Successfully edited ${filePath}` };
  }

  private async bash(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const command = String(args.command || "");
    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 60_000;

    if (!command) {
      return { ok: false, output: "command is required" };
    }

    const shell = this.getShell();
    const { exitCode, output } = await shell.execute(command, timeoutMs);

    return {
      ok: exitCode === 0,
      output: this.truncate(output || "(no output)"),
    };
  }

  private async globSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const pattern = String(args.pattern || "");
    const cwd = args.cwd ? this.resolvePath(String(args.cwd)) : this.workspaceRoot;

    if (!pattern) {
      return { ok: false, output: "pattern is required" };
    }

    try {
      // Use the glob module from Node.js (20+) or fall back to find
      const { glob } = await import("node:fs/promises");
      const matches: string[] = [];

      for await (const entry of glob(pattern, { cwd })) {
        matches.push(entry);
        if (matches.length >= 200) break;
      }

      if (matches.length === 0) {
        return { ok: true, output: "No files found matching the pattern." };
      }

      const sorted = matches.sort();
      return { ok: true, output: this.truncate(sorted.join("\n")) };
    } catch {
      // Fallback for older Node or unsupported glob syntax
      try {
        const { stdout } = await execFileAsync(
          "sh",
          ["-c", `cd "${cwd}" && find . -path './${pattern}' -type f 2>/dev/null | sort | head -200`],
          { timeout: 15_000, maxBuffer: 1024 * 1024 },
        );

        const files = stdout
          .split("\n")
          .map((f) => f.trim().replace(/^\.\//, ""))
          .filter(Boolean);

        if (files.length === 0) {
          return { ok: true, output: "No files found matching the pattern." };
        }

        return { ok: true, output: this.truncate(files.join("\n")) };
      } catch {
        return { ok: true, output: "No files found matching the pattern." };
      }
    }
  }

  private async grepSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const pattern = String(args.pattern || "");
    const searchPath = args.path ? this.resolvePath(String(args.path)) : this.workspaceRoot;
    const include = args.include ? String(args.include) : undefined;

    if (!pattern) {
      return { ok: false, output: "pattern is required" };
    }

    const rgArgs = [
      "--color=never",
      "--line-number",
      "--no-heading",
      "--max-count=50",
    ];

    if (include) {
      rgArgs.push("--glob", include);
    }

    rgArgs.push("--", pattern, searchPath);

    try {
      const { stdout } = await execFileAsync("rg", rgArgs, {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });

      return { ok: true, output: this.truncate(stdout || "No matches found.") };
    } catch (error: unknown) {
      const execError = error as { code?: number; stdout?: string };
      if (execError.code === 1) {
        return { ok: true, output: "No matches found." };
      }
      // ripgrep not available, fallback to grep
      try {
        const grepArgs = ["-rn", "--include", include || "*", pattern, searchPath];
        const { stdout } = await execFileAsync("grep", grepArgs, {
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return { ok: true, output: this.truncate(stdout || "No matches found.") };
      } catch {
        return { ok: true, output: "No matches found." };
      }
    }
  }

  private async listDirectory(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const dirPath = args.path
      ? this.resolvePath(String(args.path))
      : this.workspaceRoot;

    const entries = await readdir(dirPath, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => {
        const suffix = entry.isDirectory() ? "/" : "";
        return `${entry.name}${suffix}`;
      });

    return { ok: true, output: lines.join("\n") || "(empty directory)" };
  }
}
