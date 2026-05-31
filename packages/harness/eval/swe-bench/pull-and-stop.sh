#!/usr/bin/env bash
# Pull a batch run from ECS, regenerate cost report, then stop the CVM.
#
# Usage:
#   ./pull-and-stop.sh <run-id> [ecs-host] [ecs-batch-root] [--wait-stop]
#
# Same as pull-and-report.sh, then calls ../stop-ecs.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RUN_ID="${1:?usage: $0 <run-id> [ecs-host] [ecs-batch-root] [--wait-stop]}"
shift

WAIT_STOP=false
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --wait-stop) WAIT_STOP=true ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

"$SCRIPT_DIR/pull-and-report.sh" "$RUN_ID" "${POSITIONAL[@]:-}"

STOP_ARGS=()
if [[ "$WAIT_STOP" == true ]]; then
  STOP_ARGS+=(--wait)
fi
"$EVAL_DIR/stop-ecs.sh" "${STOP_ARGS[@]}"
