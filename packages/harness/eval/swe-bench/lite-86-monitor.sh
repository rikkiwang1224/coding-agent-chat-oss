#!/usr/bin/env bash
# Lite-86 monitor — runs ON ECS (where docker-batch runs).
#
# Usage (ECS):
#   bash lite-86-monitor.sh watch-local
#   bash lite-86-monitor.sh status-local
#
# Mac (optional — ssh wrapper only):
#   bash lite-86-monitor.sh status
#   bash lite-86-monitor.sh watch

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_ROOT="${LITE86_RUN_ROOT:-$HOME/swe-batch/lite-86-run}"
ECS_IP="${ECS_IP:-}"
ECS_HOST="${ECS_HOST:-${ECS_IP:+ubuntu@${ECS_IP}}}"

MEM_WARN_MB="${LITE86_MEM_WARN_MB:-2048}"

bucket_out_dir() { echo "$HOME/swe-batch/lite-86-bucket-$1"; }
bucket_pid_file() { echo "$RUN_ROOT/bucket-$1.pid"; }
expected_count() {
  grep -v '^#' "$DIR/lite-86-bucket-${1}.instance-ids.txt" \
    | grep -v '^[[:space:]]*$' | wc -l | tr -d ' '
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

print_status() {
  local now bucket done exp pid running last summary_line
  now="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "═══════════════════════════════════════════════════════════"
  echo " lite-86 monitor (ECS)  $now"
  echo "═══════════════════════════════════════════════════════════"

  echo ""
  echo "── memory ──"
  free -h | head -2
  local avail_kb
  avail_kb=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
  if [[ -n "$avail_kb" && "$avail_kb" -lt $((MEM_WARN_MB * 1024)) ]]; then
    echo "⚠️  MemAvailable < ${MEM_WARN_MB}MB — consider stopping a bucket or KEEP_IMAGES=6"
  fi

  echo ""
  echo "── disk ──"
  df -h / | tail -1

  echo ""
  echo "── docker (top containers) ──"
  if docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null \
    | head -6 | tail -5 | grep -q .; then
    docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null | head -6
  else
    echo "(no running containers)"
  fi

  echo ""
  echo "── buckets ──"
  printf "%-6s %6s %6s %8s  %s\n" "bucket" "done" "total" "running" "last summary"
  for bucket in a b c; do
    exp="$(expected_count "$bucket")"
    done=0
    [[ -f "$(bucket_out_dir "$bucket")/done.txt" ]] \
      && done=$(wc -l < "$(bucket_out_dir "$bucket")/done.txt" | tr -d ' ')
    pid=$(cat "$(bucket_pid_file "$bucket")" 2>/dev/null || true)
    running="no"
    is_pid_running "$pid" && running="yes(pid=$pid)"
    summary_line="-"
    if [[ -f "$(bucket_out_dir "$bucket")/summary.tsv" ]]; then
      summary_line=$(tail -1 "$(bucket_out_dir "$bucket")/summary.tsv" 2>/dev/null \
        | awk -F'\t' '{print $1, $2, $4"s"}' || echo "-")
    fi
    printf "%-6s %6s %6s %8s  %s\n" "$bucket" "$done" "$exp" "$running" "$summary_line"
  done

  if [[ -f "$RUN_ROOT/watcher.pid" ]]; then
    wp=$(cat "$RUN_ROOT/watcher.pid" 2>/dev/null || true)
    echo ""
    echo "watcher: pid=$wp running=$(is_pid_running "$wp" && echo yes || echo no)"
    if [[ -f "$RUN_ROOT/watcher.log" ]]; then
      echo "  last: $(tail -1 "$RUN_ROOT/watcher.log" 2>/dev/null || true)"
    fi
  fi

  echo ""
  echo "── recent log tails ──"
  for bucket in a b c; do
    log="$RUN_ROOT/bucket-$bucket.log"
    [[ -f "$log" ]] || continue
    echo "[$bucket] $(tail -1 "$log" 2>/dev/null || true)"
  done
  echo ""
}

cmd_watch_local() {
  local interval="${1:-30}"
  while true; do
    clear 2>/dev/null || true
    print_status
    echo "refreshing every ${interval}s — Ctrl+C to stop"
    sleep "$interval"
  done
}

SUB="${1:-status-local}"
shift || true

case "$SUB" in
  status)
    [[ -n "$ECS_HOST" ]] || { echo "set ECS_IP for ssh wrapper, or run status-local on ECS" >&2; exit 1; }
    ssh "$ECS_HOST" "bash ~/coding-agent-chat-oss/packages/harness/eval/swe-bench/lite-86-monitor.sh status-local"
    ;;
  status-local) print_status ;;
  watch)
    INTERVAL="${1:-30}"
    [[ -n "$ECS_HOST" ]] || { echo "set ECS_IP for ssh wrapper, or run watch-local on ECS" >&2; exit 1; }
    ssh -t "$ECS_HOST" "bash ~/coding-agent-chat-oss/packages/harness/eval/swe-bench/lite-86-monitor.sh watch-local $INTERVAL"
    ;;
  watch-local) cmd_watch_local "${1:-30}" ;;
  -h|--help)
    sed -n '2,12p' "$0"
    ;;
  *)
    echo "usage: $0 {status-local|watch-local [interval]}" >&2
    exit 1
    ;;
esac
