#!/usr/bin/env bash
# Print scp + cloud evaluate commands. Usage: ./print-cloud-commands.sh <run-id> <ecs-ip> [max-workers]
set -euo pipefail

RUN_ID="${1:?run-id required}"
ECS_IP="${2:?ecs public IP required}"
WORKERS="${3:-1}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PRED="$ROOT/packages/harness/eval/swe-bench/runs/eval-${RUN_ID}/predictions.jsonl"

cat <<EOF
# --- Mac: upload predictions ---
scp "${PRED}" ubuntu@${ECS_IP}:~/forgelet-eval/predictions.jsonl

# --- Mac: keep these running in separate terminals ---
# python3 -m pproxy -l http://127.0.0.1:7890
# ssh -N -o ServerAliveInterval=60 -R 7890:127.0.0.1:7890 ubuntu@${ECS_IP}

# --- Cloud ECS ---
export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,mirror.ccs.tencentyun.com
export HF_HOME=\$HOME/.cache/huggingface HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1
cd ~/forgelet-eval && export SWEBENCH_PYTHON=\$HOME/forgelet-eval/.venv/bin/python
bash evaluate.sh ~/forgelet-eval/predictions.jsonl SWE-bench/SWE-bench_Lite ${RUN_ID} ${WORKERS}

# Results: ~/forgelet-eval/evaluation_results/${RUN_ID}/results.json
EOF
