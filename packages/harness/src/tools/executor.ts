import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ShellSession } from "./shell-session.js";
import { PermissionGuard, type PermissionPolicy, type PermissionCallback } from "../permissions.js";
import type { HarnessHooks } from "../hooks.js";
import type { CodebaseMemoryClient } from "../code-graph/codebase-memory.js";
import {
  normalizeSearchCodeScope,
  normalizeSearchGraphFilePattern,
  sanitizeSearchGraphNamePattern,
  splitAlternatives,
  splitAndCleanCodeSearchQuery,
} from "../code-graph/patterns.js";

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
  /**
   * Glob-style path patterns that block write operations (edit_file, multi_edit,
   * write_file, apply_patch). When a write target matches any pattern, the tool
   * returns an error message instead of executing. Used by SWE-bench to prevent
   * the agent from modifying test files.
   */
  protectedPathPatterns?: string[];
  /** When set, enables code_graph_* tools (requires codebase-memory-mcp on PATH). */
  codeGraph?: CodebaseMemoryClient;
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
  private readonly protectedPathPatterns: string[];
  private readonly codeGraph?: CodebaseMemoryClient;

  constructor(options: ToolExecutorOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.defaultBashTimeoutMs = options.defaultBashTimeoutMs ?? resolveDefaultBashTimeoutMs();
    this.guard =
      options.permissionGuard ??
      new PermissionGuard(options.permissionPolicy, options.onPermissionConfirm);
    this.hooks = options.hooks;
    this.sessionId = options.sessionId;
    this.protectedPathPatterns = options.protectedPathPatterns ?? [];
    this.codeGraph = options.codeGraph;
  }

  getPermissionGuard(): PermissionGuard {
    return this.guard;
  }

  getTodos(): TodoItem[] {
    return this.todos;
  }

  /**
   * Returns a rejection message if `filePath` matches any protectedPathPatterns,
   * or `null` if the path is allowed.
   */
  private checkProtectedPath(filePath: string): string | null {
    if (this.protectedPathPatterns.length === 0) return null;
    const rel = path.relative(this.workspaceRoot, filePath);
    const basename = path.basename(filePath);
    for (const pattern of this.protectedPathPatterns) {
      if (matchProtectedPattern(rel, basename, pattern)) {
        return (
          `Cannot edit ${basename}: this file is protected (matches pattern "${pattern}"). ` +
          `You must fix your source code to make existing tests pass — do not modify test files.`
        );
      }
    }
    return null;
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
        case "codebase_overview":
          result = await this.codeGraphArchitecture(args);
          break;
        case "symbol_search":
          result = await this.codeGraphSearch(args);
          break;
        case "call_trace":
          result = await this.codeGraphTrace(args);
          break;
        case "change_impact":
          result = await this.codeGraphImpact();
          break;
        case "text_search":
          result = await this.codeGraphCodeSearch(args);
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
      const remaining = lines.length - MAX_OUTPUT_LINES;
      result =
        kept.join("\n") +
        `\n... [${remaining} more lines truncated — file has ${lines.length} total lines. ` +
        `Use read_file(path, offset=${MAX_OUTPUT_LINES + 1}, limit=${Math.min(remaining, MAX_OUTPUT_LINES)}) to read the rest]`;
    }
    // Then truncate by byte size
    if (result.length > MAX_OUTPUT_SIZE) {
      result = result.slice(0, MAX_OUTPUT_SIZE) + "\n... [output truncated at 32KB]";
    }
    return result;
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    // Mode 2: qualified_name → delegate to code graph snippet
    const qualifiedName = typeof args.qualified_name === "string" ? args.qualified_name.trim() : "";
    if (qualifiedName) {
      return this.codeGraphSnippet({ qualified_name: qualifiedName });
    }

    const filePath = this.resolvePath(String(args.path || ""));

    // Reading a directory used to throw EISDIR and waste a turn. Return a
    // directory listing with guidance so the agent can recover in-place.
    const stats = await stat(filePath).catch(() => undefined);
    if (stats?.isDirectory()) {
      const listing = await this.formatDirectoryListing(filePath);
      return {
        ok: true,
        output:
          `"${String(args.path)}" is a directory, not a file. Contents:\n\n${listing}\n\n` +
          `Use list_directory to browse further, or read_file on one of the files listed above.`,
      };
    }

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
      let output = numbered.join("\n");
      // Paging a large file blind is the #1 cause of wasted re-reads. Attach a
      // whole-file outline (function/class line numbers) so the agent can jump
      // straight to the section it needs instead of reading window by window.
      if (lines.length > MAX_OUTPUT_LINES) {
        const outline = extractFileOutline(lines, 0);
        if (outline) {
          output +=
            `\n\n[File outline — ${lines.length} lines total; jump with read_file(offset=N)]\n${outline}`;
        }
      }
      return { ok: true, output: this.truncate(output) };
    }

    const lines = content.split("\n");
    if (lines.length > MAX_OUTPUT_LINES) {
      // File will be truncated — extract a structural outline of the
      // truncated portion so the agent knows what it's missing and can
      // request specific sections instead of reading blindly.
      const shown = lines.slice(0, MAX_OUTPUT_LINES);
      const hidden = lines.slice(MAX_OUTPUT_LINES);
      const numbered = shown.map((line, i) => `${String(i + 1).padStart(6)}|${line}`);
      const outline = extractFileOutline(hidden, MAX_OUTPUT_LINES);
      const remaining = lines.length - MAX_OUTPUT_LINES;
      const hint =
        `\n... [${remaining} more lines not shown — file has ${lines.length} total lines]\n` +
        (outline
          ? `\nOutline of lines ${MAX_OUTPUT_LINES + 1}-${lines.length} (not shown above):\n${outline}\n` +
            `Only read further if you need details from a specific function listed above. ` +
            `If you already found what you need in the shown lines, do NOT read more.`
          : `Use read_file(path, offset=${MAX_OUTPUT_LINES + 1}) only if you need content from the remaining lines.`);
      return { ok: true, output: this.truncate(numbered.join("\n") + hint) };
    }

    const numbered = lines.map((line, i) => `${String(i + 1).padStart(6)}|${line}`);
    return { ok: true, output: this.truncate(numbered.join("\n")) };
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const filePath = this.resolvePath(String(args.path || ""));
    const blocked = this.checkProtectedPath(filePath);
    if (blocked) return { ok: false, output: blocked };
    const content = String(args.content ?? "");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return { ok: true, output: `Successfully wrote ${content.length} bytes to ${filePath}` };
  }

  private async editFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const filePath = this.resolvePath(String(args.path || ""));
    const blocked = this.checkProtectedPath(filePath);
    if (blocked) return { ok: false, output: blocked };
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
    const blocked = this.checkProtectedPath(filePath);
    if (blocked) return { ok: false, output: blocked };
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

    // Check if any file in the patch is protected
    if (this.protectedPathPatterns.length > 0) {
      const patchFiles = extractPatchFilePaths(patch);
      for (const fp of patchFiles) {
        const resolved = this.resolvePath(fp);
        const blocked = this.checkProtectedPath(resolved);
        if (blocked) return { ok: false, output: blocked };
      }
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
      // Expand brace patterns like "*.{ts,vue,js}" into multiple --glob args
      // for cross-platform compatibility (some rg versions handle brace
      // expansion inconsistently).
      const patterns = expandBraceGlob(include);
      for (const p of patterns) {
        rgArgs.push("--glob", p);
      }
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

    return { ok: true, output: await this.formatDirectoryListing(dirPath) };
  }

  private async formatDirectoryListing(dirPath: string): Promise<string> {
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

    return lines.join("\n") || "(empty directory)";
  }

  private codeGraphUnavailable(): ToolExecutionResult {
    return {
      ok: false,
      output:
        "Code graph is not available. Install codebase-memory-mcp (https://github.com/DeusData/codebase-memory-mcp) " +
        "or set FORGELET_CODEBASE_MEMORY_BIN. Disable with FORGELET_CODE_GRAPH=0.",
    };
  }

  private async codeGraphArchitecture(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.codeGraph) return this.codeGraphUnavailable();
    const client = this.codeGraph;

    let aspects: string[] | undefined;
    if (Array.isArray(args.aspects)) {
      aspects = args.aspects.map((a) => String(a).trim()).filter(Boolean);
    }

    const result = await client.getArchitecture(aspects?.length ? { aspects } : undefined);
    if (!result.ok || !result.parsed) {
      return { ok: result.ok, output: this.truncate(result.output) };
    }

    const summary = buildArchitectureSummary(result.parsed as Record<string, unknown>);
    return { ok: true, output: this.truncate(summary) };
  }

  private async codeGraphSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.codeGraph) return this.codeGraphUnavailable();
    const client = this.codeGraph;

    const namePattern = sanitizeSearchGraphNamePattern(String(args.name_pattern ?? ".*"));
    const label = args.label !== undefined ? String(args.label) : undefined;
    const rawFilePattern = args.file_pattern !== undefined ? String(args.file_pattern) : undefined;
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(1, args.limit), 200)
        : 50;

    const filePatterns = rawFilePattern?.includes("|")
      ? splitAlternatives(rawFilePattern).map(normalizeSearchGraphFilePattern)
      : rawFilePattern
        ? [normalizeSearchGraphFilePattern(rawFilePattern)]
        : [undefined];

    let mergedParsed: Record<string, unknown> | undefined;
    let lastRaw = "";
    let anyOk = false;
    for (const filePattern of filePatterns) {
      const result = await client.searchGraph({
        name_pattern: namePattern,
        label,
        file_pattern: filePattern,
        limit,
      });
      if (!result.ok) {
        return { ok: false, output: this.truncate(result.output) };
      }
      anyOk = true;
      lastRaw = result.output;
      if (filePatterns.length === 1) {
        if (result.parsed && typeof result.parsed === "object") {
          const parsed = result.parsed as Record<string, unknown>;
          if (parsed.total === 0) {
            // Auto-fallback to BM25 semantic search before returning empty.
            const semanticResult = await this.semanticFallback(namePattern, limit);
            if (semanticResult) return semanticResult;

            return {
              ok: true,
              output: this.truncate(
                `No symbols found for name_pattern="${namePattern}"` +
                  (rawFilePattern ? ` scoped to "${rawFilePattern}" (normalized: "${filePattern}").` : ".") +
                  ` Try text_search instead.`,
              ),
            };
          }
        }
        const formatted = formatGraphSearchResults(result.parsed, result.output);
        return { ok: true, output: this.truncate(formatted + this.snippetNextStepHint(result.parsed)) };
      }
      mergedParsed = this.mergeSearchGraphParsed(mergedParsed, result.parsed);
    }

    // Multi-pattern merge: check if ALL results are empty → try semantic fallback
    if (mergedParsed) {
      const results = Array.isArray(mergedParsed.results) ? mergedParsed.results : [];
      if (results.length === 0) {
        const semanticResult = await this.semanticFallback(namePattern, limit);
        if (semanticResult) return semanticResult;
      }
    }

    const formatted = mergedParsed
      ? formatGraphSearchResults(mergedParsed, lastRaw) + this.snippetNextStepHint(mergedParsed)
      : lastRaw;
    return { ok: anyOk, output: this.truncate(formatted) };
  }

  /**
   * BM25 semantic fallback for code_graph_search: extract keywords from the
   * name_pattern regex and run a natural-language search. Returns undefined
   * when the fallback also finds nothing (caller shows the original "no results").
   */
  private async semanticFallback(
    namePattern: string,
    limit: number,
  ): Promise<ToolExecutionResult | undefined> {
    if (!this.codeGraph) return undefined;
    // Convert regex-style name_pattern to keyword query:
    //   "download.*template|downloadTmp" → "download template downloadTmp"
    const keywords = namePattern
      .replace(/\.\*|\.\+/g, " ")
      .replace(/[\\^$()[\]{}+?|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!keywords || keywords === ".*" || keywords.length < 2) return undefined;

    const result = await this.codeGraph.semanticQuery({ query: keywords, limit });
    if (!result.ok) {
      // Older binaries may lack semantic_query; try searchCode as a last resort.
      if (result.output.includes("unknown tool")) {
        const codeFallback = await this.codeGraph.searchCode({ query: keywords, limit });
        if (codeFallback.ok) {
          const formatted = formatCodeSearchResults(codeFallback.parsed, codeFallback.output);
          if (!formatted.includes("No matches found")) {
            return {
              ok: true,
              output: this.truncate(
                `[Structural search found nothing — showing BM25 keyword results for "${keywords}"]\n${formatted}`,
              ),
            };
          }
        }
      }
      return undefined;
    }

    if (result.parsed && typeof result.parsed === "object") {
      const parsed = result.parsed as Record<string, unknown>;
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      if (results.length === 0) return undefined;
    }

    const formatted =
      formatGraphSearchResults(result.parsed, result.output) +
      (result.ok ? this.snippetNextStepHint(result.parsed) : "");
    return {
      ok: true,
      output: this.truncate(
        `[Structural search found nothing — showing BM25 keyword results for "${keywords}"]\n${formatted}`,
      ),
    };
  }

  private mergeSearchGraphParsed(
    previous: Record<string, unknown> | undefined,
    incoming: unknown,
  ): Record<string, unknown> {
    if (!incoming || typeof incoming !== "object") return previous ?? {};
    const next = incoming as Record<string, unknown>;
    const incomingResults = Array.isArray(next.results) ? next.results : [];
    if (!previous) {
      return { ...next, results: incomingResults };
    }
    const prevResults = Array.isArray(previous.results) ? previous.results : [];
    const seen = new Set<string>();
    const merged = [...prevResults, ...incomingResults].filter((item) => {
      if (!item || typeof item !== "object") return true;
      const row = item as Record<string, unknown>;
      // Prefer qualified_name (globally unique); fall back to name+file_path
      const key = String(row.qualified_name ?? "") ||
        `${String(row.name ?? "")}@${String(row.file_path ?? "")}`;
      if (!key || key === "@") return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      total: merged.length,
      results: merged,
      has_more: Boolean(next.has_more),
    };
  }

  private async codeGraphTrace(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.codeGraph) return this.codeGraphUnavailable();
    const client = this.codeGraph;

    const functionName = String(args.function_name ?? "").trim();
    if (!functionName) {
      return { ok: false, output: "function_name is required" };
    }

    const direction = args.direction as "inbound" | "outbound" | "both" | undefined;
    const depth =
      typeof args.depth === "number" && Number.isFinite(args.depth)
        ? Math.min(Math.max(1, args.depth), 5)
        : 3;

    const result = await client.traceCallPath({
      function_name: functionName,
      direction:
        direction === "inbound" || direction === "outbound" || direction === "both"
          ? direction
          : "both",
      depth,
    });
    const formatted = result.ok ? formatTraceResult(result.parsed, result.output) : result.output;
    return { ok: result.ok, output: this.truncate(formatted) };
  }

  private async codeGraphImpact(): Promise<ToolExecutionResult> {
    if (!this.codeGraph) return this.codeGraphUnavailable();
    const client = this.codeGraph;

    const result = await client.detectChanges();
    const formatted = result.ok ? formatImpactResult(result.parsed, result.output) : result.output;
    return { ok: result.ok, output: this.truncate(formatted) };
  }

  /**
   * Build the "[Next step] read_file(qualified_name=…)" steer from a search
   * payload, pushing the model down the cheap search→read path instead of
   * re-searching.
   */
  private snippetNextStepHint(parsed: unknown): string {
    if (!parsed || typeof parsed !== "object") return "";
    const results = Array.isArray((parsed as Record<string, unknown>).results)
      ? ((parsed as Record<string, unknown>).results as unknown[])
      : [];
    const withQName = results.find(
      (r) => r && typeof r === "object" && (r as Record<string, unknown>).qualified_name,
    );
    if (!withQName) return "";
    const qn = String((withQName as Record<string, unknown>).qualified_name);
    return (
      `\n\n[Next step] Use read_file(qualified_name="${qn}") to read the source. ` +
      `Copy the exact [qualified_name] from a result above — do NOT re-run the same search.`
    );
  }

  private async codeGraphCodeSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.codeGraph) return this.codeGraphUnavailable();
    const rawQuery = String(args.query ?? "").trim();
    if (!rawQuery) return { ok: false, output: "query is required" };

    const queries = rawQuery.includes("|") ? splitAndCleanCodeSearchQuery(rawQuery) : [rawQuery];
    if (queries.length === 0) return { ok: false, output: "query is required" };

    const rawFilePattern = args.file_pattern !== undefined ? String(args.file_pattern) : undefined;
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(1, args.limit), 50)
        : 20;

    const scopes = rawFilePattern?.includes("|")
      ? splitAlternatives(rawFilePattern).map(normalizeSearchCodeScope)
      : rawFilePattern
        ? [normalizeSearchCodeScope(rawFilePattern)]
        : [{}];

    let mergedParsed: Record<string, unknown> | undefined;
    let lastRaw = "";
    for (const query of queries) {
      for (const scope of scopes) {
        const result = await this.codeGraph.searchCode({
          query,
          file_pattern: scope.file_pattern,
          path: scope.path,
          limit,
        });
        if (!result.ok && result.output.includes("unknown tool")) {
          return this.grepSearch({
            pattern: rawQuery,
            path: scope.path ?? rawFilePattern,
          });
        }
        if (!result.ok) {
          return { ok: false, output: this.truncate(result.output) };
        }
        lastRaw = result.output;
        if (queries.length === 1 && scopes.length === 1) {
          const formatted = formatCodeSearchResults(result.parsed, result.output);
          if (!formatted.includes("No matches found")) {
            return { ok: true, output: this.truncate(formatted) };
          }
          // Primary search returned empty — try auto-recovery before giving up.
          const recovered = await this.codeSearchAutoRecover(rawQuery, rawFilePattern, limit);
          if (recovered) return recovered;
          return { ok: true, output: this.truncate(formatted) };
        }
        mergedParsed = this.mergeSearchCodeParsed(mergedParsed, result.parsed);
      }
    }

    // Multi-query/scope merge: check if ALL results are empty
    if (mergedParsed) {
      const results = Array.isArray(mergedParsed.results) ? mergedParsed.results : [];
      if (results.length === 0) {
        const recovered = await this.codeSearchAutoRecover(rawQuery, rawFilePattern, limit);
        if (recovered) return recovered;
      }
    }

    const formatted = mergedParsed
      ? formatCodeSearchResults(mergedParsed, lastRaw)
      : lastRaw;
    return { ok: true, output: this.truncate(formatted) };
  }

  /**
   * Auto-recovery for code_graph_code_search when primary search returns empty.
   *
   * Strategy (tried in order):
   * 1. If file_pattern was specified, retry WITHOUT file_pattern (scope was too narrow)
   * 2. Fall back to grep (handles regex patterns that CBM's literal search can't)
   */
  private async codeSearchAutoRecover(
    rawQuery: string,
    rawFilePattern: string | undefined,
    limit: number,
  ): Promise<ToolExecutionResult | undefined> {
    // Strategy 1: broaden scope — retry without file_pattern
    if (rawFilePattern && this.codeGraph) {
      const queries = rawQuery.includes("|") ? splitAndCleanCodeSearchQuery(rawQuery) : [rawQuery];
      for (const query of queries) {
        const broader = await this.codeGraph.searchCode({ query, limit });
        if (broader.ok) {
          const formatted = formatCodeSearchResults(broader.parsed, broader.output);
          if (!formatted.includes("No matches found")) {
            return {
              ok: true,
              output: this.truncate(
                `[No results with file_pattern="${rawFilePattern}" — broadened to full project]\n${formatted}`,
              ),
            };
          }
        }
      }
    }

    // Strategy 2: fall back to grep (handles regex that CBM literal search misses)
    const grepResult = await this.grepSearch({
      pattern: rawQuery,
      path: rawFilePattern ?? undefined,
    });
    if (grepResult.ok && !grepResult.output.toLowerCase().includes("no matches")) {
      return {
        ok: true,
        output: this.truncate(
          `[Graph search found nothing — falling back to grep]\n${grepResult.output}`,
        ),
      };
    }

    return undefined;
  }

  private mergeSearchCodeParsed(
    previous: Record<string, unknown> | undefined,
    incoming: unknown,
  ): Record<string, unknown> {
    if (!incoming || typeof incoming !== "object") return previous ?? {};
    const next = incoming as Record<string, unknown>;
    const incomingResults = Array.isArray(next.results) ? next.results : [];
    if (!previous) {
      return { ...next, results: incomingResults };
    }
    const prevResults = Array.isArray(previous.results) ? previous.results : [];
    const seen = new Set<string>();
    const merged = [...prevResults, ...incomingResults].filter((item) => {
      if (!item || typeof item !== "object") return true;
      const row = item as Record<string, unknown>;
      const key = `${String(row.file ?? row.node ?? "")}:${String(row.start_line ?? "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      ...next,
      results: merged,
      total_results: merged.length,
    };
  }

  private async codeGraphSnippet(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.codeGraph) return this.codeGraphUnavailable();
    const qualifiedName = String(args.qualified_name ?? "").trim();
    if (!qualifiedName) return { ok: false, output: "qualified_name is required" };

    const result = await this.codeGraph.getCodeSnippet({ qualified_name: qualifiedName });
    if (!result.ok && result.output.includes("unknown tool")) {
      return {
        ok: false,
        output:
          "get_code_snippet is not available in this version of codebase-memory-mcp. " +
          "Use read_file instead.",
      };
    }

    // Symbol-not-found used to be a dead end: the model burned a turn, then had
    // to re-issue search_graph itself. Auto-recover by searching the leaf name
    // and either resolving a unique match or returning copy-pasteable candidates.
    if (!result.ok && /symbol not found|search_graph/i.test(result.output)) {
      const recovered = await this.recoverSnippet(qualifiedName);
      if (recovered) return recovered;
    }

    let formatted = formatSnippetResult(result.parsed, result.output);
    if (result.ok && result.parsed && typeof result.parsed === "object") {
      const obj = result.parsed as Record<string, unknown>;
      const code = (obj.code ?? obj.source ?? obj.content) as string | undefined;
      if (code) {
        const lineCount = code.split("\n").length;
        if (lineCount > 100) {
          formatted +=
            `\n\n[Hint] This snippet is ${lineCount} lines — you likely used a module-level qualified_name. ` +
            "If you only need one function, use its specific qualified_name from the search results.";
        }
      }
    }
    return { ok: result.ok, output: this.truncate(formatted) };
  }

  /**
   * Recover from a `code_graph_snippet` miss: search the graph for the leaf
   * symbol name and either (a) auto-return the body when exactly one symbol
   * matches, or (b) hand back copy-pasteable candidate qualified_names. Returns
   * undefined when nothing matches (caller falls back to the original error).
   */
  private async recoverSnippet(qualifiedName: string): Promise<ToolExecutionResult | undefined> {
    if (!this.codeGraph) return undefined;
    const leaf = qualifiedName.split(/[.#]/).filter(Boolean).pop() ?? qualifiedName;
    if (!leaf || leaf.length < 2) return undefined;

    const search = await this.codeGraph.searchGraph({
      name_pattern: `^${escapeRegExpLiteral(leaf)}$`,
      limit: 10,
    });
    if (!search.ok || !search.parsed || typeof search.parsed !== "object") return undefined;

    const results = Array.isArray((search.parsed as Record<string, unknown>).results)
      ? ((search.parsed as Record<string, unknown>).results as Record<string, unknown>[])
      : [];
    const candidates = results.filter((r) => r && typeof r.qualified_name === "string");
    if (candidates.length === 0) return undefined;

    // Unique match → resolve it directly so the model doesn't lose a turn.
    if (candidates.length === 1) {
      const qn = String(candidates[0].qualified_name);
      const snippet = await this.codeGraph.getCodeSnippet({ qualified_name: qn });
      if (snippet.ok) {
        return {
          ok: true,
          output: this.truncate(
            `[Auto-resolved "${qualifiedName}" → "${qn}"]\n` +
              formatSnippetResult(snippet.parsed, snippet.output),
          ),
        };
      }
    }

    const list = formatGraphSearchResults(search.parsed, search.output);
    return {
      ok: false,
      output: this.truncate(
        `No symbol matched qualified_name="${qualifiedName}". ` +
          `Candidates for "${leaf}" (copy an exact [qualified_name] into read_file):\n${list}`,
      ),
    };
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

/**
 * Simple pattern matching for protected paths. Supports:
 *   - "test_*"        → matches basename starting with "test_"
 *   - "*_test.py"     → matches basename ending with "_test.py"
 *   - "tests/"        → matches if any path segment is "tests"
 *   - "testing/"      → matches if any path segment is "testing"
 *   - "*\/tests\/*"   → matches if "tests" appears as a directory segment
 */
export function matchProtectedPattern(relPath: string, basename: string, pattern: string): boolean {
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    const segments = relPath.split(path.sep);
    return segments.includes(dir);
  }
  if (pattern.startsWith("*") && !pattern.includes("/")) {
    const suffix = pattern.slice(1);
    return basename.endsWith(suffix);
  }
  if (pattern.endsWith("*") && !pattern.includes("/")) {
    const prefix = pattern.slice(0, -1);
    return basename.startsWith(prefix);
  }
  return basename === pattern || relPath.includes(pattern);
}

/**
 * Extract a lightweight structural outline from lines the agent won't see
 * (the truncated tail of a file). Uses simple regex — no AST parser needed.
 *
 * For JS/TS/Vue files this captures: function/method declarations, class/interface
 * definitions, export statements, Vue lifecycle hooks, and section markers
 * (<template>, <script>, <style>). Each hit is emitted with its original line number
 * so the agent can read_file(offset=N) to get the full implementation.
 */
function extractFileOutline(hiddenLines: string[], startLineNumber: number): string {
  const SIG_PATTERNS = [
    // Python function / method (def, async def) and class declarations
    /^\s*(?:async\s+)?def\s+(\w+)/,
    /^\s*class\s+(\w+)\s*[(:]/,
    // JS/TS function and method declarations
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/,
    // Method-like at top indent: exclude control-flow keywords
    /^\s*(?!if|else|for|while|switch|catch|do|return|throw|new|typeof|delete|void|await|yield)\w+\s*\(.*\)\s*\{/,
    // Class and interface
    /^\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+(\w+)/,
    // Vue SFC sections
    /^<(template|script|style)/,
    // Object method shorthand (common in Vue options API) — also exclude control flow
    /^\s{2,6}(?!if|else|for|while|switch|catch|do|return|throw)\w+\s*\(.*\)\s*\{/,
    // export default / export const
    /^\s*export\s+(default|const|function|class|type|interface|enum)\b/,
    // Vue lifecycle hooks and special methods
    /^\s+(setup|data|computed|methods|watch|mounted|created|beforeMount|beforeCreate|beforeDestroy|destroyed|beforeUnmount|unmounted|props|emits|components)\s*[:(]/,
  ];

  const hits: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < hiddenLines.length; i++) {
    const line = hiddenLines[i];
    const lineNum = startLineNumber + i + 1;

    for (const pat of SIG_PATTERNS) {
      const m = line.match(pat);
      if (m) {
        const trimmed = line.trim();
        // Deduplicate by trimmed content
        if (seen.has(trimmed)) break;
        seen.add(trimmed);
        hits.push(`  L${lineNum}: ${trimmed.slice(0, 100)}`);
        break;
      }
    }

    if (hits.length >= 30) {
      hits.push(`  ... and more (use read_file with offset to explore)`);
      break;
    }
  }

  return hits.length > 0 ? hits.join("\n") : "";
}

/**
 * Expand a single glob pattern containing braces into multiple patterns.
 * e.g. "*.{ts,vue,js}" → ["*.ts", "*.vue", "*.js"]
 * Patterns without braces are returned as-is: ["*.ts"] → ["*.ts"]
 *
 * Only supports one level of braces (no nesting like "*.{ts,{js,jsx}}").
 * Falls back to the original pattern if expansion still contains braces.
 */
export function expandBraceGlob(pattern: string): string[] {
  const match = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (!match) return [pattern];
  const [, prefix, alternatives, suffix] = match;
  const expanded = alternatives.split(",").map((alt) => `${prefix}${alt.trim()}${suffix}`);
  if (expanded.some((p) => p.includes("{"))) return [pattern];
  return expanded;
}

/** Escape regex metacharacters so a literal symbol name is safe as a name_pattern. */
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract file paths from a unified diff (the `b/...` side of `diff --git`). */
function extractPatchFilePaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      if (match) paths.push(match[1]);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Architecture summary builder
// ---------------------------------------------------------------------------

interface FileTreeNode {
  path?: string;
  type?: string;
  children?: number | FileTreeNode[];
}

/**
 * Post-process the raw `code_graph_architecture` JSON into a compact,
 * actionable summary the LLM can actually use to scope subsequent searches.
 *
 * Goals:
 *   1. Module map — business modules with file counts (depth 3-4)
 *   2. Filtered hotspots — drop generic utility symbols (fan_in > 80)
 *   3. Concise stats — languages, node/edge counts
 *   4. Actionable hints — suggest code_graph_search file_pattern values
 */
export function buildArchitectureSummary(raw: Record<string, unknown>): string {
  const sections: string[] = [];

  // --- 1. Quick stats ---------------------------------------------------
  const totalNodes = raw.total_nodes ?? "?";
  const totalEdges = raw.total_edges ?? "?";
  const languages = raw.languages as { language: string; file_count: number }[] | undefined;
  const langLine = languages?.length
    ? languages
        .slice(0, 8)
        .map((l) => `${l.language}(${l.file_count})`)
        .join(", ")
    : "unknown";
  sections.push(`## Project overview\nNodes: ${totalNodes}  Edges: ${totalEdges}  Languages: ${langLine}`);

  // --- 2. Module map from file_tree -------------------------------------
  const fileTree = raw.file_tree as FileTreeNode[] | undefined;
  if (fileTree?.length) {
    const moduleMap = buildModuleMap(fileTree);
    if (moduleMap) {
      sections.push(`## Module map\n${moduleMap}`);
    }
  }

  // --- 3. Business modules (auto-detected) ------------------------------
  // Prefer the indexer's own `packages` ranking (works for any language,
  // incl. snake_case Python packages). Fall back to the file_tree heuristic
  // only when `packages` is absent.
  const packageModules = detectModulesFromPackages(raw.packages);
  const businessModules =
    packageModules.length > 0 ? packageModules : detectBusinessModules(fileTree);
  if (businessModules.length > 0) {
    const moduleList = businessModules
      .map((m) => `  "${m.name}"  →  ${m.path}  (${m.fileCount} symbols)`)
      .join("\n");
    sections.push(
      `## Detected business modules\nUse these as file_pattern in symbol_search:\n${moduleList}`,
    );
  } else if (!fileTree?.length) {
    // file_tree missing — likely caused by using filtered aspects instead of "all"
    sections.push(
      `## ⚠ Module map unavailable\n` +
      `The file_tree was not included in this response — likely because aspects was not ["all"]. ` +
      `Re-run codebase_overview(aspects=["all"]) to get the module map needed to scope searches. ` +
      `Without the module map, you will need to use glob_search or list_directory to find relevant modules.`,
    );
  }

  // --- 4. Hotspots (filtered) -------------------------------------------
  const hotspots = raw.hotspots as { name: string; qualified_name?: string; fan_in: number }[] | undefined;
  if (hotspots?.length) {
    // Filter out generic utility symbols — keep only domain-relevant ones
    const meaningful = hotspots.filter((h) => h.fan_in <= 80 && h.fan_in >= 5);
    const top = (meaningful.length > 0 ? meaningful : hotspots).slice(0, 8);
    const lines = top.map(
      (h) => `  ${h.name} (fan_in=${h.fan_in})${h.qualified_name ? `  ${extractShortPath(h.qualified_name)}` : ""}`,
    );
    sections.push(`## Key symbols (by fan-in)\n${lines.join("\n")}`);
  }

  // --- 5. Entry points (compact) ----------------------------------------
  const entryPoints = raw.entry_points as { name: string; file?: string }[] | undefined;
  if (entryPoints?.length) {
    const shown = entryPoints.slice(0, 8);
    const lines = shown.map((e) => `  ${e.name}  →  ${e.file ?? "?"}`);
    if (entryPoints.length > shown.length) {
      lines.push(`  ... and ${entryPoints.length - shown.length} more`);
    }
    sections.push(`## Entry points\n${lines.join("\n")}`);
  }

  // --- 6. Routes (compact) ----------------------------------------------
  const routes = raw.routes as { method?: string; path?: string }[] | undefined;
  if (routes?.length) {
    const shown = routes.slice(0, 10);
    const lines = shown.map((r) => `  ${r.method || "?"} ${r.path || "?"}`);
    if (routes.length > shown.length) {
      lines.push(`  ... and ${routes.length - shown.length} more`);
    }
    sections.push(`## API routes\n${lines.join("\n")}`);
  }

  // --- 7. Actionable hints ----------------------------------------------
  const hints: string[] = [
    `To explore a specific module: symbol_search(file_pattern="<module-name>", name_pattern="<keyword>")`,
    `To find status/config in a module: symbol_search(file_pattern="<module-name>", name_pattern="status|config|enum")`,
    `To search text in a module: text_search(query="<text>", file_pattern="<module-name>")`,
  ];
  sections.push(`## Next steps\n${hints.join("\n")}`);

  return sections.join("\n\n");
}

/**
 * Build a compact directory tree showing business-relevant modules.
 * Groups by top-level → second-level → third-level, counting files in each.
 */
function buildModuleMap(fileTree: FileTreeNode[]): string {
  // Collect all directory entries — use `children` as initial count only when
  // there are NO individual file entries (summary mode). When file entries
  // exist we count them directly to avoid double-counting.
  const dirs = new Map<string, { fileCount: number; subdirs: string[] }>();
  const hasFileEntries = fileTree.some((n) => n.type === "file");

  for (const node of fileTree) {
    if (!node.path || node.type !== "dir") continue;
    const depth = node.path.split("/").length;
    if (depth > 8) continue;

    const initialCount = hasFileEntries ? 0 : (typeof node.children === "number" ? node.children : 0);
    dirs.set(node.path, { fileCount: initialCount, subdirs: [] });
  }

  if (hasFileEntries) {
    for (const node of fileTree) {
      if (!node.path || node.type !== "file") continue;
      const parts = node.path.split("/");
      for (let d = 1; d < Math.min(parts.length, 8); d++) {
        const dirPath = parts.slice(0, d).join("/");
        const entry = dirs.get(dirPath);
        if (entry) entry.fileCount++;
      }
    }
  }

  // Build tree output — show directories up to depth 6 that have meaningful content.
  // For deep dirs (depth > 3), only show if they look like business modules (kebab-case).
  const lines: string[] = [];
  const sortedDirs = [...dirs.entries()]
    .filter(([p]) => {
      const depth = p.split("/").length;
      if (depth <= 3) return true;
      // For deeper dirs, only show kebab-case names (business modules)
      const name = p.split("/").pop() || "";
      return name.includes("-") && !name.startsWith(".");
    })
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [dirPath, info] of sortedDirs) {
    const depth = dirPath.split("/").length;
    // Skip leaf dirs with 0 files
    if (info.fileCount === 0 && depth > 2) continue;
    const indent = "  ".repeat(depth - 1);
    const name = dirPath.split("/").pop() || dirPath;
    const countStr = info.fileCount > 0 ? ` (${info.fileCount} files)` : "";
    lines.push(`${indent}${name}/${countStr}`);
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

interface PackageEntry {
  name?: string;
  node_count?: number;
}

/** Directory/package names that are infrastructure, not business logic. */
const NON_BUSINESS_NAME =
  /^(node_modules|dist|build|out|coverage|__pycache__|__tests__|tests?|test|docs?|examples?|benchmarks?|samples?|fixtures?|vendor|third_party|migrations|scripts?|bin|certs?|tool|tools|setup|conf|conftest|makefile|tox|pyproject|requirements|\..*)$/i;

/** A name is "test-ish" if it lives in / describes test code. */
function isTestLikeName(name: string): boolean {
  return /^test[_-]|[_-]tests?$|^tests?$/i.test(name);
}

/**
 * Preferred module detection: use the indexer's own `packages` ranking. This
 * is language-agnostic and works for snake_case Python packages (django,
 * sympy, …) where the old kebab-case file_tree heuristic produced nothing.
 * Filters out test packages and build/infra noise, ranks by symbol count.
 */
function detectModulesFromPackages(
  packages: unknown,
): { name: string; path: string; fileCount: number }[] {
  if (!Array.isArray(packages)) return [];
  const modules: { name: string; path: string; fileCount: number }[] = [];
  const seen = new Set<string>();
  for (const entry of packages as PackageEntry[]) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name || seen.has(name)) continue;
    if (isTestLikeName(name) || NON_BUSINESS_NAME.test(name)) continue;
    // Require a real identifier-ish name (skip parsed config files, etc.).
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) continue;
    const count = typeof entry?.node_count === "number" ? entry.node_count : 0;
    if (count < 3) continue;
    seen.add(name);
    // `name` doubles as a file_pattern (matched as a path substring).
    modules.push({ name, path: name, fileCount: count });
  }
  return modules.sort((a, b) => b.fileCount - a.fileCount).slice(0, 15);
}

