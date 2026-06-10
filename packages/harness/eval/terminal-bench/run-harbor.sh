#!/usr/bin/env bash
# Run Terminal-Bench via Harbor with the Lattice Code agent adapter.
#
# Usage:
#   ./run-harbor.sh [harbor run args...]
#
# Examples:
#   ./run-harbor.sh --dataset terminal-bench/terminal-bench-2-1 --include-task-name terminal-bench/adaptive-rejection-sampler
#   ./run-harbor.sh --dataset terminal-bench/terminal-bench-2-1 --n-concurrent 4
#
# Prereqs:
#   ./setup.sh && ./prepare-lattice-code.sh
#   export DEEPSEEK_API_KEY=...   (or provider key for --model)
#   export LATTICE_CODE_ROOT=~/.lattice-code/tb-lattice-code-staging

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ ! -x ".venv/bin/harbor" ]; then
  echo "Run ./setup.sh first" >&2
  exit 1
fi

if [ -z "${LATTICE_CODE_ROOT:-}" ]; then
  DEFAULT="$HOME/.lattice-code/tb-lattice-code-staging"
  if [ -d "$DEFAULT/node_modules/tsx" ]; then
    export LATTICE_CODE_ROOT="$DEFAULT"
    echo "Using LATTICE_CODE_ROOT=$LATTICE_CODE_ROOT"
  else
    echo "Error: LATTICE_CODE_ROOT unset. Run ./prepare-lattice-code.sh first." >&2
    exit 1
  fi
fi

MODEL="${LATTICE_CODE_HARBOR_MODEL:-deepseek/deepseek-chat}"
N_CONCURRENT="${LATTICE_CODE_HARBOR_CONCURRENT:-4}"
DATASET="${LATTICE_CODE_HARBOR_DATASET:-terminal-bench/terminal-bench-2-1}"
# Harbor 0.9+ removed --timeout (seconds). Use multipliers or task.toml defaults.
AGENT_TIMEOUT_MULTIPLIER="${LATTICE_CODE_HARBOR_AGENT_TIMEOUT_MULTIPLIER:-}"

AGENT_IMPORT="lattice_code_agent:LatticeCodeAgent"
export PYTHONPATH="$DIR${PYTHONPATH:+:$PYTHONPATH}"

ARGS=()
if [ "$#" -eq 0 ]; then
  ARGS=(
    run
    --dataset "$DATASET"
    --agent-import-path "$AGENT_IMPORT"
    --model "$MODEL"
    --n-concurrent "$N_CONCURRENT"
    --yes
  )
  if [ -n "$AGENT_TIMEOUT_MULTIPLIER" ]; then
    ARGS+=(--agent-timeout-multiplier "$AGENT_TIMEOUT_MULTIPLIER")
  fi
else
  ARGS=("$@")
  # Ensure import path is set when caller passes partial args
  has_import=0
  for a in "${ARGS[@]}"; do
    if [ "$a" = "--agent-import-path" ]; then has_import=1; fi
  done
  if [ "$has_import" -eq 0 ]; then
    ARGS+=(--agent-import-path "$AGENT_IMPORT")
  fi
fi

echo "=== harbor ${ARGS[*]} ==="
exec .venv/bin/harbor "${ARGS[@]}"
