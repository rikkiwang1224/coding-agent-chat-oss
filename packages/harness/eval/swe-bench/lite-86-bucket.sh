#!/usr/bin/env bash
# Re-run remaining unresolved Lite instances (86 total) in one of three random buckets.
#
# Usage (ECS):
#   BUCKET=a bash lite-86-bucket.sh
#   BUCKET=b OUT_DIR=~/swe-batch/lite-86-bucket-b bash lite-86-bucket.sh
#
# Mac — fetch instances only (prep; real batch still runs on ECS Docker):
#   BUCKET=a bash lite-86-bucket.sh --fetch-only
#
# Buckets: a/b/c — 29+29+28 instances (seed 20260607). See lite-86-bucket-*.instance-ids.txt
# Source: lite-108-eval-merged unresolved+empty (84) + baseline error sklearn ×2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUCKET="${BUCKET:?set BUCKET=a|b|c}"
IDS_FILE="$SCRIPT_DIR/lite-86-bucket-${BUCKET}.instance-ids.txt"
OUT_DIR="${OUT_DIR:-$HOME/swe-batch/lite-86-bucket-${BUCKET}}"
INSTANCES_JSON="$OUT_DIR/instances.json"
MODEL_NAME="${MODEL_NAME:-lattice-code-docker-guard}"
TRACE_RUN_ID="${LATTICE_CODE_TRACE_RUN_ID:-lite-86-bucket-${BUCKET}}"
FETCH_ONLY="${1:-}"

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

if [[ "$FETCH_ONLY" == "--fetch-only" ]]; then
  ensure_instances
  jq -r '.[].instance_id' "$INSTANCES_JSON"
  exit 0
fi

ensure_instances

echo ""
echo "=== lite-86 bucket ${BUCKET}: $EXPECTED instances → $OUT_DIR ==="
echo "    MODEL_NAME=$MODEL_NAME"
echo "    LATTICE_CODE_TRACE_RUN_ID=$TRACE_RUN_ID"
echo ""

export MODEL_NAME
export LATTICE_CODE_TRACE_RUN_ID
export LATTICE_CODE_SAVE_TRACE="${LATTICE_CODE_SAVE_TRACE:-1}"

exec bash "$SCRIPT_DIR/docker-batch.sh" "$INSTANCES_JSON" "$OUT_DIR"
