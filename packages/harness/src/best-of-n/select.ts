/**
 * Best-of-N patch selection — the "choose one of N candidate patches" half of
 * Best-of-N sampling.
 *
 * Context: we run the agent N independent times on the same task (with
 * temperature > 0 so the samples diverge) and collect N candidate diffs. This
 * module decides which one to ship. There is NO hidden oracle (we never see the
 * benchmark's FAIL_TO_PASS), so selection uses only signals an engineer could
 * reproduce on any repo:
 *
 *   1. Validity   — drop empty / no-op patches. A run that gave up and changed
 *                   nothing is never the answer when a sibling produced a real
 *                   edit. (This alone rescues the "black-hole / empty-patch"
 *                   failures where 1-of-N actually produced something.)
 *   2. Regression — if the caller ran the inferred related tests for each
 *                   candidate (see verify-adapters), prefer patches that keep
 *                   them green over patches that break them.
 *   3. Majority   — among the survivors, cluster by the *normalized source
 *                   change* and pick the largest cluster. When several samples
 *                   independently converge on the same edit, that edit is far
 *                   more likely correct than a lone outlier (this is Agentless's
 *                   core trick, and it is model-agnostic — not a benchmark hack).
 *
 * This module is intentionally pure (no fs / child_process / network): IO —
 * running the agent, applying patches, executing tests — lives in the caller
 * (eval/swe-bench/select-patch.ts). That keeps the interesting logic unit-
 * testable without a container.
 */

/** Regression-test outcome for a candidate, if the caller measured it. */
export type RegressionStatus = "pass" | "fail" | "unknown";

export interface PatchCandidate {
  /** Stable identifier (e.g. the sample index 1..N). Used for tie-breaking and reporting. */
  index: number;
  /** The candidate's unified diff (`git diff` output). May be empty. */
  diff: string;
  /**
   * Result of running the inferred related/regression tests against this
   * candidate. Omit (or "unknown") when the caller didn't run them — selection
   * then falls back to validity + majority vote only.
   */
  regression?: RegressionStatus;
}

export interface CandidateAnnotation {
  index: number;
  /** Whether the patch makes no source change (empty or test-only / whitespace-only). */
  empty: boolean;
  /** Canonical key of the source change, used for majority clustering. "" when empty. */
  clusterKey: string;
  regression: RegressionStatus;
  /** Number of changed source lines (added + removed), for tie-breaking toward minimal diffs. */
  changeSize: number;
}

export interface ClusterInfo {
  /** The shared normalized key. */
  key: string;
  /** Candidate indices in this cluster. */
  members: number[];
  /** Representative candidate index (the one selected if this cluster wins). */
  representative: number;
}

export interface SelectionResult {
  /**
   * Index of the chosen candidate, or -1 when every candidate was empty (no
   * patch to ship). Callers should treat -1 as "emit an empty prediction".
   */
  selectedIndex: number;
  /** Human-readable explanation (goes into bestofn-report.json + logs). */
  reason: string;
  /** True when no candidate produced a usable (non-empty) source change. */
  allEmpty: boolean;
  /** Regression tier the winner came from ("pass" > "unknown" > "fail"). */
  selectedTier: RegressionStatus;
  /** Per-candidate annotations (for telemetry / debugging the selection). */
  annotations: CandidateAnnotation[];
  /** Clusters within the winning tier, largest first. */
  clusters: ClusterInfo[];
}

export interface SelectOptions {
  /**
   * Treat changes to files matching this predicate as "not part of the fix"
   * for clustering purposes. Defaults to test-file detection so that two
   * samples with the same source fix but different agent-written reproduction
   * tests still cluster together. The excluded files are still shipped — they
   * just don't influence which cluster wins.
   */
  isTestPath?: (filePath: string) => boolean;
}

const DEFAULT_TEST_PATH_RE = /(^|\/)(tests?\/|test_[^/]*\.py$|[^/]*_test\.py$|conftest\.py$)/;

function defaultIsTestPath(filePath: string): boolean {
  return DEFAULT_TEST_PATH_RE.test(filePath);
}

interface ChangeLine {
  sign: "+" | "-";
  file: string;
  content: string;
}

/**
 * Extract the meaningful added/removed lines from a unified diff, tagged with
 * their file. Context lines, hunk headers (`@@`), file headers (`+++`/`---`),
 * `index`/`diff --git` lines, and `new file`/`deleted` metadata are ignored —
 * only the actual content changes matter for deciding whether two patches are
 * "the same edit".
 */
