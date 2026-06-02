/**
 * Dynamic system prompt builder.
 * Assembles prompt sections based on workspace context, task type, and configuration.
 */

import { readFileSync } from "node:fs";

export interface PromptContext {
  workspaceRoot: string;
  /** Detected languages/frameworks in the workspace */
  languages?: string[];
  /** Key files discovered (package.json, Cargo.toml, etc.) */
  projectFiles?: string[];
  /** Custom instructions from user or project config */
  customInstructions?: string;
  /** Task category hint */
  taskHint?: "debug" | "implement" | "refactor" | "explain" | "terminal" | "general";
  /** codebase-memory-mcp indexed and code_graph_* tools are available */
  codeGraphEnabled?: boolean;
}

/** Read optional prompt extras from process env (used by Terminal-Bench eval). */
export function readPromptExtrasFromEnv(): {
  customInstructions?: string;
  taskHint?: PromptContext["taskHint"];
} {
  const out: { customInstructions?: string; taskHint?: PromptContext["taskHint"] } = {};

  const extra = process.env.FORGELET_SYSTEM_PROMPT_EXTRA?.trim();
  if (extra) {
    out.customInstructions = extra;
  }

  const extraFile = process.env.FORGELET_PROMPT_EXTRA_FILE?.trim();
  if (extraFile) {
    try {
      const fromFile = readFileSync(extraFile, "utf8").trim();
      if (fromFile) {
        out.customInstructions = out.customInstructions
          ? `${out.customInstructions}\n\n${fromFile}`
          : fromFile;
      }
    } catch {
      // Missing file is non-fatal; caller may set FORGELET_SYSTEM_PROMPT_EXTRA instead.
    }
  }

  const hint = process.env.FORGELET_TASK_HINT?.trim().toLowerCase();
  if (
    hint === "debug" ||
    hint === "implement" ||
    hint === "refactor" ||
    hint === "explain" ||
    hint === "terminal" ||
    hint === "general"
  ) {
    out.taskHint = hint;
  }

  return out;
}

/** Merge env-driven prompt extras into a PromptContext (env wins on taskHint). */
export function mergePromptContextFromEnv(ctx: PromptContext): PromptContext {
  const extras = readPromptExtrasFromEnv();
  return {
    ...ctx,
    taskHint: extras.taskHint ?? ctx.taskHint,
    customInstructions: extras.customInstructions
      ? ctx.customInstructions
        ? `${ctx.customInstructions}\n\n${extras.customInstructions}`
        : extras.customInstructions
      : ctx.customInstructions,
  };
}

