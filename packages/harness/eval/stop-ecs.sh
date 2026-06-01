#!/usr/bin/env bash
# Stop the Tencent Cloud CVM used for SWE-bench / Terminal-Bench eval.
#
# Usage:
#   ./stop-ecs.sh [--wait] [--force]
#
# Reads from repo .env (or FORGELET_ENV_FILE):
#   TENCENTCLOUD_SECRET_ID, TENCENTCLOUD_SECRET_KEY
#   TENCENT_ECS_REGION, TENCENT_ECS_INSTANCE_ID (or ECS_IP to look up id)
#
# Uses StoppedMode=STOP_CHARGING when supported (pay-as-you-go: stop CPU/RAM billing).
# Requires: pip3 install tccli   (and jq if resolving id from ECS_IP)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ecs-lib.sh
source "$SCRIPT_DIR/ecs-lib.sh"

WAIT=false
STOP_TYPE="SOFT"
for arg in "$@"; do
  case "$arg" in
    --wait) WAIT=true ;;
    --force) STOP_TYPE="HARD" ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "usage: $0 [--wait] [--force]" >&2
      exit 1
      ;;
  esac
done

load_ecs_env
require_tccli
require_tencent_credentials
require_region

INSTANCE_ID="$(resolve_instance_id)"
STATE="$(describe_instance_state "$INSTANCE_ID")"

echo "=== stop ECS ==="
echo "  region:      ${TENCENT_ECS_REGION}"
echo "  instance:    ${INSTANCE_ID}"
echo "  state:       ${STATE}"
echo "  stop_type:   ${STOP_TYPE}"
echo "  billing:     STOP_CHARGING (when instance supports it)"

if [[ "$STATE" == "STOPPED" ]]; then
  echo "Already stopped."
  exit 0
fi

if [[ "$STATE" != "RUNNING" && "$STATE" != "STARTING" ]]; then
  echo "error: cannot stop from state=${STATE}" >&2
  exit 1
fi

if [[ "$STATE" == "STARTING" ]]; then
  echo "Instance is still starting; waiting for RUNNING before stop…"
  wait_for_instance_state "$INSTANCE_ID" "RUNNING" 300
fi

run_tccli cvm StopInstances \
  --region "$TENCENT_ECS_REGION" \
  --InstanceIds "[\"${INSTANCE_ID}\"]" \
  --StopType "$STOP_TYPE" \
  --StoppedMode STOP_CHARGING

echo "StopInstances accepted."

if [[ "$WAIT" == true ]]; then
  echo "Waiting for STOPPED…"
  wait_for_instance_state "$INSTANCE_ID" "STOPPED" 300
  echo "Instance stopped (disk / EIP may still incur charges)."
else
  echo "Poll with: tccli cvm DescribeInstances --region ${TENCENT_ECS_REGION} --InstanceIds '[\"${INSTANCE_ID}\"]'"
  echo "Or re-run: $0 --wait"
fi
