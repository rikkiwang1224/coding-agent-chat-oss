#!/usr/bin/env bash
# Download Terminal-Bench task definitions via Harbor (optional prefetch).
#
# Usage:
#   ./fetch-tasks.sh [output_dir]

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HOME/.lattice-code/terminal-bench/tasks}"
DATASET="${LATTICE_CODE_HARBOR_DATASET:-terminal-bench/terminal-bench-2-1}"

if [ ! -x "$DIR/.venv/bin/harbor" ]; then
  echo "Run ./setup.sh first" >&2
  exit 1
fi

mkdir -p "$OUT"
echo "Fetching $DATASET → $OUT"
# Harbor CLI surface evolves; try common subcommands.
if "$DIR/.venv/bin/harbor" datasets download --help >/dev/null 2>&1; then
  exec "$DIR/.venv/bin/harbor" datasets download "$DATASET" -o "$OUT"
fi

echo "harbor datasets download not available in this Harbor version."
echo "Tasks are pulled automatically on first harbor run --dataset $DATASET"
exit 0
