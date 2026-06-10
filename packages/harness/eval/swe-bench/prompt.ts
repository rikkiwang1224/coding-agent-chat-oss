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

1. Understand the issue and locate the relevant code. When code graph tools are available: use **symbol_search** for symbols (classes/functions/methods), **text_search** for error strings or non-symbol text, **call_trace** for call chains — then **read_file**(qualified_name=...) to read specific functions, or **read_file**(path=...) for full files before editing.
2. Before writing any fix, use **call_trace** to trace the failing test's call chain into source code so you understand exactly what behavior the test asserts. This prevents fixing the wrong location or over-fixing.
3. Implement a fix in **source files only** — do not modify test files unless the issue explicitly requires it. Never modify vendored or third-party code (directories like \`vendor/\`, \`vendored/\`, \`packages/urllib3/\`, \`third_party/\`, \`_vendor/\`); fix at the project's own layer. Keep the fix minimal, but "minimal" means *no unrelated changes* — it does NOT mean fixing only the single case shown in the issue. Fix the underlying defect for every case it affects.
4. Run the related tests to confirm the fix works and doesn't break other tests. If tests fail, fix your code — never modify existing test assertions or expected values to make them pass.
5. MANDATORY self-review before stopping. Passing the reproduction from the issue is NOT sufficient — the hidden grading tests check cases you have not seen. Even if your tests already pass, you may NOT stop until you have completed every item below:
   a. **SCOPE** — Re-read the issue and list every distinct input, type, or code path the fix must handle (not just the one example). Verify your fix covers all of them; if not, extend it.
   b. **SYMMETRY** — For each method you changed, use **symbol_search** to find its paired/sibling counterparts (e.g. horizontal↔vertical, x↔y, row↔column, get↔set, encode↔decode, add↔remove, __mul__↔__truediv__). Apply the matching change to each, or state explicitly why it is not needed.
   c. **ROOT CAUSE** — Use **call_trace** from the failing behavior to confirm the location you edited is where the defect originates, not a downstream symptom or a fallback/legacy path.
   d. **EXTRA TEST** — Write and run at least one new test beyond the issue's example that exercises an edge case or the symmetric path identified in (a)/(b). If it fails, return to step 3.
6. After completing the self-review and all tests pass, run **change_impact** if you have uncommitted source changes, then stop — do not add unrelated changes or documentation.

Repository: \`${instance.repo}\`
Instance: \`${instance.instance_id}\``;
}
