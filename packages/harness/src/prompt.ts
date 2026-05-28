/**
 * Dynamic system prompt builder.
 * Assembles prompt sections based on workspace context, task type, and configuration.
 */

export interface PromptContext {
  workspaceRoot: string;
  /** Detected languages/frameworks in the workspace */
  languages?: string[];
  /** Key files discovered (package.json, Cargo.toml, etc.) */
  projectFiles?: string[];
  /** Custom instructions from user or project config */
  customInstructions?: string;
  /** Task category hint */
  taskHint?: "debug" | "implement" | "refactor" | "explain" | "general";
}

export function buildSystemPrompt(contextOrRoot: string | PromptContext): string {
  const ctx: PromptContext =
    typeof contextOrRoot === "string"
      ? { workspaceRoot: contextOrRoot }
      : contextOrRoot;

  const sections = [
    buildRoleSection(),
    buildWorkspaceSection(ctx),
    buildToolsSection(),
    buildRulesSection(),
    buildWorkflowSection(ctx),
  ];

  if (ctx.languages && ctx.languages.length > 0) {
    sections.push(buildLanguageHints(ctx.languages));
  }

  if (ctx.customInstructions) {
    sections.push(buildCustomSection(ctx.customInstructions));
  }

  return sections.join("\n\n");
}

function buildRoleSection(): string {
  return `You are an expert software engineer acting as a coding agent. You MUST use the provided tools to interact with the codebase — never guess or hallucinate file contents, paths, or command outputs.`;
}

function buildWorkspaceSection(ctx: PromptContext): string {
  let section = `## Workspace\n\nRoot: ${ctx.workspaceRoot}\nAll file paths should be relative to this root.`;

  if (ctx.projectFiles && ctx.projectFiles.length > 0) {
    section += `\n\nDetected project files: ${ctx.projectFiles.join(", ")}`;
  }

  return section;
}

function buildToolsSection(): string {
  return `## Available Tools

- **read_file(path)** — Read file contents. Use BEFORE editing to understand context.
- **write_file(path, content)** — Create or completely overwrite a file.
- **edit_file(path, old_string, new_string, replace_all?)** — Replace a string in a file. old_string MUST match exactly (including whitespace/indentation). Include enough surrounding lines to ensure a unique match — or pass replace_all=true for renames.
- **multi_edit(path, edits[])** — Apply several sequential string replacements to one file atomically. Prefer this over multiple edit_file calls when making related changes to the same file.
- **apply_patch(patch, check_only?)** — Apply a unified diff via \`git apply\`. Use for multi-file changes. Pass check_only=true to dry-run.
- **bash(command)** — Execute a command in a persistent shell. State (cwd, env vars) persists between calls. Use cd to change directories.
- **glob_search(pattern)** — Find files matching a glob pattern.
- **grep_search(pattern, path?)** — Search file contents with regex.
- **list_directory(path)** — List directory contents.
- **todo_write(todos[])** — Maintain a working todo list for the user. Use for tasks with 3+ steps. Pass the full list each call; mark at most one item in_progress at a time.`;
}

function buildRulesSection(): string {
  return `## Critical Rules

1. **ALWAYS use tools** — Never assume or fabricate file contents. If you need to know something, use a tool.
2. **Read before edit** — Always read_file before edit_file to get exact current content.
3. **Precise edits** — For edit_file, copy the EXACT text from read_file output (including indentation). The old_string must be unique in the file.
4. **Be efficient** — Complete the task with minimal tool calls. Do NOT do unnecessary verification after straightforward changes.
5. **Stop when done** — Once the task is accomplished, provide a brief summary and stop. Do NOT continue with extra reads or commands after the goal is met.
6. **Relative paths** — Always use paths relative to the workspace root.`;
}

