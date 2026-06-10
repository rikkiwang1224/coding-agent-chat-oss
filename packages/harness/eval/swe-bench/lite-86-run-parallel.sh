#!/usr/bin/env bash
# Lite-86: 2-way parallel agent batch — runs ON ECS (Docker host).
#
# Each bucket calls docker-batch.sh → one swebench/sweb.eval.* container
# per instance; agent + pytest run inside /testbed. Mac never generates patches.
#
# Usage (ECS — canonical):
#   cd ~/coding-agent-chat-oss/packages/harness/eval/swe-bench
#   nohup bash lite-86-run-parallel.sh start-local \
#     > ~/swe-batch/lite-86-run/launcher.log 2>&1 &
#   bash lite-86-monitor.sh watch-local
#
# Mac convenience (rsync first, then ssh one-liner):
#   bash lite-86-sync-to-ecs.sh
#   bash lite-86-run-parallel.sh start   # ssh → start-local on ECS
#
# Subcommands:
#   start-local  run on ECS: bucket a+b parallel, watcher queues c
#   start        Mac helper: ssh to ECS and exec start-local (foreground)
#   status-local one-shot dashboard (memory / docker / progress)

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWE_EVAL="$DIR"
RUN_ROOT="${LITE86_RUN_ROOT:-$HOME/swe-batch/lite-86-run}"
PARALLEL_BUCKETS="${LITE86_PARALLEL_BUCKETS:-a,b}"
QUEUE_BUCKET="${LITE86_QUEUE_BUCKET:-c}"

ECS_IP="${ECS_IP:-}"
ECS_HOST="${ECS_HOST:-${ECS_IP:+ubuntu@${ECS_IP}}}"

# Tunables passed to each docker-batch (via lite-86-bucket.sh)
export KEEP_IMAGES="${KEEP_IMAGES:-8}"
export PER_INSTANCE_TIMEOUT="${PER_INSTANCE_TIMEOUT:-600}"
export LATTICE_CODE_MAX_TURNS="${LATTICE_CODE_MAX_TURNS:-100}"
export LATTICE_CODE_VERIFY="${LATTICE_CODE_VERIFY:-0}"
export MODEL_NAME="${MODEL_NAME:-lattice-code-docker-guard}"

bucket_out_dir() {
  echo "$HOME/swe-batch/lite-86-bucket-$1"
}

bucket_log() {
  echo "$RUN_ROOT/bucket-$1.log"
}

bucket_pid_file() {
  echo "$RUN_ROOT/bucket-$1.pid"
}

