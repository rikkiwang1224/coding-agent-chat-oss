#!/usr/bin/env bash
# Build SWE-compatible codebase-memory-mcp ON ECS (Mac without Docker).
#
# Mac has GitHub; ECS has Docker but not GitHub. Flow:
#   1. fetch-codebase-memory-source.sh  (Mac)
#   2. this script                      (Mac → scp tarball → ECS docker ubuntu:20.04 build)
#
# Usage:
#   export ECS_IP=111.230.202.243
#   bash fetch-codebase-memory-source.sh
#   bash build-codebase-memory-swe-on-ecs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CBM_TAG="${CBM_TAG:-v0.7.0}"
ARCHIVE="$SCRIPT_DIR/vendor/codebase-memory-mcp-${CBM_TAG}.tar.gz"
ECS_HOST="${ECS_HOST:-ubuntu@${ECS_IP:?set ECS_IP or ECS_HOST}}"
REMOTE_BIN="${REMOTE_BIN:-~/.local/bin/codebase-memory-mcp-swe}"
BUILD_IMAGE="${BUILD_IMAGE:-ubuntu:20.04}"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Missing $ARCHIVE — run fetch-codebase-memory-source.sh first" >&2
  exit 1
fi

REMOTE_WORK="/tmp/cbm-build-$$"
echo "=== scp source → ${ECS_HOST}:${REMOTE_WORK} ==="
ssh "$ECS_HOST" "mkdir -p $REMOTE_WORK/out"
scp "$ARCHIVE" "${ECS_HOST}:${REMOTE_WORK}/source.tar.gz"

echo "=== build inside ${BUILD_IMAGE} on ECS ==="
# Pass args to avoid nested heredoc / quote expansion bugs.
ssh "$ECS_HOST" bash -s -- "$REMOTE_WORK" "$CBM_TAG" "$BUILD_IMAGE" <<'REMOTE'
set -euo pipefail
WORK="$1"
TAG="$2"
IMAGE="$3"
mkdir -p "$HOME/.local/bin"

docker run --rm \
  -e "CBM_TAG=$TAG" \
  -v "$WORK:/work" \
  -v "$HOME/.local/bin:/out" \
  "$IMAGE" \
  bash -c 'set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential ca-certificates zlib1g-dev >/dev/null
cd /work
tar xzf source.tar.gz
SRC=$(find . -maxdepth 1 -type d -name "codebase-memory-mcp*" | head -1)
[[ -n "$SRC" ]] || { echo "source dir not found after extract" >&2; exit 1; }
cd "$SRC"
# Ubuntu 20.04 link: vendored sqlite3 needs libdl (not in upstream Makefile LDFLAGS).
sed -i "s/-lpthread -lz/-lpthread -lz -ldl/g" Makefile.cbm 2>/dev/null || true
scripts/build.sh --version "$CBM_TAG"
cp build/c/codebase-memory-mcp /out/codebase-memory-mcp-swe'

chmod +x "$HOME/.local/bin/codebase-memory-mcp-swe"
"$HOME/.local/bin/codebase-memory-mcp-swe" --version 2>&1 | head -2

echo "=== probe SWE container ==="
docker run --rm \
  -v "$HOME/.local/bin/codebase-memory-mcp-swe:/usr/local/bin/codebase-memory-mcp:ro" \
  swebench/sweb.eval.x86_64.matplotlib_1776_matplotlib-23476:latest \
  /usr/local/bin/codebase-memory-mcp --version 2>&1 | head -3

rm -rf "$WORK"
REMOTE

echo ""
echo "OK: $REMOTE_BIN ready on ECS. docker-batch prefers codebase-memory-mcp-swe automatically."
