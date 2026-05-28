/**
 * "Run the tests that look related to what you changed" — the heart of the
 * generic verify hook for SWE-bench.
 *
 * Pipeline (all heuristic, no benchmark-specific oracle):
 *   1. `git diff --name-only HEAD` → list of files the agent modified
 *   2. Partition: test files vs. source files
 *   3. For each modified source file, infer candidate test paths (siblings,
 *      `tests/test_*.py`, Django app `tests/<app>/`)
 *   4. Keep only candidates that exist on disk
 *   5. Deduplicate & cap the result so wall clock stays bounded
 *
 * Generality: this file knows nothing about FAIL_TO_PASS, instance_id,
 * or any benchmark oracle. It only looks at the file tree + git diff. The
 * same heuristic works on any Python project, and a similar one would work
 * for TS/Java/Go.
 *
 * Limits intentionally:
 *   - No AST parsing (cheap and good enough — full coverage analysis would
 *     belong in a separate adapter)
 *   - Doesn't follow imports (a future "import-graph" adapter could)
 *   - Doesn't run untouched test files (won't catch tests broken by your
 *     refactor in unrelated modules — that's what CI is for after merge)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";
import { constants as fsConst } from "node:fs";
import type { TestTarget } from "./test-runners.js";

const execFileAsync = promisify(execFile);

const TEST_FILE_RE = /(^|\/)tests?\//;
const TEST_FILENAME_RE = /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.py$/;

export interface InferOpts {
  /** Absolute path to the testbed (= the repo root). */
  workspaceRoot: string;
  /** GitHub repo identifier "owner/name", used to pick repo-specific shortcuts. */
  repo: string;
  /**
   * git ref to diff against. Defaults to HEAD. For SWE-bench the worktree
   * starts at base_commit and the agent commits nothing, so HEAD = base.
   * Pass "HEAD~1" or a commit SHA for other workflows.
   */
  baseRef?: string;
  /** Soft cap on the number of returned targets. Default 8. */
  maxTargets?: number;
}

export interface InferResult {
  targets: TestTarget[];
  /** Files git reported as changed (paths relative to workspaceRoot). */
  changedFiles: string[];
  /** Subset of changedFiles that are themselves test files. */
  changedTestFiles: string[];
  /** Subset of changedFiles that are source (non-test) files. */
  changedSourceFiles: string[];
  /** True when git diff returned 0 changes — nothing to verify. */
  noChanges: boolean;
}

/**
 * Run `git diff --name-only` and infer test targets.
 *
 * Returns an empty target list (with noChanges=true) when the agent has
 * made no edits yet. The caller's verify hook treats that as "skipped"
 * (no budget burned).
 *
 * Failure modes return empty target lists rather than throwing, because
 * the verify hook should fail-safe (run nothing) when git is misbehaving.
 */
export async function inferTestTargetsFromDiff(opts: InferOpts): Promise<InferResult> {
  const { workspaceRoot, repo } = opts;
  const baseRef = opts.baseRef ?? "HEAD";
  const maxTargets = opts.maxTargets ?? 8;

  const changedFiles = await gitChangedFiles(workspaceRoot, baseRef);
  if (changedFiles.length === 0) {
    return {
      targets: [],
      changedFiles: [],
      changedTestFiles: [],
      changedSourceFiles: [],
      noChanges: true,
    };
  }

  const changedTestFiles = changedFiles.filter(isTestFile);
  const changedSourceFiles = changedFiles.filter((f) => !isTestFile(f) && f.endsWith(".py"));

  const candidates: TestTarget[] = [];

  // Directly modified test files are always good candidates — running them
  // proves your test-only changes still pass.
  for (const f of changedTestFiles) {
    candidates.push({ spec: f, kind: "file", reason: "modified test file" });
  }

  // For each modified source file, look for related test files.
  for (const src of changedSourceFiles) {
    for (const candidate of inferTestPathsForSource(src, repo)) {
      candidates.push({
        spec: candidate,
        kind: "file",
        reason: `sibling test for ${src}`,
      });
    }
  }

  // Filter to existing files on disk; dedup; cap.
  const seen = new Set<string>();
  const existing: TestTarget[] = [];
  for (const c of candidates) {
    if (seen.has(c.spec)) continue;
    seen.add(c.spec);
    const abs = path.join(workspaceRoot, c.spec);
    try {
      await access(abs, fsConst.R_OK);
      existing.push(c);
      if (existing.length >= maxTargets) break;
    } catch {
      // Candidate file doesn't exist — silently drop. This is expected
      // for most heuristic guesses; we collect many and keep what's real.
    }
  }

  return {
    targets: existing,
    changedFiles,
    changedTestFiles,
    changedSourceFiles,
    noChanges: false,
  };
}

