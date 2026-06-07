#!/usr/bin/env bash
# Guard A/B retest: re-run 29 SWE-bench Lite instances that previously modified test files.
#
# Usage (ECS):
#   bash guard-retest-29.sh
#   OUT_DIR=~/swe-batch/guard-retest-29 MODEL_NAME=forgelet-docker-guard bash guard-retest-29.sh
#
# Mac — fetch instances only:
#   bash guard-retest-29.sh --fetch-only
#
# After batch + eval-partial:
#   compare resolved vs baseline eval reports for the same instance_ids.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_FILE="$SCRIPT_DIR/guard-retest-29.instance-ids.txt"
OUT_DIR="${OUT_DIR:-$HOME/swe-batch/guard-retest-29}"
INSTANCES_JSON="$OUT_DIR/instances.json"
MODEL_NAME="${MODEL_NAME:-forgelet-docker-guard}"
TRACE_RUN_ID="${FORGELET_TRACE_RUN_ID:-guard-retest-29}"
EXPECTED=29
FETCH_ONLY="${1:-}"

read_ids() {
  grep -v '^#' "$IDS_FILE" | grep -v '^[[:space:]]*$' || true
}

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
  local full="${LITE_FULL:-$HOME/.forgelet/runs/swe-bench/lite-full/instances.json}"
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

if [[ "$FETCH_ONLY" == "--fetch-only" ]]; then
  ensure_instances
  jq -r '.[].instance_id' "$INSTANCES_JSON"
  exit 0
fi

ensure_instances

echo ""
echo "=== guard retest batch: $EXPECTED instances → $OUT_DIR ==="
echo "    MODEL_NAME=$MODEL_NAME"
echo "    FORGELET_TRACE_RUN_ID=$TRACE_RUN_ID"
echo ""

export MODEL_NAME
export FORGELET_TRACE_RUN_ID
export FORGELET_SAVE_TRACE="${FORGELET_SAVE_TRACE:-1}"

exec bash "$SCRIPT_DIR/docker-batch.sh" "$INSTANCES_JSON" "$OUT_DIR"
