#!/usr/bin/env bash
# Verify MANDATORY self-review gate fired in smoke-gate-3 traces.
#
# Usage:
#   bash smoke-gate-3.check.sh
#   bash smoke-gate-3.check.sh ~/swe-batch/smoke-gate-3

set -euo pipefail

OUT_DIR="${1:-$HOME/swe-batch/smoke-gate-3}"
TRACE_RUN_ID="${FORGELET_TRACE_RUN_ID:-smoke-gate-3}"
TRACE_DIR="${FORGELET_HOME:-$HOME/.forgelet}/traces/swe-bench/eval-${TRACE_RUN_ID}/instances"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDS_FILE="$SCRIPT_DIR/smoke-gate-3.instance-ids.txt"

echo "=== smoke-gate-3 gate check ==="
echo "out_dir:  $OUT_DIR"
echo "traces:   $TRACE_DIR"
echo ""

python3 - <<'PY' "$OUT_DIR" "$TRACE_DIR" "$IDS_FILE"
import json, re, sys
from pathlib import Path

out_dir, trace_dir, ids_file = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
ids = [l.strip() for l in ids_file.read_text().splitlines() if l.strip() and not l.startswith("#")]

EDIT = {"edit_file", "apply_patch", "str_replace", "write_file", "search_replace", "multi_edit"}
NAV = {"call_trace", "symbol_search", "change_impact"}
TEST_RE = re.compile(
    r"\b(pytest|py\.test|tox|unittest|runtests|test\.py|nosetests|python -m pytest|manage\.py test|reproduce|test_)\b",
    re.I,
)

def is_edit(name):
    return name in EDIT or "edit" in name.lower() or "patch" in name.lower()

def parse_trace(fp):
    seq, started, done = [], None, None
    with open(fp) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line).get("event", {})
            except json.JSONDecodeError:
                continue
            t, p = ev.get("type", ""), ev.get("payload", {})
            if t == "agent.started":
                started = p.get("prompt", "")
            elif t == "tool.called":
                seq.append({"name": p.get("toolName", ""), "args": p.get("args", {})})
            elif t == "agent.done":
                done = p
    return seq, started, done

def gate_signals(seq):
    first_edit = next((i for i, c in enumerate(seq) if is_edit(c["name"])), None)
    pre = {n: 0 for n in NAV}
    post = {n: 0 for n in NAV}
    pre_tests = post_tests = 0
    for i, c in enumerate(seq):
        n = c["name"]
        after = first_edit is not None and i > first_edit
        bucket = post if after else pre
        if n in NAV:
            bucket[n] += 1
        if n in ("bash", "execute_command", "run_command", "terminal"):
            cmd = json.dumps(c.get("args", {}))
            if TEST_RE.search(cmd):
                if after:
                    post_tests += 1
                else:
                    pre_tests += 1
    nav_post = post["call_trace"] + post["symbol_search"]
    gate_nav = nav_post >= 1
    gate_extra_test = post_tests >= 1
    gate_change_impact = post["change_impact"] >= 1
    score = sum([gate_nav, gate_extra_test, gate_change_impact])
    # Hard gate enforces a post-edit symbol_search/call_trace. That is the
    # primary pass criterion; extra-test / change_impact are informational.
    triggered = gate_nav
    return {
        "first_edit_idx": first_edit,
        "pre": pre,
        "post": post,
        "pre_tests": pre_tests,
        "post_tests": post_tests,
        "gate_nav": gate_nav,
        "gate_extra_test": gate_extra_test,
        "gate_change_impact": gate_change_impact,
        "triggered": triggered,
        "score": score,
    }

pass_n = fail_n = missing = 0
print(f"{'instance':42s} {'gate?':6s} nav_post sym post post_tests impact prompt_ok")
print("-" * 95)
for iid in ids:
    trace = trace_dir / f"{iid}.jsonl"
    if not trace.exists():
        print(f"{iid:42s} {'MISSING':6s}")
        missing += 1
        continue
    seq, started, done = parse_trace(trace)
    g = gate_signals(seq)
    prompt_ok = "MANDATORY self-review" in (started or "")
    status = "PASS" if g["triggered"] and prompt_ok else "FAIL"
    if status == "PASS":
        pass_n += 1
    else:
        fail_n += 1
    nav = g["post"]["call_trace"] + g["post"]["symbol_search"]
    print(
        f"{iid:42s} {status:6s} {nav:8d} {g['post']['symbol_search']:4d} {g['post']['call_trace']:4d} "
        f"{g['post_tests']:10d} {g['post']['change_impact']:6d} {str(prompt_ok):9s}"
    )
    if status == "FAIL":
        print(f"  pre-edit nav: call_trace={g['pre']['call_trace']} symbol_search={g['pre']['symbol_search']}")
        print(f"  post-edit nav: call_trace={g['post']['call_trace']} symbol_search={g['post']['symbol_search']}")
        print(f"  first_edit_at={g['first_edit_idx']} total_tools={len(seq)}")

print("")
print(f"=== summary: PASS={pass_n} FAIL={fail_n} MISSING={missing} / {len(ids)} ===")
if fail_n or missing:
    sys.exit(1)
PY
