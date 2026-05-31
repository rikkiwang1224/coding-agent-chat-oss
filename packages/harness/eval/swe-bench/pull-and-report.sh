#!/usr/bin/env bash
# Pull a SWE-bench batch run back from ECS and regenerate the cost report
# locally. Idempotent — re-runs are cheap (rsync skips unchanged files).
#
# Usage:
#   ./pull-and-report.sh <run-id> [ecs-host] [ecs-batch-root] [--stop] [--wait-stop]
#
# Defaults:
#   ecs-host        = ubuntu@119.91.220.67  (override with $ECS_HOST or arg2)
#   ecs-batch-root  = ~/swe-batch            (override with $ECS_BATCH_ROOT or arg3)
#
#   --stop       after pull, call ../../stop-ecs.sh (Tencent Cloud API shutdown)
#   --wait-stop  same as --stop, and wait until instance is STOPPED
#
# Outputs land in ~/.forgelet/runs/swe-bench/<run-id>/, including:
#   summary.tsv, predictions.jsonl, logs/<id>/agent.log, cost-report.{tsv,md}
set -euo pipefail

RUN_ID="${1:?usage: $0 <run-id> [ecs-host] [ecs-batch-root] [--stop] [--wait-stop]}"
shift

STOP_AFTER=false
WAIT_STOP=false
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --stop) STOP_AFTER=true ;;
    --wait-stop) STOP_AFTER=true; WAIT_STOP=true ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

ECS_HOST="${POSITIONAL[0]:-${ECS_HOST:-ubuntu@119.91.220.67}}"
ECS_ROOT="${POSITIONAL[1]:-${ECS_BATCH_ROOT:-~/swe-batch}}"

LOCAL_ROOT="$HOME/.forgelet/runs/swe-bench"
LOCAL_DIR="$LOCAL_ROOT/$RUN_ID"
mkdir -p "$LOCAL_DIR"

echo "=== rsync ${ECS_HOST}:${ECS_ROOT}/${RUN_ID}/ → ${LOCAL_DIR}/ ==="
# --delete-after keeps the local tree honest (e.g. when we re-run with fewer
# instances), but we never delete the local cost-report.* if ECS lacks one.
rsync -avz --delete-after \
  --exclude 'cost-report.tsv' --exclude 'cost-report.md' \
  "${ECS_HOST}:${ECS_ROOT}/${RUN_ID}/" \
  "${LOCAL_DIR}/"

# Regenerate cost report locally — uses the just-rsynced logs/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="$SCRIPT_DIR/cost-report.py"
if [[ ! -f "$REPORT" ]]; then
  echo "cost-report.py not found at $REPORT" >&2
  exit 1
fi

echo ""
python3 "$REPORT" "$LOCAL_DIR"

echo ""
echo "Files:"
echo "  Per-instance TSV:  $LOCAL_DIR/cost-report.tsv"
echo "  Markdown summary:  $LOCAL_DIR/cost-report.md"
echo "  Trajectory logs:   $LOCAL_DIR/logs/<instance_id>/agent.log"

if [[ "$STOP_AFTER" == true ]]; then
  STOP_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/stop-ecs.sh"
  STOP_ARGS=()
  if [[ "$WAIT_STOP" == true ]]; then
    STOP_ARGS+=(--wait)
  fi
  echo ""
  echo "=== stopping ECS ==="
  "$STOP_SCRIPT" "${STOP_ARGS[@]}"
fi