export function extractChangeLines(diff: string): ChangeLine[] {
  const out: ChangeLine[] = [];
  let currentFile = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      // `diff --git a/foo b/foo` — prefer the b-side path.
      const m = raw.match(/ b\/(.+)$/);
      currentFile = m ? m[1] : currentFile;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim().replace(/^b\//, "");
      if (p && p !== "/dev/null") currentFile = p;
      continue;
    }
    if (
      raw.startsWith("--- ") ||
      raw.startsWith("@@") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename ") ||
      raw.startsWith("Binary files")
    ) {
      continue;
    }
    if (raw.startsWith("+")) {
      const content = raw.slice(1).replace(/\s+$/, "");
      if (content.length > 0) out.push({ sign: "+", file: currentFile, content });
    } else if (raw.startsWith("-")) {
      const content = raw.slice(1).replace(/\s+$/, "");
      if (content.length > 0) out.push({ sign: "-", file: currentFile, content });
    }
  }
  return out;
}

/**
 * Canonical key for a patch's *source* change, used to cluster equivalent
 * patches together for majority vote. Test-file changes are excluded (see
 * SelectOptions.isTestPath) so reproduction-test variation doesn't fragment
 * clusters. The set of changed lines is sorted so that hunk ordering and
 * file ordering don't matter — two patches making the same net edits collapse
 * to the same key.
 *
 * Returns "" when there is no source change (empty / test-only patch).
 */
export function normalizeSourceChange(
  diff: string,
  isTestPath: (p: string) => boolean = defaultIsTestPath,
): string {
  const changes = extractChangeLines(diff).filter((c) => !isTestPath(c.file));
  if (changes.length === 0) return "";
  const tokens = changes.map((c) => `${c.sign}\u0001${c.file}\u0001${c.content}`);
  // Sort for order-independence; dedupe identical lines so trivial repetition
  // doesn't change the key.
  return Array.from(new Set(tokens)).sort().join("\n");
}

function regressionRank(status: RegressionStatus): number {
  switch (status) {
    case "pass":
      return 0;
    case "unknown":
      return 1;
    case "fail":
      return 2;
  }
}

/**
 * Choose the best candidate among N. Deterministic: given the same inputs it
 * always returns the same selection (ties broken by minimal change size, then
 * lowest index).
 */
export function selectPatch(
  candidates: PatchCandidate[],
  opts: SelectOptions = {},
): SelectionResult {
  const isTestPath = opts.isTestPath ?? defaultIsTestPath;

  const annotations: CandidateAnnotation[] = candidates.map((c) => {
    const clusterKey = normalizeSourceChange(c.diff, isTestPath);
    return {
      index: c.index,
      empty: clusterKey === "",
      clusterKey,
      regression: c.regression ?? "unknown",
      changeSize: extractChangeLines(c.diff).length,
    };
  });

  const nonEmpty = annotations.filter((a) => !a.empty);

  if (nonEmpty.length === 0) {
    return {
      selectedIndex: candidates.length > 0 ? candidates[0].index : -1,
      reason: `all ${candidates.length} candidate(s) were empty / no source change`,
      allEmpty: true,
      selectedTier: "unknown",
      annotations,
      clusters: [],
    };
  }

  // Pick the best available regression tier (pass > unknown > fail), then
  // operate only within that tier.
  const bestRank = Math.min(...nonEmpty.map((a) => regressionRank(a.regression)));
  const tier = nonEmpty.filter((a) => regressionRank(a.regression) === bestRank);
  const selectedTier = tier[0].regression;

  // Cluster the tier by normalized source change.
  const byKey = new Map<string, CandidateAnnotation[]>();
  for (const a of tier) {
    const arr = byKey.get(a.clusterKey);
    if (arr) arr.push(a);
    else byKey.set(a.clusterKey, [a]);
  }

  const clusters: ClusterInfo[] = Array.from(byKey.entries()).map(([key, members]) => {
    const sorted = [...members].sort(byMinimalThenIndex);
    return {
      key,
      members: sorted.map((m) => m.index),
      representative: sorted[0].index,
    };
  });

  // Largest cluster wins; ties → the cluster whose representative has the
  // smallest change, then lowest index. This favors the edit that the most
  // independent samples agreed on, and among equally-popular edits the most
  // minimal/earliest one.
  clusters.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    const ra = tier.find((t) => t.index === a.representative)!;
    const rb = tier.find((t) => t.index === b.representative)!;
    return byMinimalThenIndex(ra, rb);
  });

  const winner = clusters[0];
  const agreed = winner.members.length;
  const reason =
    `selected sample #${winner.representative} from tier="${selectedTier}" ` +
    `(${agreed}/${tier.length} samples in this tier agreed on the same source change; ` +
    `${clusters.length} distinct edit(s) in tier).`;

  return {
    selectedIndex: winner.representative,
    reason,
    allEmpty: false,
    selectedTier,
    annotations,
    clusters,
  };
}

function byMinimalThenIndex(a: CandidateAnnotation, b: CandidateAnnotation): number {
  if (a.changeSize !== b.changeSize) return a.changeSize - b.changeSize;
  return a.index - b.index;
}
