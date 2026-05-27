#!/usr/bin/env bash
# Start Mac-side pproxy + SSH reverse tunnel for cloud SWE-bench eval.
# Usage: ./start-proxy-tunnel.sh <ecs-ip> [proxy-port]
set -euo pipefail

ECS_IP="${1:?ECS public IP required, e.g. 203.0.113.10}"
PORT="${2:-7890}"
PID_DIR="${TMPDIR:-/tmp}/forgelet-swe-proxy"
mkdir -p "$PID_DIR"

PPROXY_PID="$PID_DIR/pproxy-${PORT}.pid"
SSH_PID="$PID_DIR/ssh-tunnel-${PORT}.pid"

PYTHON=""
for candidate in python3.11 python3; do
  if command -v "$candidate" >/dev/null && "$candidate" -m pproxy --version >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo "pproxy not found. Install: python3 -m pip install --user pproxy" >&2
  exit 1
fi

if lsof -i ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} already in use (pproxy or tunnel may be running)."
else
  echo "Starting pproxy on 127.0.0.1:${PORT} ($PYTHON)..."
  nohup "$PYTHON" -m pproxy -l "http://127.0.0.1:${PORT}" >"$PID_DIR/pproxy.log" 2>&1 &
  echo $! >"$PPROXY_PID"
  sleep 1
fi

if ! curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  --proxy "http://127.0.0.1:${PORT}" https://raw.githubusercontent.com | grep -qE '^[23]'; then
  echo "Warning: proxy test to raw.githubusercontent.com failed; check Mac network."
else
  echo "pproxy OK (GitHub reachable via Mac)."
fi

if [[ -f "$SSH_PID" ]] && kill -0 "$(cat "$SSH_PID")" 2>/dev/null; then
  echo "SSH tunnel already running (pid $(cat "$SSH_PID"))."
else
  echo "Starting SSH reverse tunnel → ubuntu@${ECS_IP}..."
  nohup ssh -N -o ServerAliveInterval=60 -R "${PORT}:127.0.0.1:${PORT}" "ubuntu@${ECS_IP}" \
    >"$PID_DIR/ssh-tunnel.log" 2>&1 &
  echo $! >"$SSH_PID"
  sleep 2
fi

echo ""
echo "Keep this Mac awake during cloud eval."
echo "  pproxy log:  $PID_DIR/pproxy.log"
echo "  ssh log:     $PID_DIR/ssh-tunnel.log"
echo "  stop:        kill \$(cat $PPROXY_PID) \$(cat $SSH_PID) 2>/dev/null"
echo ""
echo "Cloud verify (on ECS):"
echo "  curl -I --proxy http://127.0.0.1:${PORT} https://raw.githubusercontent.com"