/**
 * Fallback module detection from the file tree (used only when `packages` is
 * unavailable). Surfaces substantial source directories, skipping test/infra.
 */
function detectBusinessModules(
  fileTree: FileTreeNode[] | undefined,
): { name: string; path: string; fileCount: number }[] {
  if (!fileTree) return [];

  const modules: { name: string; path: string; fileCount: number }[] = [];
  const seen = new Set<string>();

  for (const node of fileTree) {
    if (!node.path || node.type !== "dir") continue;
    const parts = node.path.split("/");
    if (parts.length < 1 || parts.length > 8) continue;

    const name = parts[parts.length - 1];
    if (name.startsWith(".") || isTestLikeName(name) || NON_BUSINESS_NAME.test(name)) continue;

    if (seen.has(name)) continue;
    seen.add(name);

    const childCount = typeof node.children === "number" ? node.children : 0;
    if (childCount >= 3) {
      modules.push({ name, path: node.path, fileCount: childCount });
    }
  }

  // Sort by file count descending — most substantial modules first
  return modules.sort((a, b) => b.fileCount - a.fileCount).slice(0, 20);
}

/** Extract a short readable path from a qualified_name like "project.domains.mod.file.symbol". */
function extractShortPath(qualifiedName: string): string {
  const parts = qualifiedName.split(".");
  // Drop the project prefix (first segment is usually the long project hash)
  const meaningful = parts.length > 3 ? parts.slice(1) : parts;
  return meaningful.join("/");
}