expected_count() {
  local bucket="$1"
  grep -v '^#' "$SWE_EVAL/lite-86-bucket-${bucket}.instance-ids.txt" \
    | grep -v '^[[:space:]]*$' | wc -l | tr -d ' '
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

write_batch_env() {
  mkdir -p "$RUN_ROOT"
  cat > "$RUN_ROOT/batch.env" <<EOF
KEEP_IMAGES=${KEEP_IMAGES}
PER_INSTANCE_TIMEOUT=${PER_INSTANCE_TIMEOUT}
LATTICE_CODE_MAX_TURNS=${LATTICE_CODE_MAX_TURNS}
LATTICE_CODE_VERIFY=${LATTICE_CODE_VERIFY}
MODEL_NAME=${MODEL_NAME}
LATTICE_CODE_SAVE_TRACE=${LATTICE_CODE_SAVE_TRACE:-1}
SWE_EVAL=${SWE_EVAL}
RUN_ROOT=${RUN_ROOT}
EOF
}

start_bucket_local() {
  local bucket="$1"
  local pid_file log out_dir
  pid_file="$(bucket_pid_file "$bucket")"
  log="$(bucket_log "$bucket")"
  out_dir="$(bucket_out_dir "$bucket")"

  [[ -f "$RUN_ROOT/batch.env" ]] && source "$RUN_ROOT/batch.env"

  if is_pid_running "$(cat "$pid_file" 2>/dev/null || true)"; then
    echo "bucket $bucket already running (pid $(cat "$pid_file"))"
    return 0
  fi

  mkdir -p "$RUN_ROOT" "$(dirname "$log")" "$out_dir"
  echo "starting bucket $bucket → $out_dir (log: $log)"

  nohup env BUCKET="$bucket" \
    OUT_DIR="$out_dir" \
    KEEP_IMAGES="$KEEP_IMAGES" \
    PER_INSTANCE_TIMEOUT="$PER_INSTANCE_TIMEOUT" \
    LATTICE_CODE_MAX_TURNS="$LATTICE_CODE_MAX_TURNS" \
    LATTICE_CODE_VERIFY="$LATTICE_CODE_VERIFY" \
    MODEL_NAME="$MODEL_NAME" \
    LATTICE_CODE_TRACE_RUN_ID="${LATTICE_CODE_TRACE_RUN_ID:-lite-86-bucket-${bucket}}" \
    LATTICE_CODE_SAVE_TRACE="${LATTICE_CODE_SAVE_TRACE:-1}" \
    bash "$SWE_EVAL/lite-86-bucket.sh" \
    > "$log" 2>&1 </dev/null &
  echo "$!" > "$pid_file"
  echo "  pid=$(cat "$pid_file")"
}

start_watcher_local() {
  local watcher_pid_file="$RUN_ROOT/watcher.pid"
  if is_pid_running "$(cat "$watcher_pid_file" 2>/dev/null || true)"; then
    echo "watcher already running (pid $(cat "$watcher_pid_file"))"
    return 0
  fi

  cat > "$RUN_ROOT/watcher.sh" <<'WATCHER'
#!/usr/bin/env bash
set -euo pipefail
RUN_ROOT="$1"
SWE_EVAL="$2"
QUEUE_BUCKET="$3"
[[ -f "$RUN_ROOT/batch.env" ]] && source "$RUN_ROOT/batch.env"

bucket_pid_file() { echo "$RUN_ROOT/bucket-$1.pid"; }
is_pid_running() { local p="$1"; [[ -n "$p" && "$p" =~ ^[0-9]+$ ]] && kill -0 "$p" 2>/dev/null; }

started_c=false
[[ -f "$RUN_ROOT/queue-c-started" ]] && started_c=true

while true; do
  sleep 60
  a_pid=$(cat "$(bucket_pid_file a)" 2>/dev/null || true)
  b_pid=$(cat "$(bucket_pid_file b)" 2>/dev/null || true)
  a_up=false; b_up=false
  is_pid_running "$a_pid" && a_up=true
  is_pid_running "$b_pid" && b_up=true

  if [[ "$started_c" != true && "$a_up" != true && "$b_up" != true ]]; then
    echo "$(date -Is) a+b finished — starting bucket $QUEUE_BUCKET" >> "$RUN_ROOT/watcher.log"
    bash "$SWE_EVAL/lite-86-run-parallel.sh" start-bucket "$QUEUE_BUCKET" >> "$RUN_ROOT/watcher.log" 2>&1
    touch "$RUN_ROOT/queue-c-started"
    started_c=true
  fi

  c_pid=$(cat "$(bucket_pid_file c)" 2>/dev/null || true)
  if [[ "$started_c" == true ]] && ! is_pid_running "$c_pid" && ! is_pid_running "$a_pid" && ! is_pid_running "$b_pid"; then
    echo "$(date -Is) all buckets complete" >> "$RUN_ROOT/watcher.log"
    exit 0
  fi
done
WATCHER
  chmod +x "$RUN_ROOT/watcher.sh"

  nohup bash "$RUN_ROOT/watcher.sh" "$RUN_ROOT" "$SWE_EVAL" "$QUEUE_BUCKET" \
    > "$RUN_ROOT/watcher.log" 2>&1 </dev/null &
  echo "$!" > "$watcher_pid_file"
  echo "watcher pid=$(cat "$watcher_pid_file") (auto-starts bucket $QUEUE_BUCKET when a+b done)"
}

cmd_start_local() {
  mkdir -p "$RUN_ROOT"
  write_batch_env
  echo "=== lite-86 parallel start on ECS (2-way: ${PARALLEL_BUCKETS}) ==="
  echo "KEEP_IMAGES=$KEEP_IMAGES  MAX_TURNS=$LATTICE_CODE_MAX_TURNS  MODEL=$MODEL_NAME"
  echo ""

  IFS=',' read -ra BUCKETS <<< "$PARALLEL_BUCKETS"
  for b in "${BUCKETS[@]}"; do
    start_bucket_local "$b"
  done

  start_watcher_local

  echo ""
  echo "Monitor: bash $SWE_EVAL/lite-86-monitor.sh watch-local"
}

cmd_start_bucket() {
  start_bucket_local "${1:?bucket letter}"
}

cmd_status_local() {
  bash "$SWE_EVAL/lite-86-monitor.sh" status-local
}

cmd_stop_local() {
  echo "Stopping lite-86 batch processes…"
  for f in "$RUN_ROOT"/bucket-*.pid "$RUN_ROOT/watcher.pid"; do
    [[ -f "$f" ]] || continue
    pid=$(cat "$f" 2>/dev/null || true)
    if is_pid_running "$pid"; then
      echo "  kill $pid ($(basename "$f"))"
      kill "$pid" 2>/dev/null || true
    fi
  done
  pkill -f 'lite-86-bucket-[abc]\.instance-ids' 2>/dev/null || true
  pkill -f 'swe-batch/lite-86-bucket-' 2>/dev/null || true
}

cmd_start_remote() {
  [[ -n "$ECS_HOST" ]] || { echo "set ECS_IP or ECS_HOST" >&2; exit 1; }
  echo "=== ssh ${ECS_HOST} → start-local (batch runs in ECS Docker, not Mac) ==="
  ssh "$ECS_HOST" "cd ~/coding-agent-chat-oss/packages/harness/eval/swe-bench && \
    KEEP_IMAGES=${KEEP_IMAGES} PER_INSTANCE_TIMEOUT=${PER_INSTANCE_TIMEOUT} \
    LATTICE_CODE_MAX_TURNS=${LATTICE_CODE_MAX_TURNS} MODEL_NAME=${MODEL_NAME} \
    nohup bash lite-86-run-parallel.sh start-local \
    > ~/swe-batch/lite-86-run/launcher.log 2>&1 </dev/null & echo launcher_pid=\$!"
}

cmd_status_remote() {
  [[ -n "$ECS_HOST" ]] || { echo "set ECS_IP or ECS_HOST" >&2; exit 1; }
  ssh "$ECS_HOST" "bash ~/coding-agent-chat-oss/packages/harness/eval/swe-bench/lite-86-monitor.sh status-local"
}

SUB="${1:-start-local}"
shift || true

case "$SUB" in
  start) cmd_start_remote ;;
  start-local) cmd_start_local ;;
  start-bucket) cmd_start_bucket "$@" ;;
  status) cmd_status_remote ;;
  status-local) cmd_status_local ;;
  stop) cmd_stop_local ;;
  stop-remote)
    [[ -n "$ECS_HOST" ]] || { echo "set ECS_IP" >&2; exit 1; }
    ssh "$ECS_HOST" "bash ~/coding-agent-chat-oss/packages/harness/eval/swe-bench/lite-86-run-parallel.sh stop"
    ;;
  -h|--help)
    sed -n '2,22p' "$0"
    ;;
  *)
    echo "usage: $0 {start-local|start|status-local|stop}" >&2
    exit 1
    ;;
esac
