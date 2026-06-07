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
  const lines = [
    `- **read_file(path)** — Read file contents. Use BEFORE editing to understand context.`,
    `- **write_file(path, content)** — Create or completely overwrite a file.`,
    `- **edit_file(path, old_string, new_string, replace_all?)** — Replace a string in a file. old_string MUST match exactly (including whitespace/indentation). Include enough surrounding lines to ensure a unique match — or pass replace_all=true for renames.`,
    `- **multi_edit(path, edits[])** — Apply several sequential string replacements to one file atomically. Prefer this over multiple edit_file calls when making related changes to the same file.`,
    `- **apply_patch(patch, check_only?)** — Apply a unified diff via \`git apply\`. Use for multi-file changes. Pass check_only=true to dry-run.`,
    `- **bash(command)** — Execute a command in a persistent shell. State (cwd, env vars) persists between calls. Use cd to change directories.`,
    `- **glob_search(pattern)** — Find files matching a glob pattern.`,
  ];

  if (!ctx.codeGraphEnabled) {
    lines.push(`- **grep_search(pattern, path?)** — Search file contents with regex.`);
    lines.push(`- **list_directory(path)** — List directory contents.`);
  }

  lines.push(
    `- **todo_write(todos[])** — Maintain a working todo list for the user. Use for tasks with 3+ steps. Pass the full list each call; mark at most one item in_progress at a time.`,
  );

  if (ctx.codeGraphEnabled) {
    lines.push(
      `- **code_graph_architecture(aspects?)** — Indexed repo overview: module map, key symbols, entry points, routes. Use first on unfamiliar/large codebases.`,
      `- **code_graph_semantic_search(query)** — BM25 natural-language search over indexed symbols. BEST when you don't know exact names. E.g. "download template xlsx purchase order".`,
      `- **code_graph_code_search(query, file_pattern?)** — Graph-augmented text search (like grep but with graph context). For route paths, config values, string literals.`,
      `- **code_graph_search(name_pattern?, label?, file_pattern?)** — Structural search by symbol name regex + file scope.`,
      `- **code_graph_snippet(qualified_name)** — Read a specific function's source code by qualified name. Much cheaper than read_file for the whole file.`,
      `- **code_graph_trace(function_name, direction?, depth?)** — Callers (inbound) or callees (outbound) of a symbol.`,
      `- **code_graph_impact()** — Map uncommitted git changes to affected symbols; run before declaring done.`,
    );
  }

  return `## Available Tools\n\n${lines.join("\n")}`;
}

