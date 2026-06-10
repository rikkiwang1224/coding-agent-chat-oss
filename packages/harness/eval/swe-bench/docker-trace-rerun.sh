#!/usr/bin/env bash
# Re-run one SWE-bench instance N times with full JSONL traces (root-cause work).
# Do this *before* changing agent logic — compare attempts, then fix once.
#
# Usage:
#   docker-trace-rerun.sh <instance_id> [attempts] [instances.json] [run_id_prefix]
#
# Examples:
#   docker-trace-rerun.sh django__django-14017 3 ~/swe-batch/lite-51-100-instances.json weird-14017
#   docker-trace-rerun.sh django__django-11797 3 ~/swe-batch/lite-50/instances.json weird-11797
#
# Traces land on the ECS host at:
#   ~/.lattice-code/traces/swe-bench/eval-<prefix>-a<1..N>/instances/<id>.jsonl
#
# Summarize on Mac (after rsync traces or pull-and-report):
#   pnpm eval:swe:traces -- --run-id weird-14017-a1 --instance django__django-14017

set -euo pipefail

INSTANCE_ID="${1:?usage: $0 <instance_id> [attempts] [instances.json] [run_id_prefix]}"
ATTEMPTS="${2:-3}"
INSTANCES_JSON="${3:-$HOME/swe-batch/instances.json}"
RUN_PREFIX="${4:-weird-${INSTANCE_ID}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE="$SCRIPT_DIR/docker-smoke.sh"
[[ -x "$SMOKE" ]] || SMOKE="$HOME/docker-smoke.sh"

echo "=== trace rerun: $INSTANCE_ID × $ATTEMPTS (prefix=$RUN_PREFIX) ==="
for a in $(seq 1 "$ATTEMPTS"); do
  RUN_ID="${RUN_PREFIX}-a${a}"
  echo ""
  echo "########################################"
  echo "# attempt $a/$ATTEMPTS → LATTICE_CODE_TRACE_RUN_ID=$RUN_ID"
  echo "########################################"
  LATTICE_CODE_SAVE_TRACE=1 LATTICE_CODE_TRACE_RUN_ID="$RUN_ID" \
    "$SMOKE" "$INSTANCE_ID" "$INSTANCES_JSON"
done

echo ""
echo "=== done. Trace files: ==="
for a in $(seq 1 "$ATTEMPTS"); do
  RUN_ID="${RUN_PREFIX}-a${a}"
  F="${HOME}/.lattice-code/traces/swe-bench/eval-${RUN_ID}/instances/${INSTANCE_ID}.jsonl"
  if [[ -f "$F" ]]; then
    echo "  $F ($(wc -l < "$F") lines)"
  else
    echo "  (missing) $F"
  fi
done
echo ""
echo "Analyze: pnpm eval:swe:traces -- --run-id ${RUN_PREFIX}-a1 --instance ${INSTANCE_ID}"
