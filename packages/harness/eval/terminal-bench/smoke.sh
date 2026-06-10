#!/usr/bin/env bash
# Single-task smoke test (streams Harbor output).
#
# Usage:
#   ./smoke.sh [task_id]
#
# Default task_id: hello-world

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Default task: first task in TB 2.1 registry (hello-world is not in this dataset).
TASK="${1:-adaptive-rejection-sampler}"
if [[ "$TASK" != */* ]]; then
  TASK="terminal-bench/$TASK"
fi
MODEL="${LATTICE_CODE_HARBOR_MODEL:-deepseek/deepseek-chat}"
DATASET="${LATTICE_CODE_HARBOR_DATASET:-terminal-bench/terminal-bench-2-1}"

exec "$DIR/run-harbor.sh" \
  run \
  --dataset "$DATASET" \
  --include-task-name "$TASK" \
  --model "$MODEL" \
  --n-concurrent 1 \
  --yes
