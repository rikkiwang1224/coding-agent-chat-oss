#!/usr/bin/env bash
# Re-run a 31-instance sample of the final 62 unresolved (lite-300-final ledger),
# with JSONL traces ON for optimization analysis.
#
# Sample: lite-31-trace.instance-ids.txt — proportional by repo (seed 20260612):
#   sympy 10, sphinx 6, django 4, matplotlib 3, sklearn 2, pytest 2, astropy 2, psf 1, pydata 1
#
# Usage (ECS):
#   bash lite-31-trace.sh
#   OUT_DIR=~/swe-batch/lite-31-trace bash lite-31-trace.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_FILE="$SCRIPT_DIR/lite-31-trace.instance-ids.txt"
OUT_DIR="${OUT_DIR:-$HOME/swe-batch/lite-31-trace}"
INSTANCES_JSON="$OUT_DIR/instances.json"
MODEL_NAME="${MODEL_NAME:-lattice-code-docker-trace31}"
TRACE_RUN_ID="${LATTICE_CODE_TRACE_RUN_ID:-lite-31-trace}"

[[ -f "$IDS_FILE" ]] || { echo "Missing $IDS_FILE" >&2; exit 1; }

read_ids() {
  grep -v '^#' "$IDS_FILE" | grep -v '^[[:space:]]*$' || true
}

EXPECTED="$(read_ids | wc -l | tr -d ' ')"
[[ "$EXPECTED" -eq 31 ]] || { echo "Expected 31 IDs, got $EXPECTED" >&2; exit 1; }

ensure_instances() {
  mkdir -p "$OUT_DIR"
  if [[ -f "$INSTANCES_JSON" ]]; then
    local n
    n="$(jq 'length' "$INSTANCES_JSON" 2>/dev/null || echo 0)"
    [[ "$n" -eq "$EXPECTED" ]] && { echo "Using existing $INSTANCES_JSON ($n)"; return; }
  fi
  local full="${LITE_FULL:-$HOME/swe-batch/lite-full/instances.json}"
  [[ -f "$full" ]] || { echo "Missing $full — rsync lite-full first" >&2; exit 1; }
  jq -c --argjson ids "$(read_ids | jq -R . | jq -s .)" \
    '[.[] | select(.instance_id as $id | $ids | index($id))]' \
    "$full" > "$INSTANCES_JSON"
  local n
  n="$(jq 'length' "$INSTANCES_JSON")"
  [[ "$n" -eq "$EXPECTED" ]] || { echo "Expected $EXPECTED, sliced $n" >&2; exit 1; }
  echo "Wrote $INSTANCES_JSON ($n instances)"
}

ensure_instances

echo ""
echo "=== lite-31-trace: $EXPECTED instances → $OUT_DIR (traces ON) ==="
echo "    MODEL_NAME=$MODEL_NAME  TRACE_RUN_ID=$TRACE_RUN_ID"
echo ""

export MODEL_NAME
export LATTICE_CODE_TRACE_RUN_ID="$TRACE_RUN_ID"
export LATTICE_CODE_SAVE_TRACE=1

exec bash "$SCRIPT_DIR/docker-batch.sh" "$INSTANCES_JSON" "$OUT_DIR"
