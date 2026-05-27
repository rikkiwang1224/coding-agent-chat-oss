#!/usr/bin/env bash
# Single-instance smoke test of the Forgelet agent inside a SWE-bench
# instance Docker image. Use this to debug one task interactively (full
# stdout streamed) before running docker-batch.sh over many instances.
#
# Usage:
#   docker-smoke.sh <instance_id> [instances.json]
#
# Defaults instances.json to ~/swe-batch/instances.json. The agent is given
# the `problem_statement` field as its prompt and runs against /testbed
# inside the container with the `testbed` conda env activated.
#
# Prereqs on the host (typically the ECS box):
#   - $HOME/node-prebuilt/node-v20/bin/node   (Node 20 standalone)
#   - $HOME/coding-agent-chat-oss              (Forgelet source w/ deps + built dist)
#   - $HOME/coding-agent-chat-oss/.env         (DEEPSEEK_API_KEY=...)
#   - docker, jq

set -euo pipefail

INSTANCE_ID="${1:?usage: $0 <instance_id> [instances.json]}"
INSTANCES_JSON="${2:-$HOME/swe-batch/instances.json}"

# SWE-bench image name = swebench/sweb.eval.x86_64.<id_lower with __ → _1776_>:latest
# (1776 is the literal magic number used in upstream swebench/harness/test_spec.py)
lower="${INSTANCE_ID,,}"
IMG="swebench/sweb.eval.x86_64.${lower//__/_1776_}:latest"

WORK="$HOME/.forgelet/runs/docker-smoke/$INSTANCE_ID"
mkdir -p "$WORK"

[ -f "$INSTANCES_JSON" ] || { echo "Missing $INSTANCES_JSON" >&2; exit 1; }
jq -er --arg id "$INSTANCE_ID" \
  '(if type=="array" then map(select(.instance_id==$id))[0] else . end).problem_statement' \
  "$INSTANCES_JSON" > "$WORK/prompt.txt" \
  || { echo "instance_id $INSTANCE_ID not found in $INSTANCES_JSON" >&2; exit 1; }

echo "=== instance: $INSTANCE_ID ==="
echo "=== image:    $IMG ==="
echo "=== work:     $WORK ==="
echo "=== prompt chars: $(wc -c < "$WORK/prompt.txt") ==="

if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "=== pulling image (this may take 1-3 min) ==="
  docker pull "$IMG"
fi

START=$(date +%s)
docker run --rm \
  --network host \
  -v "$HOME/node-prebuilt/node-v20:/opt/node:ro" \
  -v "$HOME/coding-agent-chat-oss:/forgelet:ro" \
  -v "$WORK:/work" \
  --env-file "$HOME/coding-agent-chat-oss/.env" \
  -e SWE_INSTANCE_ID="$INSTANCE_ID" \
  "$IMG" \
  bash -lc '
    set -e
    export PATH=/opt/node/bin:$PATH
    source /opt/miniconda3/etc/profile.d/conda.sh
    conda activate testbed
    echo "[env] python: $(python --version) | which: $(which python)"
    echo "[env] pytest: $(pytest --version 2>&1 | head -1)"
    cd /testbed
    PROMPT="$(cat /work/prompt.txt)"
    echo "=== container ready, agent starting ==="
    timeout 600 node /forgelet/node_modules/tsx/dist/cli.mjs /forgelet/apps/cli/src/main.ts \
      -c /testbed -y --no-trace "$PROMPT" 2>&1 | tee /work/agent.log || echo "agent exit=$?"
    echo "=== capturing patch ==="
    cd /testbed && git diff > /work/agent.patch
    echo "patch_lines=$(wc -l < /work/agent.patch)"
    head -200 /work/agent.patch
  '

echo "=== total elapsed: $(($(date +%s) - START))s ==="
ls -lh "$WORK"