// ---------------------------------------------------------------------------
// Output format alignment: transform graph-tool JSON → grep/read_file style
// ---------------------------------------------------------------------------

interface GraphSearchResultItem {
  name?: string;
  qualified_name?: string;
  file_path?: string;
  line?: number;
  label?: string;
  score?: number;
}

/**
 * Format search_graph / semantic_search results into grep-like output:
 *   file_path:line: symbol_name  (label)  [qualified_name]
 *
 * Falls back to raw JSON if the payload doesn't match the expected shape.
 */
export function formatGraphSearchResults(parsed: unknown, raw: string): string {
  if (!parsed || typeof parsed !== "object") return raw;
  const obj = parsed as Record<string, unknown>;
  const results = Array.isArray(obj.results) ? (obj.results as GraphSearchResultItem[]) : null;
  if (!results || results.length === 0) {
    const total = obj.total ?? 0;
    return `No results found (total: ${total}).`;
  }

  const total = obj.total ?? results.length;
  const hasMore = obj.has_more === true;

  const lines = results.map((r) => {
    const file = r.file_path ?? "?";
    const lineNum = r.line && r.line > 0 ? r.line : null;
    const name = r.name ?? "?";
    const label = r.label ? `  (${r.label})` : "";
    const qname = r.qualified_name ? `  [${r.qualified_name}]` : "";
    const loc = lineNum ? `${file}:${lineNum}` : file;
    return `${loc}: ${name}${label}${qname}`;
  });

  const header = `Found ${total} result(s)${hasMore ? " (more available, increase limit)" : ""}:`;
  return [header, ...lines].join("\n");
}

