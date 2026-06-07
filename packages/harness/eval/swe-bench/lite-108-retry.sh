#!/usr/bin/env bash
# Re-run lite-108 instances that failed (402 balance, empty patch, FAIL_PULL).
#
# Usage (ECS):
#   bash lite-108-retry.sh
#   OUT_DIR=~/swe-batch/lite-108-retry bash lite-108-retry.sh
#
# IDs file is generated on ECS from bucket summaries, or pass RETRY_IDS_FILE.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_FILE="${RETRY_IDS_FILE:-$HOME/swe-batch/lite-108-retry/retry-ids.txt}"
OUT_DIR="${OUT_DIR:-$HOME/swe-batch/lite-108-retry}"
INSTANCES_JSON="$OUT_DIR/instances.json"
MODEL_NAME="${MODEL_NAME:-forgelet-docker-guard}"
TRACE_RUN_ID="${FORGELET_TRACE_RUN_ID:-lite-108-retry}"

read_ids() {
  grep -v '^#' "$IDS_FILE" | grep -v '^[[:space:]]*$' || true
}

ensure_instances() {
  local n expected
  expected="$(read_ids | wc -l | tr -d ' ')"
  mkdir -p "$OUT_DIR"
  local full="${LITE_FULL:-$HOME/swe-batch/lite-full/instances.json}"
  [[ -f "$full" ]] || full="$HOME/.forgelet/runs/swe-bench/lite-full/instances.json"
  [[ -f "$full" ]] || { echo "Missing lite-full instances.json" >&2; exit 1; }
  jq -c --argjson ids "$(read_ids | jq -R . | jq -s .)" \
    '[.[] | select(.instance_id as $id | $ids | index($id))]' \
    "$full" > "$INSTANCES_JSON"
  n="$(jq 'length' "$INSTANCES_JSON")"
  [[ "$n" -eq "$expected" ]] || {
    echo "Expected $expected instances, got $n — check $IDS_FILE" >&2
    exit 1
  }
}

[[ -f "$IDS_FILE" ]] || { echo "Missing $IDS_FILE — build retry list first" >&2; exit 1; }

ensure_instances

echo ""
echo "=== lite-108 retry: $(jq length "$INSTANCES_JSON") instances → $OUT_DIR ==="
echo "    MODEL_NAME=$MODEL_NAME"
echo "    FORGELET_TRACE_RUN_ID=$TRACE_RUN_ID"
echo ""

export MODEL_NAME
export FORGELET_TRACE_RUN_ID
export FORGELET_SAVE_TRACE="${FORGELET_SAVE_TRACE:-1}"

exec bash "$SCRIPT_DIR/docker-batch.sh" "$INSTANCES_JSON" "$OUT_DIR"
