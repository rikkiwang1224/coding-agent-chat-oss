#!/usr/bin/env bash
# Batch-run the Forgelet agent across SWE-bench instances inside their
# official Docker images, one at a time. Writes a `predictions.jsonl`
# ready for `sb-cli submit`.
#
# Usage:
#   docker-batch.sh <instances.json> <output_dir>
#
# Outputs (under <output_dir>):
#   predictions.jsonl  — {instance_id, model_name_or_path, model_patch} per line
#   summary.tsv        — <instance_id> <status> <patch_lines> <elapsed_s>
#   done.txt           — completed instance_ids (resume-safe; rerun to continue)
#   logs/<id>/         — agent.log, agent.patch, prompt.txt per instance
#
# Tunables (env vars):
#   KEEP_IMAGES          — LRU keep N swebench/sweb.eval.* images (default 15)
#   PER_INSTANCE_TIMEOUT — per-instance wall clock seconds (default 600)
#   MODEL_NAME           — predictions.jsonl model_name_or_path (default forgelet-docker)
#
# Prereqs on the host (typically the ECS box):
#   - $HOME/node-prebuilt/node-v20/bin/node
#   - $HOME/coding-agent-chat-oss              (Forgelet source w/ deps + built dist)
#   - $HOME/coding-agent-chat-oss/.env         (DEEPSEEK_API_KEY=...)
#   - docker, jq

set -euo pipefail

INSTANCES_JSON="${1:?usage: $0 <instances.json> <output_dir>}"
OUT_DIR="${2:?usage: $0 <instances.json> <output_dir>}"
mkdir -p "$OUT_DIR"
PRED_FILE="$OUT_DIR/predictions.jsonl"
SUMMARY="$OUT_DIR/summary.tsv"
DONE_FILE="$OUT_DIR/done.txt"
LOG_DIR="$OUT_DIR/logs"
mkdir -p "$LOG_DIR"
touch "$DONE_FILE" "$PRED_FILE" "$SUMMARY"

KEEP_IMAGES="${KEEP_IMAGES:-15}"
PER_INSTANCE_TIMEOUT="${PER_INSTANCE_TIMEOUT:-600}"
MODEL_NAME="${MODEL_NAME:-forgelet-docker}"
# Reason-as-Sensor (independent reviewer pass before declaring done).
#   FORGELET_REASON=0 → off (baseline)
#   FORGELET_REASON=1 → on, 2 rounds (default)
#   FORGELET_REASON=N → on, N rounds (1..5)
# Default OFF here so existing batches keep their cost/behavior baseline. Opt
# in explicitly for A/B comparisons: `FORGELET_REASON=1 bash docker-batch.sh ...`.
FORGELET_REASON="${FORGELET_REASON:-0}"
# Verify-as-Sensor (ground-truth test gate before declaring done).
#   FORGELET_VERIFY=0 → off (baseline)
#   FORGELET_VERIFY=1 → on, 3 rounds (default)
#   FORGELET_VERIFY=N → on, N rounds (1..5)
# Optional tuning:
#   FORGELET_VERIFY_TIMEOUT=300 → per-round wall clock cap (seconds, default 300)
# Inside the SWE-bench container the CLI auto-detects the repo from git
# remote, so no FORGELET_VERIFY_REPO is needed here.
FORGELET_VERIFY="${FORGELET_VERIFY:-0}"
FORGELET_VERIFY_TIMEOUT="${FORGELET_VERIFY_TIMEOUT:-300}"

# SWE-bench naming: swebench/sweb.eval.x86_64.<id_lower with __ → _1776_>:latest
# 1776 is the literal magic number used in upstream swebench/harness/test_spec.py.
instance_to_image() {
  local id="$1"
  local lower="${id,,}"
  echo "swebench/sweb.eval.x86_64.${lower//__/_1776_}:latest"
}

# SWE-bench instance_id format is "<owner>__<repo>-<number>" (e.g.
# "django__django-10924"). Convert to "<owner>/<repo>" for the verify hook
# to pick the right test runner. Why we pass this explicitly instead of
# auto-detecting from git remote: the SWE-bench testbed images don't have
# an "origin" remote set (the repo is cp'd into place, not cloned), so
# `git remote get-url origin` fails inside the container.
instance_to_repo() {
  local id="$1"
  local before_dash="${id%-*}"
  local owner="${before_dash%%__*}"
  local repo="${before_dash#*__}"
  echo "${owner}/${repo}"
}

cleanup_images() {
  local total
  total=$(docker images --format "{{.Repository}}" | grep -c "^swebench/sweb.eval" || true)
  if [ "$total" -gt "$KEEP_IMAGES" ]; then
    local n_remove=$((total - KEEP_IMAGES))
    docker images --format "{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}" \
      | grep "swebench/sweb.eval" \
      | sort \
      | head -n "$n_remove" \
      | awk -F'\t' '{print $2}' \
      | xargs -r docker rmi -f >/dev/null 2>&1 || true
  fi
}