interface CodeSearchResultItem {
  file?: string;
  node?: string;
  start_line?: number;
  end_line?: number;
  context?: string;
  snippet?: string;
  content?: string;
  function_name?: string;
  symbol?: string;
}

/**
 * Format search_code results into grep-like output:
 *   file:start_line: content  (in function_name)
 *
 * Falls back to raw JSON if the payload doesn't match the expected shape.
 */
export function formatCodeSearchResults(parsed: unknown, raw: string): string {
  if (!parsed || typeof parsed !== "object") return raw;
  const obj = parsed as Record<string, unknown>;
  const results = Array.isArray(obj.results) ? (obj.results as CodeSearchResultItem[]) : null;
  if (!results || results.length === 0) {
    return "No matches found.";
  }

  const total = obj.total_results ?? obj.total ?? results.length;

  const lines = results.map((r) => {
    const file = r.file ?? r.node ?? "?";
    const lineNum = r.start_line && r.start_line > 0 ? r.start_line : null;
    const text = (r.snippet ?? r.context ?? r.content ?? "").trim().split("\n")[0] ?? "";
    const inFn = r.function_name ?? r.symbol;
    const fnTag = inFn ? `  (in ${inFn})` : "";
    const loc = lineNum ? `${file}:${lineNum}` : file;
    return `${loc}: ${text}${fnTag}`;
  });

  const header = `Found ${total} match(es):`;
  return [header, ...lines].join("\n");
}

