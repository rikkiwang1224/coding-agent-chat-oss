# Source from docker-batch.sh / docker-smoke.sh after set -euo pipefail.
# Mounts host codebase-memory-mcp binary + graph cache into SWE instance containers.
#
# Binary resolution (ECS has no GitHub — use prebuilt SWE binary from Mac):
#   1. LATTICE_CODE_CODEBASE_MEMORY_BIN if set
#   2. ~/.local/bin/codebase-memory-mcp-swe  (built via build-codebase-memory-swe.sh)
#   3. ~/.local/bin/codebase-memory-mcp     (local dev / host-only)
#
# Sets:
#   CODE_GRAPH_MOUNT  — docker -v flags (array)
#   CODE_GRAPH_ENV    — docker -e flags (array)
#   CODE_GRAPH_STATUS — human-readable status for batch logs
#   CODE_GRAPH_PATH_PREFIX — PATH prefix inside container (/usr/local/bin:)

SWE_BIN="${HOME}/.local/bin/codebase-memory-mcp-swe"
DEFAULT_BIN="${HOME}/.local/bin/codebase-memory-mcp"
if [[ -n "${LATTICE_CODE_CODEBASE_MEMORY_BIN:-}" ]]; then
  CODEBASE_MEMORY_BIN="$LATTICE_CODE_CODEBASE_MEMORY_BIN"
elif [[ -f "$SWE_BIN" && -x "$SWE_BIN" ]]; then
  CODEBASE_MEMORY_BIN="$SWE_BIN"
else
  CODEBASE_MEMORY_BIN="$DEFAULT_BIN"
fi
CODEBASE_MEMORY_CACHE="${LATTICE_CODE_CODEBASE_MEMORY_CACHE:-$HOME/.cache/codebase-memory-mcp}"

CODE_GRAPH_MOUNT=()
CODE_GRAPH_ENV=()
CODE_GRAPH_STATUS="off"
CODE_GRAPH_PATH_PREFIX=""

if [[ -f "$CODEBASE_MEMORY_BIN" && -x "$CODEBASE_MEMORY_BIN" ]]; then
  mkdir -p "$CODEBASE_MEMORY_CACHE"
  CODE_GRAPH_MOUNT=(
    -v "$CODEBASE_MEMORY_BIN:/usr/local/bin/codebase-memory-mcp:ro"
    -v "$CODEBASE_MEMORY_CACHE:/root/.cache/codebase-memory-mcp"
  )
  CODE_GRAPH_ENV=(
    -e LATTICE_CODE_CODEBASE_MEMORY_BIN=/usr/local/bin/codebase-memory-mcp
    -e HOME=/root
  )
  CODE_GRAPH_STATUS="mcp@$(basename "$CODEBASE_MEMORY_BIN")"
  CODE_GRAPH_PATH_PREFIX="/usr/local/bin:"
else
  echo "WARN: codebase-memory-mcp not found at $CODEBASE_MEMORY_BIN — code graph tools disabled in container" >&2
  echo "  ECS: scp SWE binary from Mac — pnpm --filter @lattice-code/harness build:codebase-memory-swe && sync:codebase-memory-swe" >&2
  echo "  Mac dev: pnpm --filter @lattice-code/harness install:codebase-memory" >&2
fi