export function buildSystemPrompt(contextOrRoot: string | PromptContext): string {
  const ctx: PromptContext =
    typeof contextOrRoot === "string"
      ? { workspaceRoot: contextOrRoot }
      : contextOrRoot;

  const sections = [
    buildRoleSection(),
    buildWorkspaceSection(ctx),
    buildToolsSection(ctx),
    ...(ctx.codeGraphEnabled ? [buildCodeGraphRoutingSection()] : []),
    buildRulesSection(ctx),
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

function buildToolsSection(ctx: PromptContext): string {
  const base = `## Available Tools

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

  if (!ctx.codeGraphEnabled) return base;

  return `${base}
- **code_graph_architecture(aspects?)** — Indexed repo overview: languages, packages, entry points, routes, hotspots, clusters. Use first on unfamiliar/large codebases.
- **code_graph_search(name_pattern?, label?, file_pattern?)** — Find functions/classes/methods by symbol name in the graph (not plain-text grep).
- **code_graph_trace(function_name, direction?, depth?)** — Callers (inbound) or callees (outbound) of a symbol.
- **code_graph_impact()** — Map uncommitted git changes to affected symbols; run before declaring done.`;
}

function buildCodeGraphRoutingSection(): string {
  return `## Tool routing (code graph vs text tools)

The codebase is indexed for structural tools. They complement — do not replace — read_file / grep / glob / bash:

| Goal | Tool |
|------|------|
| Orient in an unfamiliar or large repo | **code_graph_architecture** first, then search/read |
| Find a class, function, or method by name | **code_graph_search** (then **read_file** that path before edit) |
| Who calls this / what does it call | **code_graph_trace** |
| Error messages, strings, configs, comments in files | **grep_search** |
| Find files by path pattern | **glob_search** |
| Exact file contents for editing | **read_file** (required before edit_file) |
| Run tests, git, builds | **bash** |
| Before stopping — missing symmetric fixes? | **code_graph_search** / **code_graph_trace**, then **code_graph_impact** |

Do not use grep_search to enumerate all methods in a class when code_graph_search can do it. Do not skip read_file after graph tools — the graph gives locations, not editable source text.`;
}

function buildRulesSection(ctx: PromptContext): string {
  const structuralRule = ctx.codeGraphEnabled
    ? "5. **Structural completeness** — After editing one method, use code_graph_search or code_graph_trace to check paired/symmetric methods in the same class (transform/inverse_transform, serialize/deserialize) and apply the same fix where needed.\n6. **Finish with impact** — Before declaring done, run code_graph_impact once when you have uncommitted source changes.\n"
    : "";
  const stopNum = ctx.codeGraphEnabled ? 7 : 5;
  const pathNum = ctx.codeGraphEnabled ? 8 : 6;

  return `## Critical Rules

1. **ALWAYS use tools** — Never assume or fabricate file contents. If you need to know something, use a tool.
2. **Read before edit** — Always read_file before edit_file to get exact current content.
3. **Precise edits** — For edit_file, copy the EXACT text from read_file output (including indentation). The old_string must be unique in the file.
4. **Verify after edit** — Run related tests or typechecks after changes. If tests fail, fix your source code — never modify existing test assertions or expected values to make them pass. You may add new test functions if useful, but never alter or delete existing ones.
${structuralRule}${stopNum}. **Stop when done** — Once the task is accomplished and verified, provide a brief summary and stop.
${pathNum}. **Relative paths** — Always use paths relative to the workspace root.`;
}

function buildWorkflowSection(ctx: PromptContext): string {
  const graphLocate = ctx.codeGraphEnabled
    ? "Use code_graph_search (or code_graph_architecture if the repo layout is unclear), then read_file paths from results. "
    : "";
  const graphFinish = ctx.codeGraphEnabled
    ? " Before stopping, run code_graph_impact if you changed source files.\n"
    : "";

  switch (ctx.taskHint) {
    case "debug":
      return `## Workflow (Debugging)

1. Read the failing test or error message to understand symptoms
2. Trace the code path — ${graphLocate}use code_graph_trace for call chains; grep_search for error strings in logs
3. Fix the root cause (not the symptom)
4. Run the test/command to verify the fix
5. Report what you found and fixed${graphFinish}`;

    case "implement":
      return `## Workflow (Implementation)

1. ${ctx.codeGraphEnabled ? "code_graph_architecture or " : ""}read existing code to understand patterns, conventions, and interfaces
2. Check for README or documentation describing the expected behavior
3. Implement the feature following existing patterns
4. Run tests if they exist to verify
5. Report what you implemented${graphFinish}`;

    case "refactor":
      return `## Workflow (Refactoring)

1. Read the current code and understand its full API surface
2. Identify all callers — ${ctx.codeGraphEnabled ? "code_graph_trace (inbound) and " : ""}imports that depend on it
3. Make changes incrementally, preserving the public interface
4. Run existing tests to verify nothing broke
5. Report the refactoring done${graphFinish}`;

    case "terminal":
      return `## Workflow (Terminal / CLI Tasks)

1. Read the task instruction carefully; note required outputs, paths, and formats.
2. Explore the environment with list_directory, read_file, and bash (pwd, ls, find) before changing anything.
3. Use bash for system tools (git, curl, awk/sed/jq, package managers, compilers). Pass timeout_ms for long commands (builds, installs).
4. Create or edit files with write_file / edit_file when scripts or configs are needed.
5. Verify the result matches the spec (run the command or test mentioned in the task, or inspect output files).
6. Stop when the task is complete — do not run unrelated exploration.`;

    default:
      return ctx.codeGraphEnabled
        ? `## Workflow

For most tasks, follow this pattern:
1. Understand the request — if the repo is unfamiliar, start with code_graph_architecture
2. Locate symbols with code_graph_search (or grep_search for plain text), then read_file before any edit
3. Make the necessary changes (edit_file or write_file)
4. After edits to a method, code_graph_search/trace for symmetric or related symbols; fix those too
5. Run related tests or typechecks — fix failures in source, not existing tests
6. code_graph_impact, then stop — report what you did`
        : `## Workflow

For most tasks, follow this pattern:
1. Understand the request
2. Read relevant files to get context
3. Make the necessary changes (edit_file or write_file)
4. Run related tests or typechecks to confirm correctness — fix any failures before declaring done
5. Stop — report what you did`;
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
