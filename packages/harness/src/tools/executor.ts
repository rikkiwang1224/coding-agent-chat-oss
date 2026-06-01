import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ShellSession } from "./shell-session.js";
import { PermissionGuard, type PermissionPolicy, type PermissionCallback } from "../permissions.js";
import type { HarnessHooks } from "../hooks.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_SIZE = 32 * 1024; // 32KB limit for tool output
const MAX_OUTPUT_LINES = 500;

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface ToolExecutorOptions {
  workspaceRoot: string;
  permissionPolicy?: PermissionPolicy;
  onPermissionConfirm?: PermissionCallback;
  permissionGuard?: PermissionGuard;
  hooks?: HarnessHooks;
  sessionId?: string;
  /** Default bash timeout when the model omits timeout_ms (default 60s). */
  defaultBashTimeoutMs?: number;
}

const DEFAULT_BASH_TIMEOUT_MS = 60_000;

/** Resolve default bash timeout from env FORGELET_BASH_TIMEOUT_MS (milliseconds). */
export function resolveDefaultBashTimeoutMs(): number {
  const raw = process.env.FORGELET_BASH_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_BASH_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BASH_TIMEOUT_MS;
}

export class ToolExecutor {
  private readonly workspaceRoot: string;
  private readonly guard: PermissionGuard;
  private readonly hooks?: HarnessHooks;
  private readonly sessionId?: string;
  private shell: ShellSession | null = null;
  /**
   * Per-executor (per-loop) working todo list, mutated by the `todo_write`
   * tool. In-memory only — surface to the UI via the postToolUse hook or by
   * inspecting the executor with `getTodos()`.
   */
  private todos: TodoItem[] = [];
  private readonly defaultBashTimeoutMs: number;

  constructor(options: ToolExecutorOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.defaultBashTimeoutMs = options.defaultBashTimeoutMs ?? resolveDefaultBashTimeoutMs();
    this.guard =
      options.permissionGuard ??
      new PermissionGuard(options.permissionPolicy, options.onPermissionConfirm);
    this.hooks = options.hooks;
    this.sessionId = options.sessionId;
  }

  getPermissionGuard(): PermissionGuard {
    return this.guard;
  }

  getTodos(): TodoItem[] {
    return this.todos;
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

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (this.hooks?.preToolUse) {
      const pre = await this.hooks.preToolUse({
        toolName,
        args,
        sessionId: this.sessionId,
      });
      if (pre) {
        if (!pre.allow) {
          return {
            ok: false,
            output: `Blocked by preToolUse hook: ${pre.reason || "not allowed"}`,
          };
        }
        if (pre.args) args = pre.args;
      }
    }

    // Permission check
    const permission = await this.guard.check(toolName, args);
    if (!permission.allowed) {
      return { ok: false, output: `Permission denied: ${permission.reason}` };
    }

    let result: ToolExecutionResult;
    try {
      switch (toolName) {
        case "read_file":
          result = await this.readFile(args);
          break;
        case "write_file":
          result = await this.writeFile(args);
          break;
        case "edit_file":
          result = await this.editFile(args);
          break;
        case "multi_edit":
          result = await this.multiEdit(args);
          break;
        case "apply_patch":
          result = await this.applyPatch(args, signal);
          break;
        case "todo_write":
          result = this.todoWrite(args);
          break;
        case "bash":
          result = await this.bash(args, signal);
          break;
        case "run_command":
          result = await this.bash(args, signal);
          break;
        case "glob_search":
          result = await this.globSearch(args);
          break;
        case "grep_search":
          result = await this.grepSearch(args);
          break;
        case "list_directory":
          result = await this.listDirectory(args);
          break;
        default:
          result = { ok: false, output: `Unknown tool: ${toolName}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { ok: false, output: `Error executing ${toolName}: ${message}` };
    }

    if (this.hooks?.postToolUse) {
      await this.hooks.postToolUse({ toolName, args, result, sessionId: this.sessionId });
    }

    return result;
  }

  private resolvePath(filePath: string): string {
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.workspaceRoot, filePath);

    // Use path.relative + check for `..` segments instead of `startsWith`:
    // a prefix-only check accepts `/tmp/foo-bar/x` when the workspace is
    // `/tmp/foo` (sibling-with-prefix-collision attack). path.relative
    // produces a `..`-prefixed string for any escape, including the
    // collision case.
    const rel = path.relative(this.workspaceRoot, resolved);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
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
    const replaceAll = args.replace_all === true;

    if (!oldString) {
      return { ok: false, output: "old_string cannot be empty" };
    }

    const content = await readFile(filePath, "utf8");
    const { content: newContent, replacements, error } = applyEdit(
      content,
      oldString,
      newString,
      replaceAll,
    );
    if (error) return { ok: false, output: `${error} in ${filePath}` };

    await writeFile(filePath, newContent, "utf8");
    return {
      ok: true,
      output: `Successfully edited ${filePath} (${replacements} replacement${
        replacements === 1 ? "" : "s"
      })`,
    };
  }

  private async multiEdit(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const filePath = this.resolvePath(String(args.path || ""));
    const edits = Array.isArray(args.edits) ? args.edits : null;

    if (!edits || edits.length === 0) {
      return { ok: false, output: "edits must be a non-empty array" };
    }

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Failed to read ${filePath}: ${message}` };
    }

    let working = content;
    let totalReplacements = 0;
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i] as Record<string, unknown>;
      const oldString = String(edit.old_string ?? "");
      const newString = String(edit.new_string ?? "");
      const replaceAll = edit.replace_all === true;
      if (!oldString) {
        return { ok: false, output: `Edit #${i + 1}: old_string cannot be empty` };
      }
      const { content: next, replacements, error } = applyEdit(
        working,
        oldString,
        newString,
        replaceAll,
      );
      if (error) {
        // Atomic: don't write a partial result.
        return { ok: false, output: `Edit #${i + 1}: ${error} (no changes written to ${filePath})` };
      }
      working = next;
      totalReplacements += replacements;
    }

