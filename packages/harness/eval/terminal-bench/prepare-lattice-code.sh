#!/usr/bin/env bash
# Stage Lattice Code source + node_modules for upload into Harbor task containers.
#
# Usage:
#   ./prepare-lattice-code.sh [output_dir]
#
# Default output: ~/.lattice-code/tb-lattice-code-staging
# Export LATTICE_CODE_ROOT to the printed path before `harbor run`.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/../../../.." && pwd)"
OUT="${1:-$HOME/.lattice-code/tb-lattice-code-staging}"

echo "=== staging Lattice Code for Terminal-Bench ==="
echo "repo:   $REPO_ROOT"
echo "output: $OUT"

rm -rf "$OUT"
mkdir -p "$OUT"

rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'apps/chat-desktop' \
  --exclude 'apps/chat-desktop/**' \
  --exclude 'brand' \
  --exclude 'docs' \
  --exclude '**/.lattice-code' \
  --exclude '**/dist' \
  --exclude 'packages/harness/eval/swe-bench/.venv' \
  --exclude 'packages/harness/eval/terminal-bench/.venv' \
  "$REPO_ROOT/" "$OUT/"

cd "$OUT"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1

NODE_VER="${LATTICE_CODE_NODE_VERSION:-20.18.0}"
NODE_DIR="$OUT/.node-prebuilt/node-v20"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "=== bundling Linux Node.js v${NODE_VER} for task containers ==="
  mkdir -p "$OUT/.node-prebuilt"
  TARBALL="node-v${NODE_VER}-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/${TARBALL}" | tar -xJ -C "$OUT/.node-prebuilt"
  mv "$OUT/.node-prebuilt/node-v${NODE_VER}-linux-x64" "$NODE_DIR"
fi

if [ "$(uname -s)" = "Linux" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --ignore-scripts
  else
    npm install -g pnpm@8
    pnpm install --ignore-scripts
  fi
else
  echo ""
  echo "=== skipped pnpm on $(uname -s) (would install wrong platform binaries) ==="
  echo "After sync to ECS, run on the server:"
  echo "  $DIR/prepare-lattice-code-linux-deps.sh"
fi

echo ""
echo "=== done ==="
echo "export LATTICE_CODE_ROOT=\"$OUT\""
