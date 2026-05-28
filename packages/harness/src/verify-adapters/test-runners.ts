/**
 * Per-repo test runner adapters for the SWE-bench Verify hook.
 *
 * Each entry maps a GitHub `owner/repo` → a `TestRunner` that knows:
 *   - how to BUILD the shell command to run a given list of test targets
 *   - how to PARSE the resulting stdout/stderr into a structured verdict
 *
 * Rationale (vs. just running `pytest <paths>`):
 *   - Django uses its own runtests.py harness (NOT pytest); pytest will
 *     collect zero items and exit 5 ("no tests ran") which we'd misread as
 *     a pass. Django needs explicit handling.
 *   - Other SWE-bench repos (sympy, astropy, sklearn, etc.) all support
 *     pytest cleanly. We default to pytest with conservative flags.
 *
 * Output parsing is intentionally lenient: we look for clear failure
 * markers ("FAILED", "ERROR ", "X failed") and otherwise trust the exit
 * code. We never trust the LLM's claim of "tests pass" — only the runner's
 * exit code. That's the entire point of the gate.
 *
 * Generality: this file is benchmark-specific (the runner registry knows
 * about Django et al.). For real-world projects, a different adapter would
 * read `.forgelet/verify.json` or `package.json#scripts.verify`.
 */
import type {
  ExecResult,
  VerifyCommand,
  VerifyResult,
} from "../verify.js";
import { extractFailureExcerpt, truncateTail } from "../verify.js";

/**
 * A test target the runner should execute. Adapters produce these from
 * `git diff` heuristics; the runner converts each one into the runner-
 * specific invocation form (Django dotted module path vs. pytest file path).
 */
export interface TestTarget {
  /**
   * For `kind:"file"`: a path relative to `testbedDir` (e.g. "tests/admin_views/test_actions.py").
   * For `kind:"node"`: a fully qualified test node (e.g. "tests/foo.py::TestClass::test_x").
   * Adapters that don't pinpoint a single test should emit `file` targets.
   */
  spec: string;
  kind: "file" | "node";
  /**
   * Optional reason / provenance for telemetry (e.g. "modified file → sibling test").
   * Not used by runners themselves.
   */
  reason?: string;
}

export interface BuildOpts {
  testbedDir: string;
  targets: TestTarget[];
  /** Python executable. Defaults to `python` (already on PATH inside SWE-bench containers). */
  pythonBin?: string;
  /** Per-runner soft cap on test selection to keep wall clock predictable. */
  maxTargets?: number;
}

export interface TestRunner {
  /** Unique identifier for telemetry: "django-runtests", "pytest", etc. */
  id: string;
  /**
   * Build the shell command. Returns undefined when the runner has nothing
   * to run (e.g. no resolvable targets) — verify.ts treats that as "skipped".
   */
  build(opts: BuildOpts): VerifyCommand | undefined;
  parse(opts: BuildOpts, result: ExecResult): VerifyResult;
}

const DEFAULT_MAX_TARGETS = 8;

/**
 * Resolve a repo identifier ("django/django") to its preferred runner.
 * Unknown repos fall through to pytest.
 */
export function getTestRunner(repo: string): TestRunner {
  const key = repo.toLowerCase();
  if (key === "django/django") return DJANGO_RUNTESTS;
  // sympy, sklearn, astropy, sphinx, pytest, flask, requests, xarray, seaborn,
  // matplotlib, pylint, mwaskom/seaborn → all pytest-compatible.
  return PYTEST_RUNNER;
}

// ────────────────────────────────────────────────────────────────────
// Django: python tests/runtests.py <dotted.module>...
// ────────────────────────────────────────────────────────────────────

