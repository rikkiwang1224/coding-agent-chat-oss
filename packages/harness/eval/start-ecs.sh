#!/usr/bin/env bash
# Start the Tencent Cloud CVM used for SWE-bench / Terminal-Bench eval.
#
# Usage:
#   ./start-ecs.sh [--wait]
#
# Reads from repo .env (or LATTICE_CODE_ENV_FILE):
#   TENCENTCLOUD_SECRET_ID, TENCENTCLOUD_SECRET_KEY
#   TENCENT_ECS_REGION, TENCENT_ECS_INSTANCE_ID (or ECS_IP to look up id)
#
# Requires: pip3 install tccli   (and jq if resolving id from ECS_IP)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ecs-lib.sh
source "$SCRIPT_DIR/ecs-lib.sh"

WAIT=false
for arg in "$@"; do
  case "$arg" in
    --wait) WAIT=true ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "usage: $0 [--wait]" >&2
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

echo "=== start ECS ==="
echo "  region:      ${TENCENT_ECS_REGION}"
echo "  instance:    ${INSTANCE_ID}"
echo "  state:       ${STATE}"

if [[ "$STATE" == "RUNNING" ]]; then
  echo "Already running."
  if [[ -n "${ECS_IP:-}" ]]; then
    echo "  ssh ubuntu@${ECS_IP}"
  fi
  exit 0
fi

if [[ "$STATE" != "STOPPED" && "$STATE" != "STOPPING" ]]; then
  echo "error: cannot start from state=${STATE}" >&2
  exit 1
fi

if [[ "$STATE" == "STOPPING" ]]; then
  echo "Instance is stopping; waiting for STOPPED…"
  wait_for_instance_state "$INSTANCE_ID" "STOPPED" 300
fi

run_tccli cvm StartInstances \
  --region "$TENCENT_ECS_REGION" \
  --InstanceIds "[\"${INSTANCE_ID}\"]"

echo "StartInstances accepted."

if [[ "$WAIT" == true ]]; then
  echo "Waiting for RUNNING…"
  wait_for_instance_state "$INSTANCE_ID" "RUNNING" 300
  echo "Instance is RUNNING."
  if [[ -n "${ECS_IP:-}" ]]; then
    echo "  ssh ubuntu@${ECS_IP}"
  else
    echo "tip: set ECS_IP in .env for a ready-made ssh hint"
  fi
else
  echo "Poll with: tccli cvm DescribeInstances --region ${TENCENT_ECS_REGION} --InstanceIds '[\"${INSTANCE_ID}\"]'"
  echo "Or re-run: $0 --wait"
fi
