#!/usr/bin/env bash
# ECS → Mac：拉回 Harbor job 目录并生成 pass@1 报告
#
# Usage:
#   ./pull-and-report.sh <job-name> [ecs-host] [ecs-jobs-dir]
#
# Defaults:
#   ecs-host      = $ECS_HOST or ubuntu@$ECS_IP
#   ecs-jobs-dir  = ~/tb-batch/jobs
#
# Local output: ~/.lattice-code/runs/terminal-bench/<job-name>/

set -euo pipefail

JOB_NAME="${1:?usage: $0 <job-name> [ecs-host] [ecs-jobs-dir]}"
ECS_HOST="${2:-${ECS_HOST:-ubuntu@${ECS_IP:?set ECS_IP or pass ecs-host}}}"
ECS_JOBS="${3:-${ECS_TB_JOBS:-~/tb-batch/jobs}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="$HOME/.lattice-code/runs/terminal-bench/$JOB_NAME"
mkdir -p "$LOCAL_DIR"

echo "=== rsync ${ECS_HOST}:${ECS_JOBS}/${JOB_NAME}/ → ${LOCAL_DIR}/ ==="
rsync -avz --delete-after \
  "${ECS_HOST}:${ECS_JOBS}/${JOB_NAME}/" \
  "${LOCAL_DIR}/"

echo ""
python3 "$SCRIPT_DIR/tb-report.py" "$LOCAL_DIR"

echo ""
echo "Local artifacts: $LOCAL_DIR"
