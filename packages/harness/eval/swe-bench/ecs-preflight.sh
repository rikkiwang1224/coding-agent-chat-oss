#!/usr/bin/env bash
# ECS preflight before SWE-bench official eval. Run ON the ECS host.
#
# Usage:
#   bash ecs-preflight.sh
#   ECS_EVAL_PROXY=http://127.0.0.1:7890 bash ecs-preflight.sh
#
# Checks:
#   - Docker bridge egress (httpbin)
#   - Mac pproxy tunnel (GitHub raw) when proxy expected
#   - sweb-venv + forgelet eval wrapper present

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ecs-common.sh
source "$SCRIPT_DIR/ecs-common.sh"

FAIL=0
pass() { echo "  ✓ $*"; }
warn() { echo "  ⚠ $*"; FAIL=1; }
fail() { echo "  ✗ $*"; FAIL=1; }

echo "═══════════════════════════════════════════════════════════"
echo " ECS SWE-bench eval preflight  $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════════════"

echo ""
echo "── host egress ──"
if curl -sf --max-time 8 -o /dev/null https://httpbin.org/get; then
  pass "host → httpbin.org"
else
  echo "  ⚠ host cannot reach httpbin.org (requests eval tests may flake — not blocking)"
fi

echo ""
echo "── docker bridge egress ──"
BRIDGE_CODE=$(docker run --rm curlimages/curl:8.5.0 \
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://httpbin.org/get 2>/dev/null || echo "000")
if [[ "$BRIDGE_CODE" == "200" ]]; then
  pass "bridge container → httpbin.org ($BRIDGE_CODE)"
else
  echo "  ⚠ bridge container → httpbin.org failed ($BRIDGE_CODE) — requests instances may flake"
fi

echo ""
echo "── eval proxy tunnel ($ECS_EVAL_PROXY) ──"
PROXY_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
  --proxy "$ECS_EVAL_PROXY" https://raw.githubusercontent.com/github/gitignore/main/README.md 2>/dev/null || echo "000")
if [[ "$PROXY_CODE" == "200" ]]; then
  pass "ECS → GitHub via proxy ($PROXY_CODE)"
else
  echo "  ⚠ GitHub via $ECS_EVAL_PROXY failed ($PROXY_CODE) — start Mac tunnel before batch eval"
  echo "      Fix: on Mac run  bash $SCRIPT_DIR/start-mac-tunnel.sh"
  echo "      (pproxy :7890 + ssh -R 7890:127.0.0.1:7890 ubuntu@\$ECS_IP)"
fi

echo ""
echo "── harness ──"
SWEB="${SWEB_PYTHON:-$HOME/sweb-venv/bin/python}"
if [[ -x "$SWEB" ]]; then
  pass "sweb-venv python: $SWEB"
else
  fail "missing $SWEB — python3 -m venv ~/sweb-venv && pip install swebench datasets huggingface_hub"
fi
if [[ -f "$SCRIPT_DIR/forgelet_run_evaluation.py" ]]; then
  pass "forgelet_run_evaluation.py (sphinx eval pins)"
else
  fail "missing forgelet_run_evaluation.py"
fi

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "Preflight OK — safe to run: bash run-eval-ecs.sh ..."
  exit 0
fi
echo "Preflight FAILED — fix warnings above before batch eval"
exit 1
