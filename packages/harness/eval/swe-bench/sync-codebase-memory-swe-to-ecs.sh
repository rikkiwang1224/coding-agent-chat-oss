#!/usr/bin/env bash
# Copy SWE-compatible codebase-memory-mcp binary to ECS (no GitHub on ECS).
#
# Usage:
#   export ECS_IP=111.230.202.243
#   bash packages/harness/eval/swe-bench/sync-codebase-memory-swe-to-ecs.sh
#
# Prereq: run build-codebase-memory-swe.sh on Mac first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/bin/codebase-memory-mcp-swe-linux-amd64"
ECS_HOST="${ECS_HOST:-ubuntu@${ECS_IP:?set ECS_IP or ECS_HOST}}"
REMOTE="${REMOTE_BIN:-~/.local/bin/codebase-memory-mcp-swe}"

if [[ ! -x "$BIN" ]]; then
  echo "Missing $BIN — run build-codebase-memory-swe.sh on Mac first" >&2
  exit 1
fi

echo "=== scp $BIN → ${ECS_HOST}:${REMOTE} ==="
ssh "$ECS_HOST" "mkdir -p ~/.local/bin ~/.cache/codebase-memory-mcp"
scp "$BIN" "${ECS_HOST}:${REMOTE}"
ssh "$ECS_HOST" "chmod +x ${REMOTE} && ${REMOTE} --version 2>&1 | head -2"

echo ""
echo "=== probe inside SWE container on ECS ==="
ssh "$ECS_HOST" "docker run --rm -v ${REMOTE}:/usr/local/bin/codebase-memory-mcp:ro \
  swebench/sweb.eval.x86_64.matplotlib_1776_matplotlib-23476:latest \
  /usr/local/bin/codebase-memory-mcp --version 2>&1 | head -3"

echo ""
echo "OK. docker-batch will prefer ${REMOTE} automatically."
