#!/usr/bin/env bash
# Post-smoke checks for smoke-codegraph-5.sh (run on Mac after rsync or local batch).
#
# Usage:
#   bash smoke-codegraph-5.check.sh
#   bash smoke-codegraph-5.check.sh ~/swe-batch/smoke-cg-5

set -euo pipefail

OUT_DIR="${1:-$HOME/swe-batch/smoke-cg-5}"
TRACE_RUN_ID="${FORGELET_TRACE_RUN_ID:-smoke-cg-5}"
TRACE_DIR="${FORGELET_HOME:-$HOME/.forgelet}/traces/swe-bench/eval-${TRACE_RUN_ID}/instances"
PRED="$OUT_DIR/predictions.jsonl"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_FILE="$SCRIPT_DIR/smoke-codegraph-5.instance-ids.txt"

is_test_path() {
  local p="$1"
  [[ "$(basename "$p")" == test_* ]] && return 0
  [[ "$(basename "$p")" == *_test.py ]] && return 0
  [[ "$p" == *"/tests/"* || "$p" == *"/testing/"* ]] && return 0
  return 1
}

echo "=== smoke-codegraph-5 check ==="
echo "out_dir:    $OUT_DIR"
echo "traces:     $TRACE_DIR"
echo ""

while read -r id; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  echo "----------------------------------------"
  echo "$id"

  log="$OUT_DIR/logs/$id/agent.log"
  patch="$OUT_DIR/logs/$id/agent.patch"
  trace="$TRACE_DIR/${id}.jsonl"

  if [[ -f "$log" ]]; then
    if grep -qiE 'protected|not allowed|denied|test file' "$log" 2>/dev/null; then
      echo "  log: possible test-guard rejection (grep protected/denied)"
    fi
    if grep -q 'code_graph_' "$log" 2>/dev/null; then
      echo "  log: code_graph_* tool calls present"
    elif grep -qi 'code graph skipped' "$log" 2>/dev/null; then
      echo "  log: code graph SKIPPED (no mcp in container?)"
    elif grep -qi 'indexing workspace for code graph' "$log" 2>/dev/null; then
      echo "  log: code graph indexed"
    fi
  else
    echo "  log: MISSING $log"
  fi

  if [[ -f "$patch" ]]; then
    test_hunks=0
    while IFS= read -r f; do
      is_test_path "$f" && test_hunks=$((test_hunks + 1))
    done < <(grep -E '^diff --git ' "$patch" 2>/dev/null | sed -n 's|^diff --git a/\([^ ]*\).*|\1|p' || true)
    if [[ "$test_hunks" -gt 0 ]]; then
      echo "  patch: WARN — $test_hunks test-path file(s) in agent.patch"
    else
      echo "  patch: OK — no test paths in diff"
    fi
    echo "  patch lines: $(wc -l < "$patch" | tr -d ' ')"
  else
    echo "  patch: MISSING"
  fi

  if [[ -f "$trace" ]]; then
    cg=$(grep -c 'code_graph_' "$trace" 2>/dev/null || echo 0)
    test_edits=$(python3 - <<PY 2>/dev/null || echo "?")
import json, sys
path = sys.argv[1]
test_edits = source_edits = 0
for line in open(path):
    e = json.loads(line).get("event", {})
    if e.get("type") != "tool.called":
        continue
    p = e.get("payload", {})
    if p.get("toolName") not in ("edit_file", "multi_edit", "write_file", "apply_patch"):
        continue
    fp = (p.get("args") or {}).get("path") or ""
    if not fp:
        continue
    parts = fp.split("/")
    is_test = (
        parts[-1].startswith("test_")
        or parts[-1].endswith("_test.py")
        or "tests" in parts
        or "testing" in parts
    )
    if is_test:
        test_edits += 1
    else:
        source_edits += 1
print(f"{test_edits}:{source_edits}")
PY
"$trace")
    echo "  trace: code_graph mentions=$cg, test_edits:source_edits=$test_edits"
  else
    echo "  trace: MISSING (set FORGELET_SAVE_TRACE=1)"
  fi

  if [[ -f "$PRED" ]]; then
    plen=$(grep -F "$id" "$PRED" | head -1 | jq -r '.model_patch | length' 2>/dev/null || echo 0)
    echo "  predictions.jsonl patch chars: $plen"
  fi
done < "$IDS_FILE"

echo ""
echo "=== expected signals (manual) ==="
echo "  23987, 5063, 14092 — test edits blocked; patch has no tests/"
echo "  23476 — prefer code_graph_search/trace; gold file is figure.py not backend_bases"
echo "  2148   — regression: non-empty patch, do not worsen vs baseline"
echo ""
echo "Cloud eval (optional):"
echo "  bash evaluate.sh $PRED SWE-bench/SWE-bench_Lite ${TRACE_RUN_ID}"
