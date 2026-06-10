#!/usr/bin/env bash
# Retry the 4 lite-300 orphans outside lite-86 (3 never retried + 1 guard-retest regression).
#
# Usage (ECS):
#   cd ~/coding-agent-chat-oss/packages/harness/eval/swe-bench
#   bash lite-4-orphan.sh
#
#   # Fetch instances.json only (Mac or ECS):
#   bash lite-4-orphan.sh --fetch-only
#
# After agent batch:
#   bash run-eval-ecs.sh ~/swe-batch/lite-4-orphan/predictions.jsonl lite-4-orphan-eval
#
# Quick win for pytest-5103 (lite-108 patch already passed eval):
#   bash lite-4-orphan.sh --restore-5103-from-lite-108
#
# Defaults: lattice-code-docker-guard, THINKING_MODE=max

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_FILE="$SCRIPT_DIR/lite-4-orphan.instance-ids.txt"
OUT_DIR="${OUT_DIR:-$HOME/swe-batch/lite-4-orphan}"
INSTANCES_JSON="$OUT_DIR/instances.json"
MODEL_NAME="${MODEL_NAME:-lattice-code-docker-guard}"
TRACE_RUN_ID="${LATTICE_CODE_TRACE_RUN_ID:-lite-4-orphan}"
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

restore_5103_from_lite_108() {
  local src="${LITE108_PREDS:-$HOME/.lattice-code/runs/swe-bench/lite-108-eval-merged/predictions.jsonl}"
  [[ -f "$src" ]] || src="$HOME/swe-batch/lite-108-merged/predictions.jsonl"
  [[ -f "$src" ]] || {
    echo "lite-108 predictions not found (set LITE108_PREDS)" >&2
    exit 1
  }
  mkdir -p "$OUT_DIR"
  local row
  row="$(grep '"pytest-dev__pytest-5103"' "$src" | tail -1)"
  [[ -n "$row" ]] || { echo "pytest-5103 not in $src" >&2; exit 1; }
  local patch_len
  patch_len="$(echo "$row" | jq -r '.model_patch | length')"
  [[ "$patch_len" -gt 0 ]] || { echo "lite-108 patch for pytest-5103 is empty" >&2; exit 1; }
  echo "$row" | jq --arg m "$MODEL_NAME" '.model_name_or_path = $m' > "$OUT_DIR/pytest-5103-from-lite108.jsonl"
  echo "Wrote $OUT_DIR/pytest-5103-from-lite108.jsonl (patch len=$patch_len)"
  echo "Merge into predictions.jsonl after agent run, or eval alone:"
  echo "  bash run-eval-ecs.sh $OUT_DIR/pytest-5103-from-lite108.jsonl lite-4-orphan-5103-eval"
}

case "$MODE" in
  --fetch-only)
    ensure_instances
    jq -r '.[].instance_id' "$INSTANCES_JSON"
    exit 0
    ;;
  --restore-5103-from-lite-108)
    restore_5103_from_lite_108
    exit 0
    ;;
  "")
    ;;
  *)
    echo "Unknown option: $MODE" >&2
    echo "Usage: bash lite-4-orphan.sh [--fetch-only|--restore-5103-from-lite-108]" >&2
    exit 1
    ;;
esac

ensure_instances

echo ""
echo "=== lite-4-orphan: $EXPECTED instances → $OUT_DIR ==="
echo "    MODEL_NAME=$MODEL_NAME"
echo "    LATTICE_CODE_TRACE_RUN_ID=$TRACE_RUN_ID"
echo "    THINKING_MODE=${THINKING_MODE:-max (SWE-bench default)}"
echo ""

export MODEL_NAME
export LATTICE_CODE_TRACE_RUN_ID
export LATTICE_CODE_SAVE_TRACE="${LATTICE_CODE_SAVE_TRACE:-1}"

exec bash "$SCRIPT_DIR/docker-batch.sh" "$INSTANCES_JSON" "$OUT_DIR"
