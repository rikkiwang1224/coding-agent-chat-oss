#!/usr/bin/env bash
# Best-of-N batch: run the Lattice Code agent N times per SWE-bench instance (with
# temperature > 0 so samples diverge), then pick one candidate patch via
# select-patch.ts. Writes a predictions.jsonl of the SELECTED patches plus, for
# every instance, all N candidate patches (so pass@N can be computed offline by
# evaluating each candidate index separately).
#
# Usage:
#   docker-bestofn.sh <instances.json> <output_dir>
#
# Key env vars:
#   BEST_OF_N            — samples per instance (default 5)
#   LATTICE_CODE_TEMPERATURE — sampling temperature for diversity (default 0.7)
#   RUN_REGRESSION       — 1 → measure each candidate's related-tests status and
#                          let selection prefer green patches (default 0)
#   PER_SAMPLE_TIMEOUT   — per-sample agent wall clock seconds (default 600)
#   SELECT_TIMEOUT_MS    — per-candidate regression timeout ms (default 300000)
#   KEEP_IMAGES          — LRU keep N swebench/sweb.eval.* images (default 15)
#   MODEL_NAME           — predictions model_name_or_path (default lc-bestofn)
#
# Outputs (under <output_dir>):
#   predictions.jsonl                 — selected patch per instance
#   logs/<id>/candidate_<k>.patch     — all N candidate diffs (for pass@N)
#   logs/<id>/cand_<k>.log            — per-sample agent stdout
#   logs/<id>/agent.patch             — the SELECTED patch
#   logs/<id>/bestofn-report.json     — selection decision + per-candidate annotations
#   summary.tsv, done.txt             — progress (resume-safe)
#
# Prereqs (ECS host): same as docker-batch.sh (node-prebuilt, built dist, .env, docker, jq).

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

BEST_OF_N="${BEST_OF_N:-5}"
LATTICE_CODE_TEMPERATURE="${LATTICE_CODE_TEMPERATURE:-0.7}"
RUN_REGRESSION="${RUN_REGRESSION:-0}"
PER_SAMPLE_TIMEOUT="${PER_SAMPLE_TIMEOUT:-600}"
SELECT_TIMEOUT_MS="${SELECT_TIMEOUT_MS:-300000}"
KEEP_IMAGES="${KEEP_IMAGES:-15}"
MODEL_NAME="${MODEL_NAME:-lc-bestofn}"

instance_to_image() {
  local id="$1"; local lower="${id,,}"
  echo "swebench/sweb.eval.x86_64.${lower//__/_1776_}:latest"
}
instance_to_repo() {
  local id="$1"; local before_dash="${id%-*}"
  local owner="${before_dash%%__*}"; local repo="${before_dash#*__}"
  echo "${owner}/${repo}"
}

cleanup_images() {
  local total
  total=$(docker images --format "{{.Repository}}" | grep -c "^swebench/sweb.eval" || true)
  if [ "$total" -gt "$KEEP_IMAGES" ]; then
    local n_remove=$((total - KEEP_IMAGES))
    docker images --format "{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}" \
      | grep "swebench/sweb.eval" | sort | head -n "$n_remove" \
      | awk -F'\t' '{print $2}' | xargs -r docker rmi -f >/dev/null 2>&1 || true
  fi
}

TOTAL=$(jq 'length' "$INSTANCES_JSON")
BATCH_START=$(date +%s)
echo "=== best-of-n batch: $TOTAL instances → $OUT_DIR ==="
echo "=== N=$BEST_OF_N temperature=$LATTICE_CODE_TEMPERATURE run_regression=$RUN_REGRESSION per_sample_timeout=${PER_SAMPLE_TIMEOUT}s ==="

