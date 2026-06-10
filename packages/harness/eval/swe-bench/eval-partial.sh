#!/usr/bin/env bash
# Run SWE-bench harness on a subset of instance_ids (incremental eval).
#
# Usage:
#   eval-partial.sh <predictions.jsonl> <run_id> <id1> [id2 ...]
#
# Delegates to run-eval-ecs.sh (proxy + sphinx eval pins). Requires Mac tunnel
# unless SKIP_ECS_PREFLIGHT=1 — see start-mac-tunnel.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PRED="${1:?usage: $0 <predictions.jsonl> <run_id> <instance_id> [...]}"
RUN_ID="${2:?usage: $0 <predictions.jsonl> <run_id> <instance_id> [...]}"
shift 2
IDS=("$@")
[[ ${#IDS[@]} -gt 0 ]] || { echo "error: need at least one instance_id" >&2; exit 1; }

MODEL_NAME="${MODEL_NAME:-lattice-code-docker-rv1}"
export MAX_WORKERS="${MAX_WORKERS:-4}"

echo "=== partial eval via run-eval-ecs.sh: ${#IDS[@]} instance(s) → run_id=$RUN_ID ==="
exec bash "$SCRIPT_DIR/run-eval-ecs.sh" "$PRED" "$RUN_ID" "${IDS[@]}"
