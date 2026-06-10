#!/usr/bin/env bash
# Mac-side helper ONLY: optional ECS power-on + rsync + ssh to launch batch on ECS.
# Patch generation happens in ECS Docker (docker-batch.sh), not on Mac.
#
# Usage (Mac):
#   export ECS_IP=111.230.49.4
#   bash lite-86-start.sh              # rsync + ssh nohup start-local on ECS
#   bash lite-86-start.sh --start-ecs  # power on first
#   bash lite-86-start.sh --skip-sync  # ssh launch only
#
# Or do it manually per WORKFLOW.md §1.2–1.3.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_ECS=false
SKIP_SYNC=false

for arg in "$@"; do
  case "$arg" in
    --start-ecs) START_ECS=true ;;
    --skip-sync) SKIP_SYNC=true ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$START_ECS" == true ]]; then
  bash "$(cd "$DIR/.." && pwd)/start-ecs.sh" --wait
fi

if [[ "$SKIP_SYNC" != true ]]; then
  bash "$DIR/lite-86-sync-to-ecs.sh"
fi

bash "$DIR/lite-86-run-parallel.sh" start

echo ""
echo "=== batch launched on ECS (Docker) ==="
echo "Monitor (Mac ssh wrapper):  ECS_IP=\$ECS_IP bash $DIR/lite-86-monitor.sh watch"
echo "Monitor (on ECS):           bash lite-86-monitor.sh watch-local"
echo "Pull results (Mac, later):  bash $DIR/pull-and-report.sh lite-86-bucket-a"
