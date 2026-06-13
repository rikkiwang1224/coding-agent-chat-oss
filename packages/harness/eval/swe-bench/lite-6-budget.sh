#!/usr/bin/env bash
# Rerun the 6 lite-300 "budget wall" instances that hit the old 75-turn cap
# while still making progress. Uses the fixed docker-batch.sh defaults:
# 1800s soft budget (+120s grace) and 120 turns.
#
# Usage (ECS):
#   cd ~/coding-agent-chat-oss/packages/harness/eval/swe-bench
#   bash lite-6-budget.sh
#
# After agent batch:
#   bash run-eval-ecs.sh ~/swe-batch/lite-6-budget/predictions.jsonl lite-6-budget-eval
#
# Defaults: lattice-code-docker-guard, THINKING_MODE=max

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_FILE="$SCRIPT_DIR/lite-6-budget.instance-ids.txt"
OUT_DIR="${OUT_DIR:-$HOME/swe-batch/lite-6-budget}"
INSTANCES_JSON="$OUT_DIR/instances.json"
MODEL_NAME="${MODEL_NAME:-lattice-code-docker-guard}"
TRACE_RUN_ID="${LATTICE_CODE_TRACE_RUN_ID:-lite-6-budget}"

[[ -f "$IDS_FILE" ]] || { echo "Missing $IDS_FILE" >&2; exit 1; }

read_ids() {
  grep -v '^#' "$IDS_FILE" | grep -v '^[[:space:]]*$' || true
}

EXPECTED="$(read_ids | wc -l | tr -d ' ')"
[[ "$EXPECTED" -gt 0 ]] || { echo "No instance IDs in $IDS_FILE" >&2; exit 1; }

ensure_instances() {
  mkdir -p "$OUT_DIR"
  if [[ -f "$INSTANCES_JSON" ]]; then
    local n
    n="$(jq 'length' "$INSTANCES_JSON" 2>/dev/null || echo 0)"
    if [[ "$n" -eq "$EXPECTED" ]]; then
      echo "Using existing $INSTANCES_JSON ($n instances)"
      return
    fi
  fi
  local full="${LITE_FULL:-$HOME/swe-batch/lite-full/instances.json}"
  [[ -f "$full" ]] || { echo "Missing $full (need lite-full instances.json)" >&2; exit 1; }
  echo "=== slicing $EXPECTED instances from $full ==="
  jq -c --argjson ids "$(read_ids | jq -R . | jq -s .)" \
    '[.[] | select(.instance_id as $id | $ids | index($id))]' \
    "$full" > "$INSTANCES_JSON"
  local n
  n="$(jq 'length' "$INSTANCES_JSON")"
  [[ "$n" -eq "$EXPECTED" ]] || {
    echo "Expected $EXPECTED instances, got $n — check IDs in $IDS_FILE" >&2
    exit 1
  }
}

ensure_instances

echo ""
echo "=== lite-6-budget: $EXPECTED instances → $OUT_DIR ==="
echo "    MODEL_NAME=$MODEL_NAME"
echo "    LATTICE_CODE_TRACE_RUN_ID=$TRACE_RUN_ID"
echo "    agent budget: ${PER_INSTANCE_TIMEOUT:-1800}s soft + ${HARD_KILL_GRACE:-120}s grace, ${LATTICE_CODE_MAX_TURNS:-120} turns"
echo ""

export MODEL_NAME
export LATTICE_CODE_TRACE_RUN_ID
export LATTICE_CODE_SAVE_TRACE="${LATTICE_CODE_SAVE_TRACE:-1}"

exec bash "$SCRIPT_DIR/docker-batch.sh" "$INSTANCES_JSON" "$OUT_DIR"
