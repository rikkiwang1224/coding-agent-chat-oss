#!/usr/bin/env bash
# Pull cloud report (optional) and summarize unresolved instances + agent traces.
#
# Usage:
#   ./analyze-run.sh <run-id> [model-name] [ecs-ip]
#   pnpm eval:swe:analyze -- trace-rerun
#   pnpm eval:swe:analyze -- trace-rerun deepseek-v4-pro 119.91.220.67
set -euo pipefail

RUN_ID="${1:?run-id required}"
MODEL_NAME="${2:-deepseek-v4-pro}"
ECS_IP="${3:-}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CLOUD_DIR="${ROOT}/packages/harness/eval/swe-bench/runs/eval-${RUN_ID}/cloud-results"
REPORT="${CLOUD_DIR}/${MODEL_NAME}.${RUN_ID}.json"
PRED="${HOME}/.forgelet/runs/swe-bench/eval-${RUN_ID}/predictions.jsonl"
TRACES="${HOME}/.forgelet/traces/swe-bench/eval-${RUN_ID}/instances"

if [[ ! -f "$REPORT" ]]; then
  if [[ -n "$ECS_IP" ]]; then
    mkdir -p "$CLOUD_DIR"
    echo "Fetching report from ubuntu@${ECS_IP}..."
    scp "ubuntu@${ECS_IP}:~/forgelet-eval/${MODEL_NAME}.${RUN_ID}.json" "$REPORT"
  else
    echo "Cloud report not found: ${REPORT}" >&2
    echo "  scp ubuntu@<ECS_IP>:~/forgelet-eval/${MODEL_NAME}.${RUN_ID}.json ${REPORT}" >&2
    echo "  or re-run with ECS IP: pnpm eval:swe:analyze -- ${RUN_ID} ${MODEL_NAME} <ECS_IP>" >&2
    exit 1
  fi
fi

echo ""
echo "=== Cloud grading (${RUN_ID}) ==="
echo "Report: ${REPORT}"
jq '{
  resolved_instances,
  unresolved_instances,
  resolved_ids,
  unresolved_ids
}' "$REPORT"

UNRESOLVED="$(jq -r '.unresolved_ids[]?' "$REPORT" || true)"
RESOLVED="$(jq -r '.resolved_ids[]?' "$REPORT" || true)"

echo ""
echo "=== Local artifacts ==="
echo "Predictions: ${PRED}"
echo "Traces:      ${TRACES}/"
[[ -f "$PRED" ]] || echo "  (predictions missing on this Mac)"
[[ -d "$TRACES" ]] || echo "  (traces missing — re-run agent with default traces)"

if [[ -n "$RESOLVED" ]]; then
  echo ""
  echo "Resolved (no trace deep-dive required):"
  while IFS= read -r id; do
    echo "  ✓ ${id}"
  done <<< "$RESOLVED"
fi

if [[ -z "$UNRESOLVED" ]]; then
  echo ""
  echo "All submitted instances resolved."
  exit 0
fi

echo ""
echo "=== Agent trace summary (unresolved) ==="
HARNESS_DIR="${ROOT}/packages/harness"
for id in $UNRESOLVED; do
  echo ""
  echo "--- ${id} ---"
  if [[ -f "$PRED" ]]; then
    line="$(grep -F "${id}" "$PRED" | head -1 || true)"
    if [[ -n "$line" ]]; then
      echo "Patch length: $(echo "$line" | jq -r '.model_patch | length') chars"
    fi
  fi
  if [[ -f "${TRACES}/${id}.jsonl" ]]; then
    pnpm --filter @forgelet/harness exec tsx eval/swe-bench/summarize-traces.ts -- --run-id "$RUN_ID" --instance "$id" 2>/dev/null \
      || (cd "$HARNESS_DIR" && npx tsx eval/swe-bench/summarize-traces.ts -- --run-id "$RUN_ID" --instance "$id")
  else
    echo "  (no trace file — run agent again for ${id})"
  fi
done

echo ""
echo "Next: inspect patch for an unresolved id:"
echo "  grep '<instance_id>' ${PRED} | jq -r .model_patch | less"
echo "Full traces: pnpm eval:swe:traces -- --run-id ${RUN_ID}"
echo "Optional Docker logs: scp -r ubuntu@<ECS_IP>:~/forgelet-eval/logs ${CLOUD_DIR}/"
