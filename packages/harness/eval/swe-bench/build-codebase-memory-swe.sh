#!/usr/bin/env bash
# Build codebase-memory-mcp for SWE-bench Docker images (old glibc).
#
# Run on Mac (needs Docker + GitHub). ECS cannot reach GitHub — build here,
# then: bash sync-codebase-memory-swe-to-ecs.sh
#
# Build inside ubuntu:20.04 so the binary links against glibc ≤ 2.31, which
# runs inside swebench/sweb.eval.* containers (official releases need GLIBC_2.38).
#
# Requires Docker on this machine. No Docker on Mac? Use instead:
#   fetch-codebase-memory-source.sh + build-codebase-memory-swe-on-ecs.sh
#
# Usage:
#   bash packages/harness/eval/swe-bench/build-codebase-memory-swe.sh
#   CBM_TAG=v0.7.0 bash .../build-codebase-memory-swe.sh
#
# Output:
#   packages/harness/eval/swe-bench/bin/codebase-memory-mcp-swe-linux-amd64

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/bin/codebase-memory-mcp-swe-linux-amd64"
CBM_TAG="${CBM_TAG:-v0.7.0}"
BUILD_IMAGE="${BUILD_IMAGE:-ubuntu:20.04}"

mkdir -p "$SCRIPT_DIR/bin"

echo "=== build codebase-memory-mcp for SWE (tag=$CBM_TAG, image=$BUILD_IMAGE) ==="
echo "    output: $OUT"
echo ""

docker run --rm \
  -e CBM_TAG="$CBM_TAG" \
  -v "$SCRIPT_DIR/bin:/out" \
  "$BUILD_IMAGE" \
  bash -lc '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq git ca-certificates build-essential curl zlib1g-dev >/dev/null
    rm -rf /src
    git clone --depth 1 --branch "$CBM_TAG" \
      https://github.com/DeusData/codebase-memory-mcp.git /src
    cd /src
    sed -i 's/-lpthread -lz/-lpthread -lz -ldl/g' Makefile.cbm 2>/dev/null || true
    scripts/build.sh --version "$CBM_TAG"
    cp build/c/codebase-memory-mcp /out/codebase-memory-mcp-swe-linux-amd64
    chmod +x /out/codebase-memory-mcp-swe-linux-amd64
    echo "=== built binary glibc deps (max) ==="
    objdump -T /out/codebase-memory-mcp-swe-linux-amd64 2>/dev/null \
      | grep GLIBC | sed "s/.*GLIBC_/GLIBC_/" | sed "s/ .*//" | sort -Vu | tail -3 || true
  '

echo ""
echo "=== local size ==="
ls -lh "$OUT"

if command -v docker >/dev/null 2>&1; then
  IMG="${SWE_PROBE_IMAGE:-swebench/sweb.eval.x86_64.matplotlib_1776_matplotlib-23476:latest}"
  if docker image inspect "$IMG" >/dev/null 2>&1; then
    echo ""
    echo "=== probe in SWE image: $IMG ==="
    if docker run --rm -v "$OUT:/usr/local/bin/codebase-memory-mcp:ro" "$IMG" \
      /usr/local/bin/codebase-memory-mcp --version 2>&1 | head -2; then
      echo "OK: binary runs inside SWE container"
    else
      echo "WARN: probe failed — try an older BUILD_IMAGE or CBM_TAG" >&2
      exit 1
    fi
  else
    echo "(skip SWE probe — image not pulled locally: $IMG)"
  fi
fi

echo ""
echo "Next: bash $SCRIPT_DIR/sync-codebase-memory-swe-to-ecs.sh"
