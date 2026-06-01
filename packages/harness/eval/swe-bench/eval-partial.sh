#!/usr/bin/env bash
# Run SWE-bench harness on a subset of instance_ids (incremental eval).
#
# Usage:
#   eval-partial.sh <predictions.jsonl> <run_id> <id1> [id2 ...]
#
# Example (ECS, after re-running 8 empty-patch agents):
#   eval-partial.sh ~/swe-batch/lite-51-100-rv1/predictions.jsonl \
#     lite-51-100-rv1-eval-partial8 \
#     django__django-15061 django__django-15202 ...
#
# Requires Mac pproxy + ssh -R 7890 (same as full eval, WORKFLOW §1.5).
# Output: ~/forgelet-docker-rv1.<run_id>.json on ECS (or forgelet-docker.* per MODEL_NAME).

set -euo pipefail

PRED="${1:?usage: $0 <predictions.jsonl> <run_id> <instance_id> [...]}"
RUN_ID="${2:?usage: $0 <predictions.jsonl> <run_id> <instance_id> [...]}"
shift 2
IDS=("$@")
[[ ${#IDS[@]} -gt 0 ]] || { echo "error: need at least one instance_id" >&2; exit 1; }

MODEL_NAME="${MODEL_NAME:-forgelet-docker-rv1}"
SWEB_PYTHON="${SWEB_PYTHON:-$HOME/sweb-venv/bin/python}"

echo "=== partial eval: ${#IDS[@]} instance(s) → run_id=$RUN_ID ==="
echo "  predictions: $PRED"
echo "  model:       $MODEL_NAME"

rm -rf "$HOME/logs/run_evaluation/$RUN_ID"

nohup env \
  http_proxy=http://127.0.0.1:7890 \
  https_proxy=http://127.0.0.1:7890 \
  HTTP_PROXY=http://127.0.0.1:7890 \
  HTTPS_PROXY=http://127.0.0.1:7890 \
  NO_PROXY=localhost,127.0.0.1,mirror.ccs.tencentyun.com \
  HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  "$SWEB_PYTHON" -m swebench.harness.run_evaluation \
    --predictions_path "$PRED" \
    --dataset_name SWE-bench/SWE-bench_Lite \
    --run_id "$RUN_ID" \
    --instance_ids "${IDS[@]}" \
    --max_workers "${MAX_WORKERS:-4}" \
    --cache_level env \
  > "$HOME/swe-batch/$RUN_ID.log" 2>&1 </dev/null &

echo "pid=$!"
echo "Monitor: tail -f ~/swe-batch/$RUN_ID.log"
echo "Done when: find ~/logs/run_evaluation/$RUN_ID -name report.json | wc -l  == ${#IDS[@]}"
echo "Report:    ~/forgelet-docker-rv1.$RUN_ID.json  (adjust if MODEL_NAME differs)"
