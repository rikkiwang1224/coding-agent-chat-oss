#!/usr/bin/env bash
# Install codebase-memory-mcp binary for Forgelet harness (optional but recommended).
# https://github.com/DeusData/codebase-memory-mcp
#
# Usage:
#   bash packages/harness/scripts/install-codebase-memory.sh
#
# Installs to ~/.local/bin/codebase-memory-mcp (or set FORGELET_CODEBASE_MEMORY_BIN).

set -euo pipefail

INSTALL_DIR="${FORGELET_CODEBASE_MEMORY_INSTALL_DIR:-$HOME/.local/bin}"

echo "Installing codebase-memory-mcp via upstream installer..."
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash

if command -v codebase-memory-mcp >/dev/null 2>&1; then
  echo "OK: $(command -v codebase-memory-mcp)"
  codebase-memory-mcp --version 2>/dev/null || true
else
  echo "Installer finished but codebase-memory-mcp not on PATH."
  echo "Add ${INSTALL_DIR} to PATH or set FORGELET_CODEBASE_MEMORY_BIN."
  exit 1
fi