interface TraceEdge {
  name?: string;
  qualified_name?: string;
  hop?: number;
}

/**
 * Format trace_call_path results into a compact call list instead of raw JSON:
 *   Trace foo (both):
 *     callers (1):
 *       [hop 1] bar  [pkg.mod.Bar.bar]
 */
export function formatTraceResult(parsed: unknown, raw: string): string {
  if (!parsed || typeof parsed !== "object") return raw;
  const obj = parsed as Record<string, unknown>;
  const fn = typeof obj.function === "string" ? obj.function : "?";
  const direction = typeof obj.direction === "string" ? obj.direction : "both";

  const renderEdges = (label: string, edges: unknown): string[] => {
    if (!Array.isArray(edges) || edges.length === 0) return [];
    const lines = (edges as TraceEdge[]).map((e) => {
      const hop = typeof e.hop === "number" ? `[hop ${e.hop}] ` : "";
      const qn = e.qualified_name ? `  [${e.qualified_name}]` : "";
      return `    ${hop}${e.name ?? "?"}${qn}`;
    });
    return [`  ${label} (${edges.length}):`, ...lines];
  };

  const callers = renderEdges("callers", obj.callers);
  const callees = renderEdges("callees", obj.callees);
  if (callers.length === 0 && callees.length === 0) {
    return `Trace ${fn} (${direction}): no call relationships found.`;
  }
  return [`Trace ${fn} (${direction}):`, ...callers, ...callees].join("\n");
}

