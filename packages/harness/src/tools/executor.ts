import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_SIZE = 64 * 1024; // 64KB limit for tool output

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
}

export interface ToolExecutorOptions {
  workspaceRoot: string;
}

export class ToolExecutor {
  private readonly workspaceRoot: string;

  constructor(options: ToolExecutorOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    try {
      switch (toolName) {
        case "read_file":
          return await this.readFile(args);
        case "write_file":
          return await this.writeFile(args);
        case "edit_file":
          return await this.editFile(args);
        case "run_command":
          return await this.runCommand(args);
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
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(this.workspaceRoot, filePath);
  }

  private truncate(content: string): string {
    if (content.length <= MAX_OUTPUT_SIZE) return content;
    return content.slice(0, MAX_OUTPUT_SIZE) + "\n... [output truncated]";
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

  private async runCommand(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const command = String(args.command || "");
    const cwd = args.cwd ? this.resolvePath(String(args.cwd)) : this.workspaceRoot;
    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 60_000;

    if (!command) {
      return { ok: false, output: "command is required" };
    }

    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, TERM: "dumb" },
      });

      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { ok: true, output: this.truncate(output || "(no output)") };
    } catch (error: unknown) {
      const execError = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
        killed?: boolean;
        message?: string;
      };

      if (execError.killed) {
        return { ok: false, output: `Command timed out after ${timeoutMs}ms` };
      }

      const output = [execError.stdout, execError.stderr].filter(Boolean).join("\n");
      return {
        ok: false,
        output: this.truncate(output || execError.message || "Command failed"),
      };
    }
  }

  private async globSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const pattern = String(args.pattern || "");
    const cwd = args.cwd ? this.resolvePath(String(args.cwd)) : this.workspaceRoot;

    if (!pattern) {
      return { ok: false, output: "pattern is required" };
    }

    try {
      const { stdout } = await execFileAsync(
        "find",
        [cwd, "-type", "f", "-name", pattern.replace(/\*\*\//g, "")],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      );

      // Use fd if available, fallback to a glob via bash
      const { stdout: fdResult } = await execFileAsync(
        "sh",
        ["-c", `cd "${cwd}" && find . -path './${pattern}' -type f 2>/dev/null | head -100 || find . -name '${pattern.replace(/\*\*\//g, "")}' -type f 2>/dev/null | head -100`],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      ).catch(() => ({ stdout }));

      const files = fdResult
        .split("\n")
        .map((f) => f.trim().replace(/^\.\//, ""))
        .filter(Boolean);

      if (files.length === 0) {
        return { ok: true, output: "No files found matching the pattern." };
      }

      return { ok: true, output: this.truncate(files.join("\n")) };
    } catch {
      // fallback using sh glob expansion
      try {
        const { stdout: shResult } = await execFileAsync(
          "sh",
          ["-c", `cd "${cwd}" && ls ${pattern} 2>/dev/null | head -100`],
          { timeout: 10_000, maxBuffer: 512 * 1024 },
        );
        return { ok: true, output: this.truncate(shResult || "No files found.") };
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
