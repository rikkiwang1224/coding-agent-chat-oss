#!/usr/bin/env bash
# Download codebase-memory-mcp source tarball on Mac (GitHub OK). ECS cannot clone GitHub.
#
# Usage:
#   bash fetch-codebase-memory-source.sh
#   CBM_TAG=v0.7.0 bash fetch-codebase-memory-source.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CBM_TAG="${CBM_TAG:-v0.7.0}"
VENDOR="$SCRIPT_DIR/vendor"
mkdir -p "$VENDOR"

ARCHIVE="$VENDOR/codebase-memory-mcp-${CBM_TAG}.tar.gz"
URL="https://github.com/DeusData/codebase-memory-mcp/archive/refs/tags/${CBM_TAG}.tar.gz"

echo "=== download $CBM_TAG → $ARCHIVE ==="
curl -fSL --retry 3 -o "$ARCHIVE" "$URL"
echo "OK: $(ls -lh "$ARCHIVE" | awk '{print $5, $9}')"
