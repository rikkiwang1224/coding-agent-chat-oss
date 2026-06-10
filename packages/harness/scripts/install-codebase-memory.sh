#!/usr/bin/env bash
# Install codebase-memory-mcp binary for Lattice Code harness (optional but recommended).
# https://github.com/DeusData/codebase-memory-mcp
#
# Usage:
#   bash packages/harness/scripts/install-codebase-memory.sh
#   CBM_VERSION=v0.7.0 bash packages/harness/scripts/install-codebase-memory.sh
#
# Installs to ~/.local/bin/codebase-memory-mcp (or set LATTICE_CODE_CODEBASE_MEMORY_BIN).

set -euo pipefail

INSTALL_DIR="${LATTICE_CODE_CODEBASE_MEMORY_INSTALL_DIR:-$HOME/.local/bin}"
CBM_VERSION="${CBM_VERSION:-v0.7.0}"
CBM_DOWNLOAD_URL="${CBM_DOWNLOAD_URL:-https://github.com/DeusData/codebase-memory-mcp/releases/download/${CBM_VERSION}}"

echo "Installing codebase-memory-mcp ${CBM_VERSION} via upstream installer..."
curl -fsSL "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/${CBM_VERSION}/install.sh" \
  | CBM_DOWNLOAD_URL="$CBM_DOWNLOAD_URL" bash

if command -v codebase-memory-mcp >/dev/null 2>&1; then
  echo "OK: $(command -v codebase-memory-mcp)"
  codebase-memory-mcp --version 2>/dev/null || true
else
  echo "Installer finished but codebase-memory-mcp not on PATH."
  echo "Add ${INSTALL_DIR} to PATH or set LATTICE_CODE_CODEBASE_MEMORY_BIN."
  exit 1
fi
