#!/usr/bin/env bash
# Run official SWE-bench eval on ECS with Lattice Code fixes (proxy + sphinx pins).
#
# Usage:
#   bash run-eval-ecs.sh <predictions.jsonl> <run_id> [instance_id ...]
#
# Examples:
#   bash run-eval-ecs.sh ~/swe-batch/lite-86/predictions.jsonl lite-86-eval-v2
#   bash run-eval-ecs.sh /tmp/gold.jsonl gold-check psf__requests-2148 sphinx-doc__sphinx-8595
#
# Env:
#   SWEB_PYTHON          default ~/sweb-venv/bin/python
#   ECS_EVAL_PROXY       default http://127.0.0.1:7890 (Mac pproxy via ssh -R)
#   SKIP_ECS_PREFLIGHT=1 skip ecs-preflight.sh
#   MAX_WORKERS          default 4 (or 1 when instance ids passed)
#   HF_HUB_OFFLINE=1     set automatically when proxy is up

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ecs-common.sh
source "$SCRIPT_DIR/ecs-common.sh"

PRED="${1:?usage: $0 <predictions.jsonl> <run_id> [instance_id ...]}"
RUN_ID="${2:?usage: $0 <predictions.jsonl> <run_id> [instance_id ...]}"
shift 2
IDS=("$@")

SWEB="${SWEB_PYTHON:-$HOME/sweb-venv/bin/python}"
LATTICE_CODE_EVAL="$SCRIPT_DIR/lattice_code_run_evaluation.py"
MAX_WORKERS="${MAX_WORKERS:-$([[ ${#IDS[@]} -gt 0 ]] && echo 1 || echo 4)}"

[[ -f "$PRED" ]] || { echo "missing predictions: $PRED" >&2; exit 1; }
[[ -x "$SWEB" ]] || { echo "missing sweb-venv: $SWEB" >&2; exit 1; }
[[ -f "$LATTICE_CODE_EVAL" ]] || { echo "missing $LATTICE_CODE_EVAL" >&2; exit 1; }

if [[ "${SKIP_ECS_PREFLIGHT:-0}" != "1" ]]; then
  bash "$SCRIPT_DIR/ecs-preflight.sh" || {
    echo "Preflight failed. Start Mac tunnel or SKIP_ECS_PREFLIGHT=1 to force." >&2
    exit 1
  }
fi

HF_OFFLINE=()
PROXY_ENV=()
if [[ "${FORCE_ECS_EVAL_PROXY:-0}" == "1" ]] || curl -sf --max-time 5 --proxy "$ECS_EVAL_PROXY" -o /dev/null \
  https://raw.githubusercontent.com/github/gitignore/main/README.md 2>/dev/null; then
  HF_OFFLINE=(HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1)
  ecs_export_eval_proxy
  PROXY_ENV=(http_proxy="$ECS_EVAL_PROXY" https_proxy="$ECS_EVAL_PROXY"
    HTTP_PROXY="$ECS_EVAL_PROXY" HTTPS_PROXY="$ECS_EVAL_PROXY"
    NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,mirror.ccs.tencentyun.com}")
  echo "=== proxy OK — using HF offline cache ==="
else
  echo "=== warn: proxy down — eval runs without proxy (HF cache must be warm) ==="
fi

rm -rf "$HOME/logs/run_evaluation/$RUN_ID" "$SCRIPT_DIR/logs/run_evaluation/$RUN_ID"

CMD=(
  "$SWEB" "$LATTICE_CODE_EVAL"
  --predictions_path "$PRED"
  --dataset_name SWE-bench/SWE-bench_Lite
  --run_id "$RUN_ID"
  --max_workers "$MAX_WORKERS"
  --cache_level env
  --report_dir "$HOME"
)
if [[ ${#IDS[@]} -gt 0 ]]; then
  CMD+=(--instance_ids "${IDS[@]}")
fi

echo "=== run-eval-ecs: run_id=$RUN_ID predictions=$PRED workers=$MAX_WORKERS ==="
echo "    proxy=$ECS_EVAL_PROXY  instances=${IDS[*]:-(all in predictions)}"
echo ""

env "${PROXY_ENV[@]}" "${HF_OFFLINE[@]}" "${CMD[@]}"

REPORT_GLOB="$HOME/"*".${RUN_ID}.json"
LOG_DIR="$SCRIPT_DIR/logs/run_evaluation/$RUN_ID"
echo ""
echo "=== done ==="
ls -la $REPORT_GLOB 2>/dev/null || true
find "$LOG_DIR" -name report.json 2>/dev/null | wc -l | xargs -I{} echo "per-instance reports: {}"