function buildWorkflowSection(ctx: PromptContext): string {
  switch (ctx.taskHint) {
    case "debug":
      return `## Workflow (Debugging)

1. Read the failing test or error message to understand symptoms
2. Trace the code path — follow imports and function calls to find the root cause
3. Fix the root cause (not the symptom)
4. Run the test/command to verify the fix
5. Report what you found and fixed`;

    case "implement":
      return `## Workflow (Implementation)

1. Read existing code to understand patterns, conventions, and interfaces
2. Check for README or documentation describing the expected behavior
3. Implement the feature following existing patterns
4. Run tests if they exist to verify
5. Report what you implemented`;

    case "refactor":
      return `## Workflow (Refactoring)

1. Read the current code and understand its full API surface
2. Identify all callers/importers that depend on it
3. Make changes incrementally, preserving the public interface
4. Run existing tests to verify nothing broke
5. Report the refactoring done`;

    default:
      return `## Workflow

For most tasks, follow this pattern:
1. Understand the request
2. Read relevant files to get context
3. Make the necessary changes (edit_file or write_file)
4. Stop — report what you did

Only add extra steps (running tests, typechecking) if the task explicitly asks for it or if the change is complex enough to warrant verification.`;
  }
}

function buildLanguageHints(languages: string[]): string {
  const hints: string[] = [];

  for (const lang of languages) {
    switch (lang.toLowerCase()) {
      case "typescript":
      case "ts":
        hints.push("- TypeScript: Use strict types. Prefer edit_file for .ts/.tsx changes. Run `npx tsc --noEmit` to typecheck.");
        break;
      case "python":
      case "py":
        hints.push("- Python: Follow PEP 8. Use type hints. Run tests with `python -m pytest` or `python <test_file>`.");
        break;
      case "rust":
        hints.push("- Rust: Run `cargo check` for compilation errors. Use `cargo test` for tests.");
        break;
      case "go":
        hints.push("- Go: Run `go build ./...` to check compilation. Use `go test ./...` for tests.");
        break;
      case "javascript":
      case "js":
        hints.push("- JavaScript: Check for ESM vs CommonJS. Use `node` to run scripts.");
        break;
    }
  }

  if (hints.length === 0) return "";
  return `## Language Notes\n\n${hints.join("\n")}`;
}

function buildCustomSection(instructions: string): string {
  return `## Project-Specific Instructions\n\n${instructions}`;
}

/**
 * Detect workspace context by scanning for common project files.
 * Returns a PromptContext with detected languages and project files.
 */
export async function detectWorkspaceContext(workspaceRoot: string): Promise<PromptContext> {
  const { readdir } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  const ctx: PromptContext = { workspaceRoot, languages: [], projectFiles: [] };

  try {
    const entries = await readdir(workspaceRoot);

    for (const entry of entries) {
      switch (entry) {
        case "package.json":
          ctx.projectFiles!.push(entry);
          if (!ctx.languages!.includes("typescript")) {
            // Check if tsconfig exists
            if (entries.includes("tsconfig.json")) {
              ctx.languages!.push("typescript");
              ctx.projectFiles!.push("tsconfig.json");
            } else {
              ctx.languages!.push("javascript");
            }
          }
          break;
        case "tsconfig.json":
          if (!ctx.projectFiles!.includes(entry)) ctx.projectFiles!.push(entry);
          if (!ctx.languages!.includes("typescript")) ctx.languages!.push("typescript");
          break;
        case "Cargo.toml":
          ctx.projectFiles!.push(entry);
          ctx.languages!.push("rust");
          break;
        case "go.mod":
          ctx.projectFiles!.push(entry);
          ctx.languages!.push("go");
          break;
        case "pyproject.toml":
        case "setup.py":
        case "requirements.txt":
          ctx.projectFiles!.push(entry);
          if (!ctx.languages!.includes("python")) ctx.languages!.push("python");
          break;
        case "Gemfile":
          ctx.projectFiles!.push(entry);
          ctx.languages!.push("ruby");
          break;
        case ".cursor":
        case "AGENTS.md":
          // Check for custom instructions
          try {
            const { readFile } = await import("node:fs/promises");
            const content = await readFile(resolve(workspaceRoot, entry === ".cursor" ? ".cursor/rules" : entry), "utf8").catch(() => "");
            if (content) ctx.customInstructions = content.slice(0, 2000);
          } catch { /* ignore */ }
          break;
      }
    }
  } catch { /* workspace might not exist yet */ }

  return ctx;
}