for i in $(seq 0 $((TOTAL - 1))); do
  INST_ID=$(jq -r ".[$i].instance_id" "$INSTANCES_JSON")
  if grep -qx "$INST_ID" "$DONE_FILE"; then
    echo "[$((i+1))/$TOTAL] $INST_ID — already done, skip"; continue
  fi

  IMG=$(instance_to_image "$INST_ID")
  REPO=$(instance_to_repo "$INST_ID")
  WORK="$LOG_DIR/$INST_ID"
  mkdir -p "$WORK"
  jq ".[$i]" "$INSTANCES_JSON" > "$WORK/instance.json"

  echo ""
  echo "=========================================="
  echo "[$((i+1))/$TOTAL] $INST_ID  (image: $IMG, repo: $REPO)"
  echo "=========================================="

  START=$(date +%s)
  STATUS="OK"

  if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo "→ pulling..."
    docker pull "$IMG" 2>&1 | tail -3 || STATUS="FAIL_PULL"
  fi

  if [ "$STATUS" = "OK" ]; then
    docker run --rm \
      --network host \
      -v "$HOME/node-prebuilt/node-v20:/opt/node:ro" \
      -v "$HOME/coding-agent-chat-oss:/lattice-code:ro" \
      -v "$WORK:/work" \
      --env-file "$HOME/coding-agent-chat-oss/.env" \
      -e SWE_INSTANCE_ID="$INST_ID" \
      -e LATTICE_CODE_TEMPERATURE="$LATTICE_CODE_TEMPERATURE" \
      -e BEST_OF_N="$BEST_OF_N" \
      -e RUN_REGRESSION="$RUN_REGRESSION" \
      -e SELECT_TIMEOUT_MS="$SELECT_TIMEOUT_MS" \
      -e PER_SAMPLE_TIMEOUT="$PER_SAMPLE_TIMEOUT" \
      -e REPO="$REPO" \
      "$IMG" \
      bash -lc '
        set -e
        export PATH=/opt/node/bin:$PATH
        source /opt/miniconda3/etc/profile.d/conda.sh
        conda activate testbed
        cd /testbed
        BASE=$(git rev-parse HEAD)
        TSX=/lattice-code/node_modules/tsx/dist/cli.mjs
        AGENT=/lattice-code/packages/harness/eval/swe-bench/docker-agent.ts

        for k in $(seq 1 "$BEST_OF_N"); do
          echo "=== sample $k/$BEST_OF_N (temp=$LATTICE_CODE_TEMPERATURE) ==="
          git reset --hard "$BASE" -q && git clean -fdq
          timeout "$PER_SAMPLE_TIMEOUT" node "$TSX" "$AGENT" \
            --workspace /testbed \
            --instance /work/instance.json \
            --patch-out "/work/candidate_${k}.patch" \
            --no-trace \
            > "/work/cand_${k}.log" 2>&1 \
            || echo "sample $k agent exit=$?" >> "/work/cand_${k}.log"
          echo "sample $k patch_lines=$(wc -l < /work/candidate_${k}.patch)"
        done

        # Reset to clean base before selection (regression applies candidates itself).
        git reset --hard "$BASE" -q && git clean -fdq

        REG_FLAG=""
        [ "$RUN_REGRESSION" = "1" ] && REG_FLAG="--run-regression"
        node "$TSX" /lattice-code/packages/harness/eval/swe-bench/select-patch.ts \
          --candidates-dir /work --out /work/agent.patch --report /work/bestofn-report.json \
          --repo "$REPO" --testbed /testbed --base "$BASE" --python python \
          --timeout-ms "$SELECT_TIMEOUT_MS" $REG_FLAG 2>&1 | tail -20
      ' 2>&1 | tail -40 || STATUS="FAIL_RUN"
  fi

  ELAPSED=$(($(date +%s) - START))
  [ -f "$WORK/agent.patch" ] || touch "$WORK/agent.patch"
  PATCH_LINES=0
  [ -s "$WORK/agent.patch" ] && PATCH_LINES=$(wc -l < "$WORK/agent.patch")

  # CRITICAL: --rawfile (not $(cat)) so the trailing newline git apply needs survives.
  jq -nc --arg id "$INST_ID" --arg model "$MODEL_NAME" --rawfile p "$WORK/agent.patch" \
    '{instance_id:$id, model_name_or_path:$model, model_patch:$p}' >> "$PRED_FILE"

  SEL=$(jq -r '.selectedIndex // "?"' "$WORK/bestofn-report.json" 2>/dev/null || echo "?")
  printf '%s\t%s\t%d\t%d\tsel=%s\n' "$INST_ID" "$STATUS" "$PATCH_LINES" "$ELAPSED" "$SEL" >> "$SUMMARY"
  echo "$INST_ID" >> "$DONE_FILE"

  TOTAL_ELAPSED=$(($(date +%s) - BATCH_START))
  printf '✓ %s — status=%s sel=#%s patch=%d lines, %ds (total %dm)\n' \
    "$INST_ID" "$STATUS" "$SEL" "$PATCH_LINES" "$ELAPSED" "$((TOTAL_ELAPSED / 60))"

  cleanup_images
done

echo ""
echo "=== best-of-n batch complete in $((($(date +%s) - BATCH_START) / 60))m ==="
echo "predictions: $PRED_FILE ($(wc -l < "$PRED_FILE") lines)"
echo "summary:"
column -t -s $'\t' "$SUMMARY"
