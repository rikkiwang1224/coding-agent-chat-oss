/**
 * Dynamic system prompt builder.
 * Assembles prompt sections based on workspace context, task type, and configuration.
 */

import { readFileSync } from "node:fs";
import { PROVIDER_PRESETS, type LlmProvider } from "@forgelet/sdk-runtime";

export interface PromptContext {
  workspaceRoot: string;
  /** Configured LLM vendor — injected at runtime for identity questions. */
  provider?: LlmProvider;
  /** Configured model id — injected at runtime for identity questions. */
  model?: string;
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

/** Attach runtime LLM identity from config (config wins when already set on ctx). */
export function withLlmIdentity(
  ctx: PromptContext,
  config: { provider?: LlmProvider; model?: string },
): PromptContext {
  return {
    ...ctx,
    provider: config.provider ?? ctx.provider,
    model: config.model ?? ctx.model,
  };
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
    buildIdentitySection(ctx),
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

function providerLabel(provider: LlmProvider): string {
  if (provider in PROVIDER_PRESETS) {
    return PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS].label;
  }
  switch (provider) {
    case "bedrock":
      return "AWS Bedrock";
    case "vertex":
      return "Google Vertex AI";
    case "custom":
      return "custom provider";
    default:
      return provider;
  }
}

function buildIdentitySection(ctx: PromptContext): string {
  const neverGuessRule =
    "Never invent or guess your vendor or model name. Do not claim to be Claude, Anthropic, GPT, OpenAI, Gemini, or any vendor unless listed below.";

  if (!ctx.provider && !ctx.model) {
    return `## Identity

You are **Forgelet**, a coding agent in this workspace.
If asked who you are or what model powers you, say you are Forgelet and that provider/model metadata is unavailable in this session.
${neverGuessRule}`;
  }

  const vendor = ctx.provider ? providerLabel(ctx.provider) : "configured provider";
  const model =
    ctx.model ??
    (ctx.provider && ctx.provider in PROVIDER_PRESETS
      ? PROVIDER_PRESETS[ctx.provider as keyof typeof PROVIDER_PRESETS].defaultPrimaryModel
      : "configured model");

  return `## Identity

You are **Forgelet**, a coding agent powered by **${vendor}** model **${model}**.

When the user asks who you are, what model you use, or whether you are Claude / GPT / DeepSeek / etc.:
- Answer **only** from this Identity section: Forgelet on ${vendor} (${model}).
- ${neverGuessRule}`;
}

function buildWorkspaceSection(ctx: PromptContext): string {
  let section = `## Workspace\n\nRoot: ${ctx.workspaceRoot}\nAll file paths should be relative to this root.`;

  if (ctx.projectFiles && ctx.projectFiles.length > 0) {
    section += `\n\nDetected project files: ${ctx.projectFiles.join(", ")}`;
  }

  return section;
}

function buildToolsSection(ctx: PromptContext): string {
  const lines: string[] = [];

  if (ctx.codeGraphEnabled) {
    lines.push(
      `### Search tools (3 orthogonal axes — pick the right one)`,
      `- **symbol_search(name_pattern?, label?, file_pattern?)** — **Find symbols** by name (regex) + file scope. Also handles natural language keywords — automatically falls back to BM25 when structural search yields nothing.`,
      `- **text_search(query, file_pattern?)** — **Find text** in code. Graph-augmented text/regex search (like grep but with graph context). For route paths, config values, string literals, error messages. Auto-falls back to grep when graph search misses, and auto-broadens scope when file_pattern is too narrow.`,
      `- **glob_search(pattern)** — **Find files** by path pattern.`,
      ``,
      `### Context & analysis tools`,
      `- **codebase_overview(aspects?)** — Indexed repo overview: module map, key symbols, entry points, routes. Use first on unfamiliar/large codebases to orient yourself.`,
      `- **call_trace(function_name, direction?, depth?)** — Callers (inbound) or callees (outbound) of a symbol. Use after finding a symbol to understand call relationships.`,
      `- **change_impact()** — Map uncommitted git changes to affected symbols; run before declaring done.`,
      ``,
      `### Read & write tools`,
      `- **read_file(path)** — Read file contents. Also supports read_file(qualified_name="...") to read just one function body by its graph-indexed qualified name (much cheaper than the whole file — use when search results give you a qualified_name). Use BEFORE editing.`,
    );
  } else {
    lines.push(
      `- **read_file(path)** — Read file contents. Use BEFORE editing to understand context.`,
    );
  }

  lines.push(
    `- **write_file(path, content)** — Create or completely overwrite a file.`,
    `- **edit_file(path, old_string, new_string, replace_all?)** — Replace a string in a file. old_string MUST match exactly (including whitespace/indentation). Include enough surrounding lines to ensure a unique match — or pass replace_all=true for renames.`,
    `- **multi_edit(path, edits[])** — Apply several sequential string replacements to one file atomically. Prefer this over multiple edit_file calls when making related changes to the same file.`,
    `- **apply_patch(patch, check_only?)** — Apply a unified diff via \`git apply\`. Use for multi-file changes. Pass check_only=true to dry-run.`,
    `- **bash(command)** — Execute a command in a persistent shell. State (cwd, env vars) persists between calls. Use cd to change directories.`,
  );

  if (!ctx.codeGraphEnabled) {
    lines.push(
      `- **glob_search(pattern)** — Find files matching a glob pattern.`,
      `- **grep_search(pattern, path?)** — Search file contents with regex.`,
      `- **list_directory(path)** — List directory contents.`,
    );
  }

  lines.push(
    `- **todo_write(todos[])** — Maintain a working todo list for the user. Use for tasks with 3+ steps. Pass the full list each call; mark at most one item in_progress at a time.`,
  );

  return `## Available Tools\n\n${lines.join("\n")}`;
}

function buildCodeGraphRoutingSection(): string {
  return `## Search tool routing

The codebase is indexed. You have **3 orthogonal search tools** — each answers a different kind of question. Pick the right one; don't try multiple.

| What you're looking for | Tool |
|---|---|
| **Symbols** (functions, classes, methods, variables) by name or natural language | **symbol_search**(name_pattern=..., file_pattern=...) |
| **Text** in code (string literals, routes, config, error messages, regex patterns) | **text_search**(query=..., file_pattern=...) |
| **Files** by path pattern | **glob_search**(pattern=...) |

Both search tools have built-in auto-recovery — no need to manually retry or switch tools:
- **symbol_search**: structural name regex + auto BM25 fallback for natural language
- **text_search**: literal text + auto grep fallback for regex, auto-broadens when file_pattern is too narrow

### Typical workflow

1. **Orient** — codebase_overview → get the module map
2. **Search** — pick ONE search tool, scope with file_pattern from the module map
3. **Read** — read_file(qualified_name=...) for a specific function, or read_file(path=...) for the full file before editing
4. **Act** — edit, then call_trace / change_impact for completeness

### Quick-reference for non-search tools

| Goal | Tool |
|---|---|
| Repo module map (orientation) | **codebase_overview** |
| Read a function by qualified_name | **read_file**(qualified_name=...) — from search results |
| Read full file for editing | **read_file**(path=...) |
| Who calls this / what does it call | **call_trace** |
| Blast radius of uncommitted changes | **change_impact** |

### Example trajectory

User asks: "下载模板的逻辑在哪里?"

Turn 1: symbol_search(name_pattern="download template xlsx")
→ [BM25 fallback] Result: utils/downloadFile.js:18: downloadTemplate [project.utils.downloadFile.downloadTemplate]

Turn 2: read_file(qualified_name="project.utils.downloadFile.downloadTemplate")
→ 18| export function downloadTemplate(baseUrl, fileName) { ... }

Turn 3: Answer. DONE. 2 tool calls.

Key points:
- symbol_search found the function via BM25 even for Chinese "下载模板"
- read_file(qualified_name=...) reads just the function body — no need to read the full file
- Do NOT continue searching after getting the implementation. Do NOT re-verify with a different search tool.
- 2-3 tool calls is ideal for a question. Past 5 = over-exploring.

**Stopping rules:**
- For questions: answer as soon as you have the implementation. Do NOT trace callers unless asked.
- For edits: read_file(path=...) the full file before editing. Use trace/impact for completeness.
- If you found the answer, STOP. Do not re-search with a different tool.

**Tool call budget for questions: 5 calls max.**
- After read_file(qualified_name=...) gives you the answer, STOP and respond.
- Call read_file(qualified_name=...) ALONE — not in parallel with other searches.
- Every read_file(path=...) on a 500+ line file costs ~5x more than read_file(qualified_name=...). Prefer qualified_name.`;
}

function buildRulesSection(ctx: PromptContext): string {
  const structuralRule = ctx.codeGraphEnabled
    ? "5. **Structural completeness** — After editing one method, use symbol_search or call_trace to check paired/symmetric methods in the same class (transform/inverse_transform, serialize/deserialize) and apply the same fix where needed.\n6. **Finish with impact** — Before declaring done, run change_impact once when you have uncommitted source changes.\n"
    : "";
  const stopNum = ctx.codeGraphEnabled ? 7 : 5;
  const pathNum = ctx.codeGraphEnabled ? 8 : 6;

  return `## Critical Rules

1. **ALWAYS use tools** — Never assume or fabricate file contents. If you need to know something, use a tool.
2. **Read before edit** — Always read_file before edit_file to get exact current content.
3. **Precise edits** — For edit_file, copy the EXACT text from read_file output (including indentation). The old_string must be unique in the file.
4. **Verify after edit** — Run related tests or typechecks after changes. If tests fail, fix your source code — never modify existing test assertions or expected values to make them pass. You may add new test functions if useful, but never alter or delete existing ones.
4b. **Trace before fix** — When fixing a failing test or bug, trace the test's call chain (call_trace if available, otherwise read the test and follow the imports) to understand what the test asserts before writing any fix. This prevents fixing the wrong location or over-fixing.
4c. **Never modify vendored/third-party code** — Directories like \`vendor/\`, \`vendored/\`, \`third_party/\`, \`_vendor/\`, or bundled dependency packages must not be edited. Fix at the project's own source layer.
${structuralRule}${stopNum}. **Stop when done** — Once the task is accomplished and verified, provide a brief summary and stop. For questions: answer as soon as you have sufficient evidence. Do not keep searching "just to be sure."
${pathNum}. **Relative paths** — Always use paths relative to the workspace root.`;
}

function buildWorkflowSection(ctx: PromptContext): string {
  const graphLocate = ctx.codeGraphEnabled
    ? "Use symbol_search (or codebase_overview if the repo layout is unclear), then read_file paths from results. "
    : "";
  const graphFinish = ctx.codeGraphEnabled
    ? " Before stopping, run change_impact if you changed source files.\n"
    : "";

  switch (ctx.taskHint) {
    case "debug":
      return `## Workflow (Debugging)

1. Read the failing test or error message to understand symptoms
2. Orient — codebase_overview to identify which module is involved
3. Trace the code path — symbol_search(file_pattern="<module>") to find the symbol, then call_trace for call chains; text_search scoped to the module for error strings
4. Fix the root cause (not the symptom)
5. Run the test/command to verify the fix
6. Report what you found and fixed${graphFinish}`;

    case "implement":
      return `## Workflow (Implementation)

1. codebase_overview to get the module map, then identify the target module
2. symbol_search(file_pattern="<module>") to find existing patterns and interfaces in the module
3. Read the relevant files to understand conventions
4. Implement the feature following existing patterns
5. Run tests if they exist to verify
6. Report what you implemented${graphFinish}`;

    case "refactor":
      return `## Workflow (Refactoring)

1. Read the current code and understand its full API surface
2. Identify all callers — ${ctx.codeGraphEnabled ? "call_trace (inbound) and " : ""}imports that depend on it
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
1. **Orient** — codebase_overview to get the module map
2. **Narrow** — from the module map, identify the relevant module. Use symbol_search(file_pattern="<module>", name_pattern="<keyword>") or text_search(query="<text>", file_pattern="<module>") to find symbols
3. **Read** — read_file the target files before any edit
4. **Edit** — make changes (edit_file or write_file)
5. **Check related** — symbol_search/call_trace for symmetric or related symbols; fix those too
6. **Verify** — run related tests or typechecks — fix failures in source, not existing tests
7. **Impact** — change_impact, then stop — report what you did

Key: steps 1→2 must be connected. Extract the module path from step 1 and use it to scope step 2. Never broad-grep the entire repo when you know the module.`
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
