#!/usr/bin/env bash
# Full Terminal-Bench batch via Harbor (89 tasks on terminal-bench/terminal-bench-2-1).
#
# Usage:
#   ./tb-docker-batch.sh [output_note]
#
# Harbor writes job artifacts under ./jobs/ by default. Pass extra harbor args after --.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOTE="${1:-lc-batch}"
shift || true

exec "$DIR/run-harbor.sh" \
  run \
  --dataset "${LATTICE_CODE_HARBOR_DATASET:-terminal-bench/terminal-bench-2-1}" \
  --model "${LATTICE_CODE_HARBOR_MODEL:-deepseek/deepseek-chat}" \
  --n-concurrent "${LATTICE_CODE_HARBOR_CONCURRENT:-4}" \
  --job-name "$NOTE" \
  --yes \
  "$@"
