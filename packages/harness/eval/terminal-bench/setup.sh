#!/usr/bin/env bash
# Create a Python 3.12–3.13 venv and install Harbor for Terminal-Bench eval.
#
# Usage:
#   ./setup.sh
#   https_proxy=http://127.0.0.1:7890 ./setup.sh   # ECS via Mac pproxy tunnel
#
# Run on ECS (needs Docker). See WORKFLOW.md.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

pick_python() {
  if [ -n "${LATTICE_CODE_PYTHON:-}" ]; then
    echo "$LATTICE_CODE_PYTHON"
    return
  fi
  local candidate ver major minor
  for candidate in \
    python3.13 \
    python3.12 \
    /opt/homebrew/opt/python@3.13/bin/python3.13 \
    /opt/homebrew/opt/python@3.12/bin/python3.12 \
    /usr/bin/python3.13 \
    /usr/bin/python3.12; do
    if command -v "$candidate" >/dev/null 2>&1; then
      ver="$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
      major="${ver%%.*}"
      minor="${ver#*.}"
      if [ "$major" -eq 3 ] && [ "$minor" -ge 12 ] && [ "$minor" -le 13 ]; then
        echo "$candidate"
        return
      fi
    fi
  done
}

github_reachable() {
  local proxy="${https_proxy:-${HTTPS_PROXY:-}}"
  local curl_args=(-sf --max-time 15 -o /dev/null)
  if [ -n "$proxy" ]; then
    curl_args+=(--proxy "$proxy")
  fi
  curl "${curl_args[@]}" https://github.com >/dev/null 2>&1
}

PY="$(pick_python || true)"
if [ -z "$PY" ]; then
  echo "Error: Harbor needs Python 3.12 or 3.13 (not 3.11, not 3.14)." >&2
  exit 1
fi

echo "Using $PY ($("$PY" --version))"
rm -rf .venv
"$PY" -m venv .venv
.venv/bin/pip install -U pip

BUNDLE_WHEELS="$DIR/harbor-bundle/wheels"
HARBOR_WHL=""
if [ -d "$BUNDLE_WHEELS" ]; then
  # shellcheck disable=SC2012
  HARBOR_WHL="$(ls -1 "$BUNDLE_WHEELS"/harbor-*.whl 2>/dev/null | head -1 || true)"
fi

USE_ONLINE=0
if [ "${LATTICE_CODE_SETUP_OFFLINE:-}" = "1" ]; then
  USE_ONLINE=0
elif [ -n "${https_proxy:-${HTTPS_PROXY:-}}" ]; then
  # Explicit proxy → online (harbor-bundle is often incomplete; don't fall back)
  USE_ONLINE=1
elif [ "${LATTICE_CODE_SETUP_ONLINE:-}" = "1" ]; then
  USE_ONLINE=1
elif github_reachable; then
  USE_ONLINE=1
fi

if [ "$USE_ONLINE" -eq 1 ]; then
  proxy="${https_proxy:-${HTTPS_PROXY:-}}"
  if [ -n "$proxy" ]; then
    echo "=== online install (via proxy $proxy) ==="
    # ECS default pip index is mirrors.tencentyun.com; that mirror does not work
    # through Mac pproxy (github.com/pypi.org do). Force PyPI when using tunnel.
    export PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.org/simple}"
    export PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST:-pypi.org files.pythonhosted.org}"
    echo "    pip index: $PIP_INDEX_URL"
  else
    echo "=== online install ==="
  fi
  .venv/bin/pip install -r requirements.txt
elif [ -n "$HARBOR_WHL" ] && [ -f "$HARBOR_WHL" ]; then
  echo "=== offline install from $BUNDLE_WHEELS ==="
  echo "    (installing $(basename "$HARBOR_WHL") + deps, not git clone)"
  .venv/bin/pip install --no-index --find-links "$BUNDLE_WHEELS" "$HARBOR_WHL"
else
  echo "Error: cannot reach github.com and no harbor-*.whl in harbor-bundle/wheels." >&2
  echo "" >&2
  echo "  With pproxy tunnel: https_proxy=http://127.0.0.1:7890 ./setup.sh" >&2
  echo "  Or on Mac: ./bundle-harbor-for-ecs.sh && ./sync-to-ecs.sh" >&2
  exit 1
fi

echo ""
echo "Harbor installed. Activate: source $DIR/.venv/bin/activate"
.venv/bin/harbor --version 2>/dev/null || .venv/bin/harbor run --help | head -3
