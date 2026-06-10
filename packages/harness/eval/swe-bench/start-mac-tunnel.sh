#!/usr/bin/env bash
# Mac: start pproxy + ssh reverse tunnel so ECS eval can reach GitHub/HuggingFace.
#
# Usage:
#   export ECS_IP=43.138.255.207
#   bash start-mac-tunnel.sh
#
# Keeps running until Ctrl+C. Eval on ECS uses http://127.0.0.1:7890 on the ECS side.

set -euo pipefail

ECS_IP="${ECS_IP:?set ECS_IP (e.g. export ECS_IP=43.138.255.207)}"
ECS_USER="${ECS_USER:-ubuntu}"
PROXY_PORT="${PROXY_PORT:-7890}"
PPROXY_LOG="${PPROXY_LOG:-/tmp/forgelet-pproxy.log}"

if ! command -v python3 >/dev/null; then
  echo "python3 required" >&2
  exit 1
fi

if ! python3 -c "import pproxy" 2>/dev/null; then
  echo "Installing pproxy..."
  python3 -m pip install --user pproxy
fi

cleanup() {
  echo ""
  echo "Stopping tunnel..."
  [[ -n "${PPROXY_PID:-}" ]] && kill "$PPROXY_PID" 2>/dev/null || true
  [[ -n "${SSH_PID:-}" ]] && kill "$SSH_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

if curl -sf --max-time 3 --proxy "http://127.0.0.1:${PROXY_PORT}" \
  -o /dev/null https://raw.githubusercontent.com/github/gitignore/main/README.md 2>/dev/null; then
  echo "pproxy already listening on :${PROXY_PORT}"
else
  echo "Starting pproxy on 127.0.0.1:${PROXY_PORT} (log: $PPROXY_LOG)"
  python3 -m pproxy -l "http://127.0.0.1:${PROXY_PORT}" >>"$PPROXY_LOG" 2>&1 &
  PPROXY_PID=$!
  sleep 1
fi

echo "Opening ssh -R ${PROXY_PORT}:127.0.0.1:${PROXY_PORT} → ${ECS_USER}@${ECS_IP}"
ssh -N -o ServerAliveInterval=60 -o ExitOnForwardFailure=yes \
  -R "${PROXY_PORT}:127.0.0.1:${PROXY_PORT}" "${ECS_USER}@${ECS_IP}" &
SSH_PID=$!

sleep 2
echo ""
echo "Verify on ECS:"
echo "  ssh ${ECS_USER}@${ECS_IP} 'curl -sf --max-time 8 --proxy http://127.0.0.1:${PROXY_PORT} -o /dev/null -w %{http_code} https://github.com'"
echo ""
echo "Tunnel running (Ctrl+C to stop). Keep this terminal open during eval."

wait "$SSH_PID"
