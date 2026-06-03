import type { SweBenchInstance } from "./types.js";

export function buildSweBenchPrompt(instance: SweBenchInstance): string {
  const hints =
    instance.hints_text && instance.hints_text.trim()
      ? `\n\n## Hints from issue discussion\n\n${instance.hints_text.trim()}`
      : "";

  return `You are fixing a real open-source repository bug. The codebase is checked out at the commit before the fix was merged.

## Issue

${instance.problem_statement.trim()}${hints}

## Your task

1. Understand the issue and locate the relevant code. When code graph tools are available: use **code_graph_search** for symbols (classes/functions/methods), **code_graph_trace** for call chains, **grep_search** only for error strings or non-symbol text — then **read_file** before editing.
2. Before writing any fix, use **code_graph_trace** to trace the failing test's call chain into source code so you understand exactly what behavior the test asserts. This prevents fixing the wrong location or over-fixing.
3. Implement a minimal fix in **source files only** — do not modify test files unless the issue explicitly requires it. Never modify vendored or third-party code (directories like \`vendor/\`, \`vendored/\`, \`packages/urllib3/\`, \`third_party/\`, \`_vendor/\`); fix at the project's own layer.
4. After editing one method, use **code_graph_search** or **code_graph_trace** to find paired/symmetric methods in the same class and apply the same fix if needed.
5. Run the related tests to confirm the fix works and doesn't break other tests. If tests fail, fix your code — never modify existing test assertions or expected values to make them pass.
6. Before stopping, run **code_graph_impact** if you have uncommitted source changes. When tests pass, stop — do not add unrelated changes or documentation.

Repository: \`${instance.repo}\`
Instance: \`${instance.instance_id}\``;
}
