#!/usr/bin/env bash
# Run official SWE-bench Docker evaluation harness.
#
# Usage:
#   ./evaluate.sh <predictions.jsonl> <dataset_name> <run_id> [max_workers] [namespace]
#
# Examples:
#   ./evaluate.sh runs/eval-123/predictions.jsonl princeton-nlp/SWE-bench_Lite my-run 4
#   # macOS ARM — build images locally:
#   ./evaluate.sh predictions.jsonl princeton-nlp/SWE-bench_Lite my-run 1 ''

set -euo pipefail

PREDICTIONS="${1:?predictions path required}"
DATASET_NAME="${2:-princeton-nlp/SWE-bench_Lite}"
RUN_ID="${3:-eval-$(date +%s)}"
MAX_WORKERS="${4:-4}"
NAMESPACE="${5-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${SWEBENCH_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Error: Python venv not found at $SCRIPT_DIR/.venv"
  echo "Run: cd $SCRIPT_DIR && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

EXTRA=()
if [[ -n "${NAMESPACE}" ]]; then
  EXTRA+=(--namespace "${NAMESPACE}")
fi

echo "SWE-bench harness"
echo "  predictions:  $PREDICTIONS"
echo "  dataset:      $DATASET_NAME"
echo "  run_id:       $RUN_ID"
echo "  max_workers:  $MAX_WORKERS"
echo ""

cd "$SCRIPT_DIR"
"$PYTHON" -m swebench.harness.run_evaluation \
  --predictions_path "$PREDICTIONS" \
  --dataset_name "$DATASET_NAME" \
  --run_id "$RUN_ID" \
  --max_workers "$MAX_WORKERS" \
  --cache_level env \
  "${EXTRA[@]}"

echo ""
echo "Results: $SCRIPT_DIR/evaluation_results/${RUN_ID}/"
