#!/usr/bin/env bash
# Smoke batch: 3 instances to validate MANDATORY self-review gate in prompt.ts.
#
# Usage (ECS):
#   bash smoke-gate-3.sh
#   OUT_DIR=~/swe-batch/smoke-gate-3 MODEL_NAME=lattice-code-docker-gate bash smoke-gate-3.sh
#
# Mac — fetch instances only:
#   bash smoke-gate-3.sh --fetch-only
#
# After batch completes:
#   bash smoke-gate-3.check.sh [out_dir]
#
# Prereqs: docker-batch.sh (built harness on mounted repo, .env, docker, jq, lite-full or HF).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_FILE="$SCRIPT_DIR/smoke-gate-3.instance-ids.txt"
OUT_DIR="${OUT_DIR:-$HOME/swe-batch/smoke-gate-3}"
INSTANCES_JSON="$OUT_DIR/instances.json"
MODEL_NAME="${MODEL_NAME:-lattice-code-docker-gate}"
TRACE_RUN_ID="${LATTICE_CODE_TRACE_RUN_ID:-smoke-gate-3}"
FETCH_ONLY="${1:-}"
EXPECTED=3

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
  local full="${LITE_FULL:-$HOME/.lattice-code/runs/swe-bench/lite-full/instances.json}"
  [[ -f "$full" ]] || full="${LITE_FULL:-$HOME/swe-batch/lite-full/instances.json}"
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
echo "=== smoke-gate-3: $EXPECTED instances → $OUT_DIR ==="
echo "    MODEL_NAME=$MODEL_NAME"
echo "    LATTICE_CODE_TRACE_RUN_ID=$TRACE_RUN_ID"
echo "    LATTICE_CODE_MAX_TURNS=${LATTICE_CODE_MAX_TURNS:-100}"
echo "    THINKING_MODE=${THINKING_MODE:-max (SWE-bench default)}"
echo ""
echo "Ensure harness is built on the mounted repo:"
echo "  cd \$HOME/coding-agent-chat-oss && pnpm --filter @lattice-code/harness build"
echo ""

export MODEL_NAME
export LATTICE_CODE_TRACE_RUN_ID
export LATTICE_CODE_SAVE_TRACE="${LATTICE_CODE_SAVE_TRACE:-1}"

exec bash "$SCRIPT_DIR/docker-batch.sh" "$INSTANCES_JSON" "$OUT_DIR"
