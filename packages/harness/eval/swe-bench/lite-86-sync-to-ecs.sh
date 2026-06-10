#!/usr/bin/env bash
# Mac ONLY → rsync code / .env / lite-full to ECS, then remote build.
# Patch generation does NOT run on Mac — after sync, SSH to ECS and run
# lite-86-run-parallel.sh start-local (see WORKFLOW.md).
#
# Usage (Mac):
#   export ECS_IP=111.230.49.4
#   bash lite-86-sync-to-ecs.sh
#
# Then on ECS:
#   cd ~/coding-agent-chat-oss/packages/harness/eval/swe-bench
#   nohup bash lite-86-run-parallel.sh start-local \
#     > ~/swe-batch/lite-86-run/launcher.log 2>&1 &
#   bash lite-86-monitor.sh watch-local
#
# Options:
#   --full-install   on ECS run `pnpm install` before build (slow; first-time / lockfile change)
#   --skip-build     rsync only (no remote pnpm build)
#   --skip-mcp       skip codebase-memory-swe binary scp
#
# Env:
#   ECS_HOST              default ubuntu@${ECS_IP}
#   ECS_REPO_DIR          default ~/coding-agent-chat-oss
#   LATTICE_CODE_ENV_FILE     explicit .env path

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/../../../.." && pwd)"

FULL_INSTALL=false
SKIP_BUILD=false
SKIP_MCP=false
for arg in "$@"; do
  case "$arg" in
    --full-install) FULL_INSTALL=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --skip-mcp) SKIP_MCP=true ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

ECS_IP="${ECS_IP:?set ECS_IP}"
ECS_USER="${ECS_USER:-ubuntu}"
ECS_HOST="${ECS_HOST:-${ECS_USER}@${ECS_IP}}"
ECS_REPO_DIR="${ECS_REPO_DIR:-~/coding-agent-chat-oss}"

resolve_env_file() {
  if [[ -n "${LATTICE_CODE_ENV_FILE:-}" && -f "${LATTICE_CODE_ENV_FILE}" ]]; then
    echo "${LATTICE_CODE_ENV_FILE}"
    return 0
  fi
  if [[ -f "$REPO_ROOT/.env" ]]; then
    echo "$REPO_ROOT/.env"
    return 0
  fi
  return 1
}

echo "=== sync repo → ${ECS_HOST}:${ECS_REPO_DIR} ==="
ssh "$ECS_HOST" "mkdir -p ${ECS_REPO_DIR} ~/swe-batch/lite-full ~/.local/bin ~/.cache/codebase-memory-mcp"
rsync -avz \
  --exclude node_modules \
  --exclude .git \
  --exclude 'apps/chat-desktop' \
  --exclude 'packages/harness/eval/swe-bench/.venv' \
  --exclude 'packages/harness/eval/terminal-bench/.venv' \
  "$REPO_ROOT/" "${ECS_HOST}:${ECS_REPO_DIR}/"

LITE_FULL="${LITE_FULL:-$HOME/.lattice-code/runs/swe-bench/lite-full/instances.json}"
if [[ -f "$LITE_FULL" ]]; then
  echo "=== sync lite-full instances.json ==="
  rsync -avz "$LITE_FULL" "${ECS_HOST}:~/swe-batch/lite-full/instances.json"
else
  echo "warn: $LITE_FULL not found — buckets will fetch from HuggingFace on ECS (needs proxy)" >&2
fi

if ENV_FILE="$(resolve_env_file)"; then
  echo "=== scp .env ==="
  scp "$ENV_FILE" "${ECS_HOST}:${ECS_REPO_DIR}/.env"
else
  echo "warn: no .env — ensure DEEPSEEK_API_KEY on ECS" >&2
fi

if [[ "$SKIP_MCP" != true ]]; then
  MCP_BIN="$DIR/bin/codebase-memory-mcp-swe-linux-amd64"
  if [[ -x "$MCP_BIN" ]]; then
    echo "=== scp codebase-memory-swe binary ==="
    scp "$MCP_BIN" "${ECS_HOST}:~/.local/bin/codebase-memory-mcp-swe"
    ssh "$ECS_HOST" "chmod +x ~/.local/bin/codebase-memory-mcp-swe"
  else
    echo "warn: $MCP_BIN missing — run: pnpm --filter @lattice-code/harness build:codebase-memory-swe" >&2
  fi
fi

if [[ "$SKIP_BUILD" != true ]]; then
  echo "=== build on ECS ==="
  INSTALL_CMD=""
  if [[ "$FULL_INSTALL" == true ]]; then
    INSTALL_CMD="ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install &&"
  fi
  ssh "$ECS_HOST" "cd ${ECS_REPO_DIR} && \
    ${INSTALL_CMD} \
    pnpm --filter @lattice-code/sdk-runtime build && \
    pnpm --filter @lattice-code/harness build"
fi

echo ""
echo "=== sync done ==="
echo "Next (on ECS, not Mac):"
echo "  ssh ubuntu@\${ECS_IP}"
echo "  cd ~/coding-agent-chat-oss/packages/harness/eval/swe-bench"
echo "  nohup bash lite-86-run-parallel.sh start-local > ~/swe-batch/lite-86-run/launcher.log 2>&1 &"
echo "  bash lite-86-monitor.sh watch-local"
