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

1. Understand the issue and locate the relevant code.
2. Implement a minimal fix in **source files only** — do not modify test files unless the issue explicitly requires it.
3. After making the fix, run the related tests to confirm the fix works and doesn't break other tests. If tests fail, fix your code — never modify existing test assertions or expected values to make them pass.
4. When the fix is verified by passing tests, stop — do not add unrelated changes or documentation.

Repository: \`${instance.repo}\`
Instance: \`${instance.instance_id}\``;
}