    await writeFile(filePath, working, "utf8");
    return {
      ok: true,
      output: `Successfully applied ${edits.length} edit${
        edits.length === 1 ? "" : "s"
      } to ${filePath} (${totalReplacements} replacement${
        totalReplacements === 1 ? "" : "s"
      })`,
    };
  }

  private async applyPatch(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const patch = String(args.patch ?? "");
    const checkOnly = args.check_only === true;
    if (!patch.trim()) {
      return { ok: false, output: "patch is required" };
    }

    // Write patch to a temp file inside the workspace and feed it to git apply.
    // Using a file (vs stdin) keeps the abort/timeout semantics consistent with
    // the rest of the bash-based tools and avoids quoting issues.
    const tmpName = `.forgelet-apply-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.patch`;
    const tmpPath = path.join(this.workspaceRoot, tmpName);
    try {
      await writeFile(tmpPath, patch.endsWith("\n") ? patch : `${patch}\n`, "utf8");
    } catch (err) {
      return {
        ok: false,
        output: `Failed to stage patch: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const shell = this.getShell();
    const flags = checkOnly ? "--check" : "";
    const cmd = `git apply ${flags} -p1 --whitespace=nowarn -- ${tmpName}`;
    try {
      const { exitCode, output } = await shell.execute(cmd, 60_000, signal);
      if (exitCode === 0) {
        return {
          ok: true,
          output: checkOnly
            ? `Patch applies cleanly (check mode — no files modified)`
            : `Patch applied successfully${output ? `\n${this.truncate(output)}` : ""}`,
        };
      }
      return {
        ok: false,
        output: `git apply failed (exit ${exitCode}):\n${this.truncate(output || "(no output)")}`,
      };
    } finally {
      // Best-effort cleanup; don't fail the tool call if rm trips.
      await shell.execute(`rm -f -- ${tmpName}`, 5000).catch(() => undefined);
    }
  }

  private todoWrite(args: Record<string, unknown>): ToolExecutionResult {
    const raw = Array.isArray(args.todos) ? args.todos : null;
    if (!raw) {
      return { ok: false, output: "todos must be an array" };
    }

    const parsed: TodoItem[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as Record<string, unknown>;
      const id = String(item.id ?? "");
      const content = String(item.content ?? "");
      const status = String(item.status ?? "");
      if (!id || !content) {
        return { ok: false, output: `todo #${i + 1}: id and content are required` };
      }
      if (seen.has(id)) {
        return { ok: false, output: `todo #${i + 1}: duplicate id "${id}"` };
      }
      seen.add(id);
      if (!["pending", "in_progress", "completed", "cancelled"].includes(status)) {
        return {
          ok: false,
          output: `todo #${i + 1}: status must be one of pending|in_progress|completed|cancelled`,
        };
      }
      parsed.push({ id, content, status: status as TodoItem["status"] });
    }

    const inProgress = parsed.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) {
      return {
        ok: false,
        output: `at most one todo can be in_progress at a time (found ${inProgress})`,
      };
    }

    this.todos = parsed;
    return { ok: true, output: formatTodos(parsed) };
  }

  private async bash(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const command = String(args.command || "");
    const timeoutMs =
      typeof args.timeout_ms === "number" ? args.timeout_ms : this.defaultBashTimeoutMs;

    if (!command) {
      return { ok: false, output: "command is required" };
    }

    const shell = this.getShell();
    try {
      const { exitCode, output } = await shell.execute(command, timeoutMs, signal);
      return {
        ok: exitCode === 0,
        output: this.truncate(output || "(no output)"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Re-throw abort so the agent loop terminates correctly instead of
      // surfacing it as a regular tool failure (which the model would try to
      // recover from).
      if (signal?.aborted || /\babort/i.test(message)) {
        throw error;
      }
      return { ok: false, output: `Error executing bash: ${message}` };
    }
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
      // Fallback for older Node / unsupported glob syntax. Use execFile with
      // argv (NOT `sh -c`) so that a model-supplied pattern like
      // `*"; rm -rf ~; echo "` cannot escape into a shell command.
      try {
        const { stdout } = await execFileAsync(
          "find",
          [".", "-path", `./${pattern}`, "-type", "f"],
          { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 },
        );

        const files = stdout
          .split("\n")
          .map((f) => f.trim().replace(/^\.\//, ""))
          .filter(Boolean)
          .sort()
          .slice(0, 200);

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

interface EditResult {
  content: string;
  replacements: number;
  error?: string;
}

/**
 * Pure helper used by both edit_file and multi_edit. Centralizes the
 * uniqueness / replace_all semantics so the two tools behave identically.
 */
export function applyEdit(
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditResult {
  if (replaceAll) {
    const occurrences = source.split(oldString).length - 1;
    if (occurrences === 0) {
      return { content: source, replacements: 0, error: "old_string not found" };
    }
    return {
      content: source.split(oldString).join(newString),
      replacements: occurrences,
    };
  }

  const occurrences = source.split(oldString).length - 1;
  if (occurrences === 0) {
    return { content: source, replacements: 0, error: "old_string not found" };
  }
  if (occurrences > 1) {
    return {
      content: source,
      replacements: 0,
      error: `old_string found ${occurrences} times — must be unique (or pass replace_all=true). Include more context.`,
    };
  }
  // Use indexOf+slice instead of String.replace() to avoid $ replacement
  // patterns ($', $&, $`, $$) corrupting the output when newString contains
  // literal dollar signs (common in regex, shell scripts, template literals).
  const idx = source.indexOf(oldString);
  return {
    content: source.slice(0, idx) + newString + source.slice(idx + oldString.length),
    replacements: 1,
  };
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "Todo list cleared.";
  const STATUS_MARK: Record<TodoItem["status"], string> = {
    pending: "[ ]",
    in_progress: "[>]",
    completed: "[x]",
    cancelled: "[-]",
  };
  const lines = todos.map((t) => `${STATUS_MARK[t.status]} ${t.content}`);
  const counts = todos.reduce(
    (acc, t) => {
      acc[t.status]++;
      return acc;
    },
    { pending: 0, in_progress: 0, completed: 0, cancelled: 0 } as Record<
      TodoItem["status"],
      number
    >,
  );
  return [
    `Todo list updated (${todos.length} item${todos.length === 1 ? "" : "s"}: ${
      counts.completed
    } done, ${counts.in_progress} in progress, ${counts.pending} pending${
      counts.cancelled ? `, ${counts.cancelled} cancelled` : ""
    })`,
    ...lines,
  ].join("\n");
}
