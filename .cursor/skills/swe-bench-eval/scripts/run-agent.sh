#!/usr/bin/env bash
# Run SWE-bench agent phase from repo root. Usage: ./run-agent.sh -- --dataset lite --limit 3 --skip-eval --run-id my-run
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "Error: DEEPSEEK_API_KEY not set. Add to .env or export." >&2
  exit 1
fi

SWE_DIR="$ROOT/packages/harness/eval/swe-bench"
export SWEBENCH_PYTHON="${SWEBENCH_PYTHON:-$SWE_DIR/.venv/bin/python}"

if [[ ! -x "$SWEBENCH_PYTHON" ]]; then
  echo "Python venv missing. Run: pnpm --filter @forgelet/harness eval:swe:setup" >&2
  exit 1
fi

exec pnpm --filter @forgelet/harness eval:swe -- "$@"