function buildCodeGraphRoutingSection(): string {
  return `## Tool routing (code graph vs text tools)

The codebase is indexed with semantic search, code search, and structural graph. **Prefer graph tools over grep** — they are faster, more precise, and context-aware.

**Step 1 — Orient:** code_graph_architecture to get the module map.
**Step 2 — Find:** Use the RIGHT search tool for the task:
  - User describes functionality in natural language? → **code_graph_semantic_search** (best first choice)
  - Looking for a string/route/config in code? → **code_graph_code_search** (graph-augmented grep)
  - Know the symbol name? → **code_graph_search** (structural, by name regex)
**Step 2b — If search returns empty:** broaden the query or try a different search tool. Do NOT fall back to listing directories level by level.
**Step 3 — Read:** Use **code_graph_snippet**(qualified_name) to read a specific function. Only use read_file when you need the full file (e.g. for editing).

| Goal | Tool |
|------|------|
| Get module map of the repo | **code_graph_architecture** |
| Find code by natural language description | **code_graph_semantic_search**(query="...") — best for "下载模板", "状态机", etc. |
| Find route paths, strings, config values in code | **code_graph_code_search**(query="/purchase/order") |
| Find symbols by name pattern | **code_graph_search**(file_pattern="module", name_pattern="keyword") |
| Read a specific function's source | **code_graph_snippet**(qualified_name) — from search results |
| Who calls this / what does it call | **code_graph_trace** |
| Find files by path pattern | **glob_search** |
| Full file contents for editing | **read_file** (required before edit_file) |
| Before stopping — blast radius check | **code_graph_trace** then **code_graph_impact** |

Important:
- **code_graph_semantic_search** is the preferred first step when you don't know exact symbol names — it understands natural language.
- **code_graph_code_search** replaces grep_search — it only searches indexed files and returns graph context.
- **code_graph_snippet** reads just one function body — much cheaper than read_file on a 500+ line file.
- To trace who calls a function: **code_graph_trace**(function_name, direction="inbound") — do NOT grep for the function name across the repo.
- Use **read_file** only when you need the full file for editing or when graph tools are unavailable.
- After code_graph_architecture, **extract the relevant module path** and use it to scope subsequent searches.

**Stopping rules — do NOT over-search:**
- For yes/no questions (e.g. "is X configured in frontend?"): once you find the relevant code (function definition + implementation), answer immediately. Do NOT exhaustively trace all callers or read all related files.
- For explanation tasks: once you have enough evidence to explain the mechanism, stop and summarize. You do not need to read every file in the module.
- If you found the answer via semantic_search + snippet, you are DONE. Do not re-verify with grep.

### Example trajectory: answering a question about code

User asks: "下载模板的逻辑在哪里?"

Turn 1: code_graph_semantic_search(query="download template xlsx")
→ Result:
  utils/downloadFile.js:18: downloadTemplate (qualified_name: "project.utils.downloadFile.downloadTemplate")
  views/pr-list.vue:245: handleDownLoadASNTemplate (qualified_name: "project.views.pr-list.handleDownLoadASNTemplate")

Turn 2: code_graph_snippet(qualified_name="project.utils.downloadFile.downloadTemplate")  ← ONLY snippet, no parallel search
→ Result:
  18| export function downloadTemplate(baseUrl, fileName) {
  19|   window.open(baseUrl + fileName);
  20| }

Turn 3: Answer the question. DONE. Total: 2 tool calls.

Key lessons from this example:
- semantic_search found the function even though "下载模板" ≠ "downloadTemplate"
- snippet gave the implementation — no need for read_file on the full 500-line file
- Turn 2 calls ONLY snippet — do NOT send parallel searches alongside snippet
- Do NOT continue searching after you have the snippet. Do NOT verify with grep.
- Do NOT trace callers/callees unless the user asked "who calls this?"
- Do NOT read_file a file you already got via snippet — snippet IS the code.
- 2-3 tool calls is the ideal for a question task. If you are past 5, you are over-exploring.

**Tool call budget for question/explanation tasks:**
- When the user asks a QUESTION (not requesting code changes), your budget is **5 tool calls**.
- **CRITICAL: call snippet ALONE, never in parallel with other searches.** When you call code_graph_snippet, it MUST be the only tool call in that turn. Read the snippet result first, then decide if you need more. If you send snippet + search in parallel, you will waste the search and get distracted by empty results.
- After getting a snippet that answers the question, STOP and answer. Do not continue to:
  - read_file the same file the snippet came from
  - trace who calls the function (unless asked)
  - search for the route/page that uses the function (unless asked)
  - read large vue/component files to "confirm" what you already know
- Every read_file on a 500+ line file costs the same as ~5 snippets. Prefer snippet.`;
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
4b. **Trace before fix** — When fixing a failing test or bug, trace the test's call chain (code_graph_trace if available, otherwise read the test and follow the imports) to understand what the test asserts before writing any fix. This prevents fixing the wrong location or over-fixing.
4c. **Never modify vendored/third-party code** — Directories like \`vendor/\`, \`vendored/\`, \`third_party/\`, \`_vendor/\`, or bundled dependency packages must not be edited. Fix at the project's own source layer.
${structuralRule}${stopNum}. **Stop when done** — Once the task is accomplished and verified, provide a brief summary and stop. For questions: answer as soon as you have sufficient evidence. Do not keep searching "just to be sure."
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
2. Orient — code_graph_architecture to identify which module is involved
3. Trace the code path — code_graph_search(file_pattern="<module>") to find the symbol, then code_graph_trace for call chains; code_graph_code_search scoped to the module for error strings
4. Fix the root cause (not the symptom)
5. Run the test/command to verify the fix
6. Report what you found and fixed${graphFinish}`;

    case "implement":
      return `## Workflow (Implementation)

1. code_graph_architecture to get the module map, then identify the target module
2. code_graph_search(file_pattern="<module>") to find existing patterns and interfaces in the module
3. Read the relevant files to understand conventions
4. Implement the feature following existing patterns
5. Run tests if they exist to verify
6. Report what you implemented${graphFinish}`;

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
1. **Orient** — code_graph_architecture to get the module map
2. **Narrow** — from the module map, identify the relevant module. Use code_graph_search(file_pattern="<module>", name_pattern="<keyword>") or code_graph_code_search(query="<text>", file_pattern="<module>") to find symbols
3. **Read** — read_file the target files before any edit
4. **Edit** — make changes (edit_file or write_file)
5. **Check related** — code_graph_search/trace for symmetric or related symbols; fix those too
6. **Verify** — run related tests or typechecks — fix failures in source, not existing tests
7. **Impact** — code_graph_impact, then stop — report what you did

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
