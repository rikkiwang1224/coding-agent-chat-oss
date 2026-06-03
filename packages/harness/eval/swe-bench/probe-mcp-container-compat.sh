#!/usr/bin/env bash
# Probe whether a codebase-memory-mcp binary runs inside a SWE-bench container.
# No GitHub required — pass a local/host binary path.
#
# Usage:
#   bash probe-mcp-container-compat.sh ~/.local/bin/codebase-memory-mcp-swe
#   bash probe-mcp-container-compat.sh packages/harness/eval/swe-bench/bin/codebase-memory-mcp-swe-linux-amd64

set -euo pipefail

BIN="${1:?usage: $0 <path-to-codebase-memory-mcp-binary>}"
IMG="${2:-swebench/sweb.eval.x86_64.matplotlib_1776_matplotlib-23476:latest}"

if [[ ! -x "$BIN" ]]; then
  echo "Not executable: $BIN" >&2
  exit 1
fi

echo "=== binary: $BIN ==="
echo "=== image:  $IMG ==="
docker run --rm -v "$(realpath "$BIN"):/usr/local/bin/codebase-memory-mcp:ro" "$IMG" \
  /usr/local/bin/codebase-memory-mcp --version
