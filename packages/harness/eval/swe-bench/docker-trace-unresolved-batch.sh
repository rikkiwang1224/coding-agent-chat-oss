#!/usr/bin/env bash
# Trace-rerun every instance_id listed in a file (one attempt each).
# Intended for all *unresolved* IDs from eval-report.json (not empty_patch).
#
# Usage:
#   docker-trace-unresolved-batch.sh <ids.txt> [attempts_per_id]
#
# ids.txt: one instance_id per line (# comments allowed).
# Default attempts=1 (use 3 only for deep-dive cases via docker-trace-rerun.sh).
#
# Logs: ~/swe-batch/unresolved-trace-batch.log
# Traces: ~/.lattice-code/traces/swe-bench/eval-unresolved-<id>-a1/instances/<id>.jsonl

set -euo pipefail

IDS_FILE="${1:?usage: $0 <ids.txt> [attempts]}"
ATTEMPTS="${2:-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RERUN="${SCRIPT_DIR}/docker-trace-rerun.sh"
[[ -x "$RERUN" ]] || RERUN="$HOME/docker-trace-rerun.sh"

LOG="${HOME}/swe-batch/unresolved-trace-batch.log"
DONE="${HOME}/swe-batch/unresolved-trace-done.txt"
touch "$DONE" "$LOG"

resolve_instances_json() {
  local id="$1"
  for f in \
    "$HOME/swe-batch/lite-51-100-instances.json" \
    "$HOME/swe-batch/instances.json" \
    "$HOME/swe-batch/lite-50/instances.json"; do
    if [[ -f "$f" ]] && jq -e --arg id "$id" 'any(.[]; .instance_id == $id)' "$f" >/dev/null 2>&1; then
      echo "$f"
      return 0
    fi
  done
  return 1
}

TOTAL=$(grep -v '^#' "$IDS_FILE" | grep -v '^[[:space:]]*$' | wc -l | tr -d ' ')
N=0

echo "=== unresolved trace batch: $TOTAL ids, $ATTEMPTS attempt(s) each ===" | tee -a "$LOG"

while IFS= read -r id || [[ -n "${id:-}" ]]; do
  id="${id%%#*}"
  id="${id// /}"
  [[ -z "$id" ]] && continue

  N=$((N + 1))
  if grep -qx "$id" "$DONE" 2>/dev/null; then
    echo "[$N/$TOTAL] $id — skip (done)" | tee -a "$LOG"
    continue
  fi

  json=$(resolve_instances_json "$id") || {
    echo "[$N/$TOTAL] $id — SKIP: not in any instances.json" | tee -a "$LOG"
    continue
  }

  echo "" | tee -a "$LOG"
  echo "[$N/$TOTAL] $id — json=$json" | tee -a "$LOG"
  prefix="unresolved-${id}"
  LATTICE_CODE_SAVE_TRACE=1 "$RERUN" "$id" "$ATTEMPTS" "$json" "$prefix" 2>&1 | tee -a "$LOG"
  echo "$id" >> "$DONE"
done < "$IDS_FILE"

echo "=== batch finished $(date -Is) ===" | tee -a "$LOG"
