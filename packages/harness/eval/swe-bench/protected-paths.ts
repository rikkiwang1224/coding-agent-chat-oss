/** Path patterns blocked during SWE-bench bug-fix runs (edit/write/apply_patch). */
export const SWE_BENCH_PROTECTED_PATH_PATTERNS = [
  "test_*",
  "*_test.py",
  "tests/",
  "testing/",
] as const;

export function sweBenchProtectedPathPatterns(): string[] {
  return [...SWE_BENCH_PROTECTED_PATH_PATTERNS];
}