const DJANGO_RUNTESTS: TestRunner = {
  id: "django-runtests",
  build({ testbedDir, targets, pythonBin = "python", maxTargets = DEFAULT_MAX_TARGETS }) {
    const dotted = targets
      .map((t) => fileToDjangoModule(t.spec))
      .filter((m): m is string => m !== null);
    if (dotted.length === 0) return undefined;
    const unique = Array.from(new Set(dotted)).slice(0, maxTargets);

    return {
      argv: [
        pythonBin,
        "tests/runtests.py",
        "--verbosity=1",
        "--noinput",
        // --parallel=1 keeps output deterministic and avoids tearing
        // tracebacks across workers, which makes the failure excerpt useless.
        "--parallel=1",
        ...unique,
      ],
      cwd: testbedDir,
      env: {
        // Django's runtests.py imports test settings; PYTHONHASHSEED stabilizes
        // any incidentally-iterated dicts in tracebacks so repeated runs match.
        PYTHONHASHSEED: "0",
      },
    };
  },
  parse(_opts, result) {
    const out = `${result.stdout}\n${result.stderr}`;

    // Treat any of these as failure regardless of exit code, because Django's
    // runtests.py occasionally exits 0 after printing a deprecation traceback
    // (rare but happens with --keepdb and missing fixtures).
    const hasFailureMarker =
      /FAILED \(/.test(out) ||
      /\nERROR: /.test(out) ||
      /Traceback \(most recent call last\)/.test(out);

    const passed = result.exitCode === 0 && !hasFailureMarker;
    if (passed) {
      const ranMatch = out.match(/Ran (\d+) tests? in [\d.]+s/);
      const count = ranMatch ? ranMatch[1] : "?";
      return {
        verdict: "pass",
        feedback: `django runtests: ${count} tests passed (${result.durationMs}ms)`,
      };
    }

    const excerpt = extractFailureExcerpt(
      out,
      [/^FAIL: /m, /^ERROR: /m, /FAILED \(/m, /Traceback /m],
      6,
      2800,
    );

    return {
      verdict: "fail",
      feedback: [
        `django runtests: exit ${result.exitCode}${result.timedOut ? " (TIMED OUT)" : ""}`,
        excerpt,
      ].join("\n"),
    };
  },
};

/**
 * Convert a path like `tests/admin_views/test_actions.py` →
 * `admin_views.test_actions` (Django runtests dotted module syntax).
 *
 * Also handles directory paths (with or without trailing slash):
 *   `tests/admin_views/` → `admin_views`  (runs the whole test app)
 *
 * Returns null for paths Django runtests can't address (paths outside
 * tests/, __init__.py, etc.). Callers should filter those out.
 */
export function fileToDjangoModule(filePath: string): string | null {
  if (filePath.endsWith("__init__.py")) return null;
  // Normalize trailing slash so directory targets parse the same way.
  const trimmed = filePath.replace(/\/+$/, "");

  // tests/foo/bar.py → foo.bar     OR     tests/foo → foo
  const m = trimmed.match(/^tests\/(.+?)(\.py)?$/);
  if (m) return m[1].replace(/\//g, ".");

  return null;
}

// ────────────────────────────────────────────────────────────────────
// Pytest (default for sympy, sklearn, sphinx, astropy, matplotlib, ...)
// ────────────────────────────────────────────────────────────────────

const PYTEST_RUNNER: TestRunner = {
  id: "pytest",
  build({ testbedDir, targets, pythonBin = "python", maxTargets = DEFAULT_MAX_TARGETS }) {
    // Defensive filter: pytest will happily recurse a directory and run
    // thousands of tests. The changed-files adapter currently only emits
    // directory targets for Django, but harden against future bugs.
    // Accept `path.py`, `path.py::TestClass`, and `path.py::TestClass::test_x`
    // but reject directory-style targets ending in `/`.
    const safe = targets.filter((t) => !t.spec.endsWith("/") && /\.py(::|$)/.test(t.spec));
    if (safe.length === 0) return undefined;
    const specs = Array.from(new Set(safe.map((t) => t.spec))).slice(0, maxTargets);

    return {
      argv: [
        pythonBin,
        "-m",
        "pytest",
        // No cache → no permission writes to ~/.pytest_cache (the container
        // testbed user often can't write there).
        "-p",
        "no:cacheprovider",
        // Short traceback keeps the feedback budget tight; the agent doesn't
        // need full pretty tracebacks to identify the failing assertion.
        "--tb=short",
        // Stop after the 10th failure — past that the agent is rarely able
        // to address them all in one revision pass anyway.
        "--maxfail=10",
        // Suppress noisy plugin headers / collection chatter.
        "-q",
        "--no-header",
        ...specs,
      ],
      cwd: testbedDir,
      env: {
        PYTHONHASHSEED: "0",
        // Some SWE-bench testbeds set FAIL_ON_WARNINGS or PYTHONWARNINGS to
        // error mode, which makes deprecation-clean repos suddenly fail
        // verify on unrelated warnings. Force-default to a sane setting; the
        // agent's real test run on FAIL_TO_PASS will use the official config.
        PYTHONWARNINGS: "default",
      },
    };
  },
  parse(_opts, result) {
    const out = `${result.stdout}\n${result.stderr}`;

    // pytest exit codes:
    //   0 = all tests passed
    //   1 = some tests failed
    //   2 = test execution interrupted (CTRL-C / SIGTERM)
    //   3 = internal error in pytest
    //   4 = pytest CLI usage error (bad flag / bad path)
    //   5 = no tests collected
    //
    // 5 is the dangerous one: "no tests collected" can mean the agent
    // broke `__init__.py` and pytest silently skipped everything. We treat
    // 5 as FAIL — better to surface "nothing ran" to the agent than to
    // silently green-light a regression. The parser logs the explanation
    // so the agent can react.
    if (result.exitCode === 0) {
      const passMatch = out.match(/(\d+)\s+passed/);
      const count = passMatch ? passMatch[1] : "?";
      return {
        verdict: "pass",
        feedback: `pytest: ${count} passed (${result.durationMs}ms)`,
      };
    }

    if (result.exitCode === 5) {
      return {
        verdict: "fail",
        feedback: [
          `pytest: no tests collected (exit 5).`,
          `This usually means a broken import / __init__.py in the target paths,`,
          `or the test selection didn't match any test (paths/IDs wrong).`,
          ``,
          truncateTail(out, 1500),
        ].join("\n"),
      };
    }

    const excerpt = extractFailureExcerpt(
      out,
      [
        /^FAILED /m,
        /^ERROR /m,
        // pytest summary line: "===== short test summary info ====="
        /^=+ short test summary/m,
        /Traceback /m,
      ],
      4,
      2800,
    );

    return {
      verdict: "fail",
      feedback: [
        `pytest: exit ${result.exitCode}${result.timedOut ? " (TIMED OUT)" : ""}`,
        excerpt,
      ].join("\n"),
    };
  },
};

export const TEST_RUNNERS = {
  django: DJANGO_RUNTESTS,
  pytest: PYTEST_RUNNER,
};