interface ImpactSymbol {
  name?: string;
  label?: string;
  file?: string;
}

/**
 * Format detect_changes (impact) results into a compact blast-radius summary
 * instead of raw JSON.
 */
export function formatImpactResult(parsed: unknown, raw: string): string {
  if (!parsed || typeof parsed !== "object") return raw;
  const obj = parsed as Record<string, unknown>;
  const changedFiles = Array.isArray(obj.changed_files) ? (obj.changed_files as string[]) : [];
  if (changedFiles.length === 0) {
    return "Impact: no uncommitted changes detected.";
  }
  const depth = typeof obj.depth === "number" ? ` (depth ${obj.depth})` : "";
  const header = `Impact${depth}: ${changedFiles.length} changed file(s):`;
  const fileLines = changedFiles.map((f) => `  ${f}`);

  const symbols = Array.isArray(obj.impacted_symbols)
    ? (obj.impacted_symbols as ImpactSymbol[])
    : [];
  const out = [header, ...fileLines];
  if (symbols.length > 0) {
    const shown = symbols.slice(0, 30);
    out.push(`Impacted symbols (${symbols.length}):`);
    for (const s of shown) {
      const label = s.label ? `  (${s.label})` : "";
      const file = s.file ? `  ${s.file}` : "";
      out.push(`  ${s.name ?? "?"}${label}${file}`);
    }
    if (symbols.length > shown.length) {
      out.push(`  ... and ${symbols.length - shown.length} more`);
    }
  }
  return out.join("\n");
}

interface SnippetResultPayload {
  qualified_name?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  code?: string;
  source?: string;
  content?: string;
  language?: string;
}

/**
 * Format get_code_snippet results into read_file-style numbered lines:
 *   42| export function downloadTemplate(baseUrl, fileName) {
 *   43|   window.open(baseUrl + fileName);
 *   44| }
 *
 * Falls back to raw output if the payload doesn't have code content.
 */
export function formatSnippetResult(parsed: unknown, raw: string): string {
  if (!parsed || typeof parsed !== "object") return raw;
  const obj = parsed as SnippetResultPayload;
  const code = obj.code ?? obj.source ?? obj.content;
  if (!code) return raw;

  const filePath = obj.file_path ?? "?";
  const startLine = obj.start_line ?? 1;
  const codeLines = code.split("\n");

  const numbered = codeLines.map(
    (line, i) => `${String(startLine + i).padStart(6)}|${line}`,
  );

  const header = `--- ${filePath} ---`;
  return [header, ...numbered].join("\n");
}
