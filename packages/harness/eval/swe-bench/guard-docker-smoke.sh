#!/usr/bin/env bash
# Run guard-smoke.ts inside a SWE-bench Docker image (same node/tsx path as docker-agent).
# Verifies tool + patch guards work in the container environment without calling the LLM.
#
# Usage (ECS host):
#   bash guard-docker-smoke.sh [instance_id]
#
# Default instance_id: django__django-10914 (small, commonly cached)

set -euo pipefail

INSTANCE_ID="${1:-django__django-10914}"
lower="${INSTANCE_ID,,}"
IMG="swebench/sweb.eval.x86_64.${lower//__/_1776_}:latest"

echo "=== guard-docker-smoke ==="
echo "instance: $INSTANCE_ID"
echo "image:    $IMG"

if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "→ pulling image..."
  docker pull "$IMG"
fi

docker run --rm \
  -v "$HOME/node-prebuilt/node-v20:/opt/node:ro" \
  -v "$HOME/coding-agent-chat-oss:/lattice-code:ro" \
  "$IMG" \
  bash -lc "
    set -e
    export PATH=/opt/node/bin:\$PATH
    source /opt/miniconda3/etc/profile.d/conda.sh
    conda activate testbed
    cd /testbed
    node /lattice-code/node_modules/tsx/dist/cli.mjs \
      /lattice-code/packages/harness/eval/swe-bench/guard-smoke.ts
  "

echo "=== guard-docker-smoke passed ==="
