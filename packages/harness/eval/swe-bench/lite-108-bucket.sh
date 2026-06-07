#!/usr/bin/env bash
# Re-run adjusted unresolved Lite instances (108 total) in one of three random buckets.
#
# Usage (ECS):
#   BUCKET=a bash lite-108-bucket.sh
#   BUCKET=b OUT_DIR=~/swe-batch/lite-108-bucket-b bash lite-108-bucket.sh
#
# Mac — fetch instances only:
#   BUCKET=a bash lite-108-bucket.sh --fetch-only
#
# Buckets: a/b/c × 36 instances (seed 20260605). See lite-108-bucket-*.instance-ids.txt

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUCKET="${BUCKET:?set BUCKET=a|b|c}"
IDS_FILE="$SCRIPT_DIR/lite-108-bucket-${BUCKET}.instance-ids.txt"
OUT_DIR="${OUT_DIR:-$HOME/swe-batch/lite-108-bucket-${BUCKET}}"
INSTANCES_JSON="$OUT_DIR/instances.json"
MODEL_NAME="${MODEL_NAME:-forgelet-docker-guard}"
TRACE_RUN_ID="${FORGELET_TRACE_RUN_ID:-lite-108-bucket-${BUCKET}}"
EXPECTED=36
FETCH_ONLY="${1:-}"

[[ -f "$IDS_FILE" ]] || { echo "Missing $IDS_FILE" >&2; exit 1; }

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
  local full="${LITE_FULL:-$HOME/swe-batch/lite-full/instances.json}"
  [[ -f "$full" ]] || full="${LITE_FULL:-$HOME/.forgelet/runs/swe-bench/lite-full/instances.json}"
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
echo "=== lite-108 bucket ${BUCKET}: $EXPECTED instances → $OUT_DIR ==="
echo "    MODEL_NAME=$MODEL_NAME"
echo "    FORGELET_TRACE_RUN_ID=$TRACE_RUN_ID"
echo ""

export MODEL_NAME
export FORGELET_TRACE_RUN_ID
export FORGELET_SAVE_TRACE="${FORGELET_SAVE_TRACE:-1}"

exec bash "$SCRIPT_DIR/docker-batch.sh" "$INSTANCES_JSON" "$OUT_DIR"