TOTAL=$(jq 'length' "$INSTANCES_JSON")
BATCH_START=$(date +%s)
echo "=== batch: $TOTAL instances → $OUT_DIR ==="
echo "=== keep-images=$KEEP_IMAGES, per-instance timeout=${PER_INSTANCE_TIMEOUT}s, reason=$FORGELET_REASON, verify=$FORGELET_VERIFY ==="

for i in $(seq 0 $((TOTAL - 1))); do
  INST_ID=$(jq -r ".[$i].instance_id" "$INSTANCES_JSON")
  if grep -qx "$INST_ID" "$DONE_FILE"; then
    echo "[$((i+1))/$TOTAL] $INST_ID — already done, skip"
    continue
  fi

  IMG=$(instance_to_image "$INST_ID")
  REPO=$(instance_to_repo "$INST_ID")
  WORK="$LOG_DIR/$INST_ID"
  mkdir -p "$WORK"
  jq -r ".[$i].problem_statement" "$INSTANCES_JSON" > "$WORK/prompt.txt"

  echo ""
  echo "=========================================="
  echo "[$((i+1))/$TOTAL] $INST_ID"
  echo "image: $IMG"
  echo "=========================================="

  START=$(date +%s)
  STATUS="OK"

  if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo "→ pulling..."
    if ! docker pull "$IMG" 2>&1 | tail -3; then
      STATUS="FAIL_PULL"
    fi
  fi

  if [ "$STATUS" = "OK" ]; then
    docker run --rm \
      --network host \
      -v "$HOME/node-prebuilt/node-v20:/opt/node:ro" \
      -v "$HOME/coding-agent-chat-oss:/forgelet:ro" \
      -v "$WORK:/work" \
      --env-file "$HOME/coding-agent-chat-oss/.env" \
      -e SWE_INSTANCE_ID="$INST_ID" \
      -e FORGELET_REASON="$FORGELET_REASON" \
      -e FORGELET_VERIFY="$FORGELET_VERIFY" \
      -e FORGELET_VERIFY_TIMEOUT="$FORGELET_VERIFY_TIMEOUT" \
      -e FORGELET_VERIFY_REPO="$REPO" \
      "$IMG" \
      bash -lc "
        set -e
        export PATH=/opt/node/bin:\$PATH
        source /opt/miniconda3/etc/profile.d/conda.sh
        conda activate testbed
        cd /testbed
        PROMPT=\"\$(cat /work/prompt.txt)\"
        timeout ${PER_INSTANCE_TIMEOUT} node /forgelet/node_modules/tsx/dist/cli.mjs \
          /forgelet/apps/cli/src/main.ts -c /testbed -y --no-trace \"\$PROMPT\" \
          > /work/agent.log 2>&1 || echo \"agent exit=\$?\" >> /work/agent.log
        cd /testbed && git diff > /work/agent.patch
      " 2>&1 | tail -3 || STATUS="FAIL_RUN"
  fi

  ELAPSED=$(($(date +%s) - START))
  PATCH_LINES=0
  # Materialize agent.patch only if missing. The container creates it (as
  # root) on successful runs; re-touching a root-owned file as ubuntu fails
  # with EACCES and would exit the whole batch under `set -e`.
  #
  # CRITICAL: must NOT pipe through `$(cat ...)` — bash command substitution
  # strips trailing newlines, which breaks `git apply` (it requires a final \n).
  # That single character difference makes every SWE-bench instance fail to apply.
  [ -f "$WORK/agent.patch" ] || touch "$WORK/agent.patch"
  if [ -s "$WORK/agent.patch" ]; then
    PATCH_LINES=$(wc -l < "$WORK/agent.patch")
  fi

  jq -nc --arg id "$INST_ID" --arg model "$MODEL_NAME" --rawfile p "$WORK/agent.patch" \
    '{instance_id:$id, model_name_or_path:$model, model_patch:$p}' >> "$PRED_FILE"

  printf '%s\t%s\t%d\t%d\n' "$INST_ID" "$STATUS" "$PATCH_LINES" "$ELAPSED" >> "$SUMMARY"
  echo "$INST_ID" >> "$DONE_FILE"

  TOTAL_ELAPSED=$(($(date +%s) - BATCH_START))
  printf '✓ %s — status=%s patch=%d lines, %ds (total %dm)\n' \
    "$INST_ID" "$STATUS" "$PATCH_LINES" "$ELAPSED" "$((TOTAL_ELAPSED / 60))"

  cleanup_images
done

echo ""
echo "=== batch complete in $((($(date +%s) - BATCH_START) / 60))m ==="
echo "predictions: $PRED_FILE ($(wc -l < "$PRED_FILE") lines)"
echo ""
echo "summary:"
column -t -s $'\t' "$SUMMARY"

# Auto-generate per-instance cost/time report. Lives next to summary.tsv so
# it gets picked up by the same rsync that pulls logs back to the Mac.
# Tolerates python missing — report is nice-to-have, not blocking.
REPORT_SCRIPT="$(dirname "$(readlink -f "$0")")/cost-report.py"
if [ -f "$REPORT_SCRIPT" ] && command -v python3 >/dev/null 2>&1; then
  echo ""
  echo "=== cost report ==="
  python3 "$REPORT_SCRIPT" "$OUT_DIR" || echo "(cost-report failed — non-fatal)"
fi