async function gitChangedFiles(cwd: string, baseRef: string): Promise<string[]> {
  // We want files that have changed RELATIVE to baseRef — covers both
  // working-tree modifications and committed changes. `git diff <ref>`
  // (no `..`) compares working tree to ref. That's what we want.
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", baseRef],
      { cwd, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

export function isTestFile(filePath: string): boolean {
  if (!filePath.endsWith(".py")) return false;
  if (TEST_FILENAME_RE.test(filePath)) return true;
  if (TEST_FILE_RE.test(filePath)) return true;
  return false;
}

/**
 * Given a source file path, propose candidate test file paths.
 *
 * Strategies tried (in order, all paths returned):
 *   1. Sibling test: `foo/bar.py` → `foo/test_bar.py` and `foo/bar_test.py`
 *   2. Sibling-under-tests: `foo/bar.py` → `foo/tests/test_bar.py`
 *   3. Top-level tests dir: `foo/bar.py` → `tests/test_bar.py` and `tests/foo/test_bar.py`
 *   4. Repo-specific:
 *      - Django (`django/django`): `django/contrib/<app>/...` → look under
 *        `tests/<short_app_name>/` since Django splits sources & tests this way
 *
 * Returns paths to TRY. The caller filters by existence-on-disk.
 */
export function inferTestPathsForSource(srcPath: string, repo: string): string[] {
  if (!srcPath.endsWith(".py")) return [];
  if (srcPath.endsWith("__init__.py")) {
    // Modifying __init__.py is hard to localize — try the package's test dir.
    return djangoCandidates(srcPath, repo);
  }

  const dir = path.dirname(srcPath);
  const baseNoExt = path.basename(srcPath, ".py");
  const candidates: string[] = [];

  // 1. Sibling tests
  candidates.push(path.join(dir, `test_${baseNoExt}.py`));
  candidates.push(path.join(dir, `${baseNoExt}_test.py`));

  // 2. Sibling under "tests/"
  candidates.push(path.join(dir, "tests", `test_${baseNoExt}.py`));
  candidates.push(path.join(dir, "tests", `${baseNoExt}_test.py`));

  // 3. Top-level tests directory variants
  candidates.push(path.join("tests", `test_${baseNoExt}.py`));
  // Mirror source structure under tests/: src/foo/bar.py → tests/foo/test_bar.py
  const segments = srcPath.split(path.sep).filter((s) => s !== "src");
  if (segments.length > 1) {
    const mirroredDir = path.join("tests", ...segments.slice(0, -1));
    candidates.push(path.join(mirroredDir, `test_${baseNoExt}.py`));
  }

  // 4. Repo-specific
  candidates.push(...djangoCandidates(srcPath, repo));

  return candidates;
}

/**
 * Django-specific candidates. Django's source/test layout is unusual:
 *   sources live under   django/<area>/<...>.py
 *   tests live under     tests/<test_app>/...   ← test_app != area
 *
 * Django's `tests/` directory is a flat list of ~250 test apps (admin_views,
 * model_fields, queries, migrations, forms_tests, ...). Their names don't
 * mechanically derive from source paths. We hand-curate the high-yield
 * mappings — this list covers >80% of common SWE-bench Lite Django patches.
 *
 * For source paths not in the table, we fall back to the "area name" guess
 * (e.g. django/contrib/admin/ → tests/admin/), which usually misses but is
 * filtered out by the existence-on-disk check so it costs nothing.
 */
function djangoCandidates(srcPath: string, repo: string): string[] {
  if (repo.toLowerCase() !== "django/django") return [];

  const out = new Set<string>();
  for (const dir of DJANGO_TEST_APPS_BY_SOURCE_PREFIX) {
    if (srcPath.startsWith(dir.prefix)) {
      for (const app of dir.testApps) out.add(`tests/${app}/`);
    }
  }

  const segments = srcPath.split("/");
  if (segments[0] === "django" && segments.length >= 3) {
    const area = segments[1] === "contrib" ? segments[2] : segments[1];
    out.add(`tests/${area}/`);
    out.add(`tests/${area}_tests/`);
  }

  return Array.from(out);
}

/**
 * Curated map of Django source path prefixes to their test apps.
 * Order matters: more-specific prefixes come first so they win the match
 * (e.g. `django/db/models/fields/` before `django/db/models/`).
 *
 * Sources: SWE-bench Lite analysis of which test apps cover each module,
 * cross-referenced with Django's own contributing docs.
 *
 * When in doubt, prefer including MORE test apps — the existence check
 * drops the wrong ones at zero cost, and the agent benefits from any
 * extra failing-test signal we surface.
 */
const DJANGO_TEST_APPS_BY_SOURCE_PREFIX: Array<{ prefix: string; testApps: string[] }> = [
  // Model fields: changes here usually break tests/model_fields/ + adjacent
  { prefix: "django/db/models/fields/", testApps: ["model_fields", "validation"] },
  // Query / queryset / manager
  { prefix: "django/db/models/sql/", testApps: ["queries", "lookup", "expressions"] },
  { prefix: "django/db/models/manager", testApps: ["managers_regress", "custom_managers"] },
  { prefix: "django/db/models/query", testApps: ["queries", "queryset_pickle", "lookup"] },
  { prefix: "django/db/models/expressions", testApps: ["expressions", "expressions_case", "expressions_window"] },
  { prefix: "django/db/models/aggregates", testApps: ["aggregation", "aggregation_regress"] },
  { prefix: "django/db/models/functions/", testApps: ["db_functions"] },
  { prefix: "django/db/models/", testApps: ["model_meta", "model_options", "model_inheritance", "basic"] },
  // Migrations
  { prefix: "django/db/migrations/", testApps: ["migrations", "migrate_signals"] },
  { prefix: "django/db/backends/", testApps: ["backends", "schema", "introspection"] },
  // Forms
  { prefix: "django/forms/", testApps: ["forms_tests", "model_forms"] },
  // Template engine
  { prefix: "django/template/", testApps: ["template_tests", "template_backends"] },
  { prefix: "django/templatetags/", testApps: ["template_tests"] },
  // URL routing
  { prefix: "django/urls/", testApps: ["urlpatterns", "urlpatterns_reverse"] },
  // HTTP
  { prefix: "django/http/", testApps: ["httpwrappers", "requests", "responses"] },
  { prefix: "django/middleware/", testApps: ["middleware", "middleware_exceptions"] },
  // Views
  { prefix: "django/views/generic/", testApps: ["generic_views"] },
  { prefix: "django/views/", testApps: ["view_tests"] },
  // Contrib apps
  { prefix: "django/contrib/admin/", testApps: ["admin_views", "admin_inlines", "admin_widgets", "admin_filters", "admin_changelist", "admin_utils", "modeladmin"] },
  { prefix: "django/contrib/auth/", testApps: ["auth_tests"] },
  { prefix: "django/contrib/contenttypes/", testApps: ["contenttypes_tests"] },
  { prefix: "django/contrib/sessions/", testApps: ["sessions_tests"] },
  { prefix: "django/contrib/postgres/", testApps: ["postgres_tests"] },
  { prefix: "django/contrib/messages/", testApps: ["messages_tests"] },
  { prefix: "django/contrib/sites/", testApps: ["sites_tests"] },
  { prefix: "django/contrib/staticfiles/", testApps: ["staticfiles_tests"] },
  { prefix: "django/contrib/gis/", testApps: ["gis_tests"] },
  { prefix: "django/contrib/syndication/", testApps: ["syndication_tests"] },
  { prefix: "django/contrib/sitemaps/", testApps: ["sitemaps_tests"] },
  // Core utilities
  { prefix: "django/utils/", testApps: ["utils_tests"] },
  { prefix: "django/core/management/commands/", testApps: ["admin_scripts", "user_commands"] },
  { prefix: "django/core/management/", testApps: ["admin_scripts", "user_commands", "migrations"] },
  { prefix: "django/core/cache/", testApps: ["cache"] },
  { prefix: "django/core/files/", testApps: ["files"] },
  { prefix: "django/core/serializers/", testApps: ["serializers"] },
  { prefix: "django/core/", testApps: ["core_tests"] },
  // Conf / settings
  { prefix: "django/conf/", testApps: ["settings_tests"] },
  // Test framework
  { prefix: "django/test/", testApps: ["test_client", "test_runner", "test_utils"] },
];
