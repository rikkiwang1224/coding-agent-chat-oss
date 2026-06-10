#!/usr/bin/env bash
# Single-instance smoke test of the Lattice Code agent inside a SWE-bench
# instance Docker image. Use this to debug one task interactively (full
# stdout streamed) before running docker-batch.sh over many instances.
#
# Usage:
#   docker-smoke.sh <instance_id> [instances.json]
#
# Trace (root-cause debugging — do NOT use for batch scoring):
#   LATTICE_CODE_SAVE_TRACE=1 LATTICE_CODE_TRACE_RUN_ID=my-debug-a1 docker-smoke.sh <id>
#   Writes ~/.lattice-code/traces/swe-bench/eval-<runId>/instances/<id>.jsonl on the host.
#   Batch runs default trace ON; smoke stays --no-trace unless LATTICE_CODE_SAVE_TRACE=1.
#
# Defaults instances.json to ~/swe-batch/instances.json. The agent is given
# the `problem_statement` field as its prompt and runs against /testbed
# inside the container with the `testbed` conda env activated.
#
# Prereqs on the host (typically the ECS box):
#   - $HOME/node-prebuilt/node-v20/bin/node   (Node 20 standalone)
#   - $HOME/coding-agent-chat-oss              (Lattice Code source w/ deps + built dist)
#   - $HOME/coding-agent-chat-oss/.env         (DEEPSEEK_API_KEY=...)
#   - docker, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docker-codegraph-mounts.sh
source "$SCRIPT_DIR/docker-codegraph-mounts.sh"

INSTANCE_ID="${1:?usage: $0 <instance_id> [instances.json]}"
INSTANCES_JSON="${2:-$HOME/swe-batch/instances.json}"
SAVE_TRACE="${LATTICE_CODE_SAVE_TRACE:-0}"
TRACE_RUN_ID="${LATTICE_CODE_TRACE_RUN_ID:-docker-smoke-${INSTANCE_ID}}"
LATTICE_CODE_HOME="${LATTICE_CODE_HOME:-$HOME/.lattice-code}"
TRACE_FLAG="--no-trace"
TRACE_MOUNT=()
if [[ "$SAVE_TRACE" == "1" || "$SAVE_TRACE" == "true" || "$SAVE_TRACE" == "on" ]]; then
  TRACE_FLAG=""
  mkdir -p "$LATTICE_CODE_HOME/traces/swe-bench"
  TRACE_MOUNT=(-v "$LATTICE_CODE_HOME/traces:/root/.lattice-code/traces")
  echo "=== trace: ON → /root/.lattice-code/traces/swe-bench/eval-${TRACE_RUN_ID}/instances/${INSTANCE_ID}.jsonl ==="
else
  echo "=== trace: OFF (--no-trace; set LATTICE_CODE_SAVE_TRACE=1 to enable JSONL) ==="
fi

# SWE-bench image name = swebench/sweb.eval.x86_64.<id_lower with __ → _1776_>:latest
# (1776 is the literal magic number used in upstream swebench/harness/test_spec.py)
lower="${INSTANCE_ID,,}"
IMG="swebench/sweb.eval.x86_64.${lower//__/_1776_}:latest"

WORK="$HOME/.lattice-code/runs/docker-smoke/$INSTANCE_ID"
mkdir -p "$WORK"

[ -f "$INSTANCES_JSON" ] || { echo "Missing $INSTANCES_JSON" >&2; exit 1; }
jq -er --arg id "$INSTANCE_ID" \
  '(if type=="array" then map(select(.instance_id==$id))[0] else . end)' \
  "$INSTANCES_JSON" > "$WORK/instance.json" \
  || { echo "instance_id $INSTANCE_ID not found in $INSTANCES_JSON" >&2; exit 1; }

echo "=== instance: $INSTANCE_ID ==="
echo "=== image:    $IMG ==="
echo "=== work:     $WORK ==="
echo "=== instance chars: $(wc -c < "$WORK/instance.json") ==="

if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "=== pulling image (this may take 1-3 min) ==="
  docker pull "$IMG"
fi

START=$(date +%s)
echo "=== code_graph: $CODE_GRAPH_STATUS ==="
docker run --rm \
  --network host \
  -v "$HOME/node-prebuilt/node-v20:/opt/node:ro" \
  -v "$HOME/coding-agent-chat-oss:/lattice-code:ro" \
  -v "$WORK:/work" \
  "${TRACE_MOUNT[@]}" \
  "${CODE_GRAPH_MOUNT[@]}" \
  --env-file "$HOME/coding-agent-chat-oss/.env" \
  -e SWE_INSTANCE_ID="$INSTANCE_ID" \
  -e LATTICE_CODE_TRACE_RUN_ID="$TRACE_RUN_ID" \
  -e LATTICE_CODE_HOME=/root/.lattice-code \
  "${CODE_GRAPH_ENV[@]}" \
  "$IMG" \
  bash -lc "
    set -e
    export PATH=${CODE_GRAPH_PATH_PREFIX}/opt/node/bin:\$PATH
    source /opt/miniconda3/etc/profile.d/conda.sh
    conda activate testbed
    echo '[env] python: '\$(python --version)' | which: '\$(which python)
    echo '[env] pytest: '\$(pytest --version 2>&1 | head -1)
    cd /testbed
    echo '=== container ready, agent starting ==='
    timeout 600 node /lattice-code/node_modules/tsx/dist/cli.mjs \
      /lattice-code/packages/harness/eval/swe-bench/docker-agent.ts \
      --workspace /testbed \
      --instance /work/instance.json \
      --patch-out /work/agent.patch \
      ${TRACE_FLAG} \
      2>&1 | tee /work/agent.log || echo "agent exit=$?"
    echo \"patch_lines=\$(wc -l < /work/agent.patch)\"
    head -200 /work/agent.patch
  "

echo "=== total elapsed: $(($(date +%s) - START))s ==="
ls -lh "$WORK"
if [[ -z "$TRACE_FLAG" ]]; then
  TRACE_FILE="$LATTICE_CODE_HOME/traces/swe-bench/eval-${TRACE_RUN_ID}/instances/${INSTANCE_ID}.jsonl"
  if [[ -f "$TRACE_FILE" ]]; then
    echo "=== trace file: $TRACE_FILE ($(wc -l < "$TRACE_FILE") events) ==="
  else
    echo "=== warn: trace expected at $TRACE_FILE but missing ==="
  fi
fi
