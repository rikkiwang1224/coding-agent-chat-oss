#!/usr/bin/env bash
# Rerun the 7 mechanically-failed lite-300 instances (6 timeout-killed with
# patch lost + 1 FAIL_PULL). Relies on the fixed docker-batch.sh: agent soft
# budget 1800s, hard kill at +120s, and worktree-diff salvage on kill.
#
# NOT in this list (no agent rerun needed):
#   sphinx-doc__sphinx-8801 — agent patch exists; eval failed on a missing
#   Docker image (404). Just pull the image and re-eval its prediction:
#     bash run-eval-ecs.sh <predictions-with-8801.jsonl> lite-sphinx-8801-eval
#
# Usage (ECS):
#   cd ~/coding-agent-chat-oss/packages/harness/eval/swe-bench
#   bash lite-7-mech.sh
#
#   # Fetch instances.json only (Mac or ECS):
#   bash lite-7-mech.sh --fetch-only
#
# After agent batch:
#   bash run-eval-ecs.sh ~/swe-batch/lite-7-mech/predictions.jsonl lite-7-mech-eval
#
# Defaults: lattice-code-docker-guard, THINKING_MODE=max

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_FILE="$SCRIPT_DIR/lite-7-mech.instance-ids.txt"
OUT_DIR="${OUT_DIR:-$HOME/swe-batch/lite-7-mech}"
INSTANCES_JSON="$OUT_DIR/instances.json"
MODEL_NAME="${MODEL_NAME:-lattice-code-docker-guard}"
TRACE_RUN_ID="${LATTICE_CODE_TRACE_RUN_ID:-lite-7-mech}"
MODE="${1:-}"

[[ -f "$IDS_FILE" ]] || { echo "Missing $IDS_FILE" >&2; exit 1; }

read_ids() {
  grep -v '^#' "$IDS_FILE" | grep -v '^[[:space:]]*$' || true
}

EXPECTED="$(read_ids | wc -l | tr -d ' ')"
[[ "$EXPECTED" -gt 0 ]] || { echo "No instance IDs in $IDS_FILE" >&2; exit 1; }

fetch_from_hf() {
  local py="$SCRIPT_DIR/.venv/bin/python3"
  if [[ ! -x "$py" ]]; then
    py=python3
  fi
  local ids
  ids="$(read_ids | tr '\n' ' ')"
  echo "=== fetching $EXPECTED instances from HuggingFace (SWE-bench_Lite) ==="
  "$py" "$SCRIPT_DIR/fetch_instances.py" \
    --dataset lite \
    --output "$INSTANCES_JSON" \
    --instance-ids $ids
}

fetch_from_local_lite_full() {
  local full="${LITE_FULL:-$HOME/swe-batch/lite-full/instances.json}"
  [[ -f "$full" ]] || full="${LITE_FULL:-$HOME/.lattice-code/runs/swe-bench/lite-full/instances.json}"
  [[ -f "$full" ]] || return 1
  echo "=== slicing instances from $full ==="
  mkdir -p "$OUT_DIR"
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
  if fetch_from_local_lite_full; then
    echo "Wrote $INSTANCES_JSON (from lite-full)"
    return
  fi
  fetch_from_hf
}

case "$MODE" in
  --fetch-only)
    ensure_instances
    jq -r '.[].instance_id' "$INSTANCES_JSON"
    exit 0
    ;;
  "")
    ;;
  *)
    echo "Unknown option: $MODE" >&2
    echo "Usage: bash lite-7-mech.sh [--fetch-only]" >&2
    exit 1
    ;;
esac

ensure_instances

echo ""
echo "=== lite-7-mech: $EXPECTED instances → $OUT_DIR ==="
echo "    MODEL_NAME=$MODEL_NAME"
echo "    LATTICE_CODE_TRACE_RUN_ID=$TRACE_RUN_ID"
echo "    THINKING_MODE=${THINKING_MODE:-max (SWE-bench default)}"
echo "    agent budget: ${PER_INSTANCE_TIMEOUT:-1800}s soft + ${HARD_KILL_GRACE:-120}s grace, ${LATTICE_CODE_MAX_TURNS:-120} turns"
echo ""

export MODEL_NAME
export LATTICE_CODE_TRACE_RUN_ID
export LATTICE_CODE_SAVE_TRACE="${LATTICE_CODE_SAVE_TRACE:-1}"

exec bash "$SCRIPT_DIR/docker-batch.sh" "$INSTANCES_JSON" "$OUT_DIR"
