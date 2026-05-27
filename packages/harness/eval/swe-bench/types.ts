/** SWE-bench instance (HuggingFace dataset row). */
export interface SweBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  patch?: string;
  test_patch?: string;
  version?: string;
  environment_setup_commit?: string;
  FAIL_TO_PASS?: string;
  PASS_TO_PASS?: string;
}

/** JSONL line written for official SWE-bench harness evaluation. */
export interface SweBenchPrediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export type SweBenchDatasetId = "lite" | "verified" | "full";

export const DATASET_HF_IDS: Record<SweBenchDatasetId, string> = {
  lite: "SWE-bench/SWE-bench_Lite",
  verified: "SWE-bench/SWE-bench_Verified",
  full: "SWE-bench/SWE-bench",
};

/** Dataset name passed to `swebench.harness.run_evaluation --dataset_name`. */
export const DATASET_EVAL_NAMES: Record<SweBenchDatasetId, string> = {
  lite: "SWE-bench/SWE-bench_Lite",
  verified: "SWE-bench/SWE-bench_Verified",
  full: "SWE-bench/SWE-bench",
};

export interface SweBenchRunOptions {
  config: import("../../src/types.js").LlmConfig;
  instances: SweBenchInstance[];
  reposCacheDir: string;
  outputDir: string;
  modelName: string;
  maxTurns: number;
  timeoutS: number;
  concurrency: number;
  /** SWE-bench run id for FORGELET_HOME/traces/swe-bench/eval-{runId}/ */
  traceRunId: string;
  /** Write per-instance trace JSONL (default true; use --no-trace to disable) */
  saveTraces?: boolean;
}

export interface SweBenchInstanceResult {
  instance_id: string;
  success: boolean;
  durationMs: number;
  turnCount: number;
  patchLength: number;
  error?: string;
  workspaceDir?: string;
  tracePath?: string;
}

export interface SweBenchRunReport {
  model: string;
  timestamp: string;
  dataset?: SweBenchDatasetId;
  totalInstances: number;
  completed: number;
  failed: number;
  predictionsPath: string;
  totalDurationMs: number;
  results: SweBenchInstanceResult[];
}
