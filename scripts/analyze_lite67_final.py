#!/usr/bin/env python3
"""Deep analysis of the 67 final unresolved instances from lite-300 (after thinking-mode retry).

Reads traces from eval-lite-86-bucket-{a,b,c} and cross-references with eval reports
to characterize failure modes: localization, reasoning, verification, harness, etc.
"""
import json, os, re, sys
from collections import Counter, defaultdict
from pathlib import Path

HOME = Path.home()
TRACE_BASE = HOME / ".lattice-code/traces/swe-bench"
RUN_BASE = HOME / ".lattice-code/runs/swe-bench"
BUCKETS = ["eval-lite-86-bucket-a", "eval-lite-86-bucket-b", "eval-lite-86-bucket-c"]

LITE77_FILE = Path(__file__).parent.parent / "packages/harness/eval/swe-bench/lite-77-unresolved.txt"
LITE77_BUCKETS = Path(__file__).parent.parent / "packages/harness/eval/swe-bench/lite-77-buckets.json"

EDIT_TOOLS = {"edit_file", "apply_patch", "str_replace", "write_file", "create_file",
              "search_replace", "multi_edit", "insert", "edit", "apply_edit"}
SEARCH_KW = ["search", "grep", "find", "glob", "index_repository", "list_dir", "text_search"]
READ_TOOLS = {"read_file", "cat_file", "view_file"}
BASH_TOOLS = {"bash", "execute_command", "run_command", "terminal"}
TEST_RE = re.compile(r"\b(pytest|py\.test|tox|unittest|runtests|test\.py|nosetests|python -m pytest|manage\.py test|reproduce|test_)\b", re.I)
FILE_RE = re.compile(r'^\+\+\+ b/(.+)$', re.M)
FILE_RE2 = re.compile(r'^diff --git a/(\S+) b/(\S+)', re.M)

def is_search(name):
    return any(k in name.lower() for k in SEARCH_KW)

def is_edit(name):
    return name in EDIT_TOOLS or "edit" in name.lower() or "patch" in name.lower() or "write" in name.lower()

def is_empty_result(out):
    if not out: return True
    low = out.strip().lower()
    for p in ["found 0 result", "no result", "no matches", "no files found", "no match",
              "nothing found", "could not find", "0 results", "no occurrences",
              "not found or not indexed", "symbol not found", "[]"]:
        if p in low: return True
    return False

def patched_files(diff):
    if not diff: return set()
    files = set(FILE_RE.findall(diff))
    for a, b in FILE_RE2.findall(diff):
        files.add(b)
    return {f for f in files if f and f != "/dev/null"}

def parse_trace(fp):
    calls, outputs, errors, done, started = [], {}, [], None, None
    deltas = []
    with open(fp) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: ev = json.loads(line).get("event", {})
            except: continue
            t, p = ev.get("type", ""), ev.get("payload", {})
            if t == "tool.called":
                calls.append({"id": p.get("toolCallId"), "name": p.get("toolName", ""), "args": p.get("args", {})})
            elif t == "tool.output":
                outputs[p.get("toolCallId")] = p.get("output", "")
            elif t == "tool.error":
                errors.append({"id": p.get("toolCallId"), "name": p.get("toolName", ""), "error": p.get("error", "")})
            elif t == "agent.done":
                done = p
            elif t == "agent.started":
                started = p
            elif t == "agent.delta":
                content = p.get("content", "")
                if content: deltas.append(content)
    for c in calls:
        c["output"] = outputs.get(c["id"], "")
    return calls, errors, done, started, deltas

def extract_agent_text(deltas):
    return "\n".join(deltas)

def detect_failure_signals(calls, errors, done, deltas, gold_patch=""):
    signals = []
    metrics = (done or {}).get("metrics", {}) or {}

    # 1. No agent.done → crash/timeout/OOM
    if done is None:
        signals.append("harness_crash_or_timeout")

    # 2. Empty patch
    edit_calls = [c for c in calls if is_edit(c["name"])]
    if not edit_calls:
        signals.append("no_edits_produced")

    # 3. Terminal reason
    reason = (done or {}).get("terminalReason", "")
    if reason:
        if "max" in reason.lower() or "turn" in reason.lower() or "limit" in reason.lower():
            signals.append("hit_turn_limit")
        elif "token" in reason.lower():
            signals.append("hit_token_limit")
        elif "error" in reason.lower():
            signals.append("terminal_error")

    # 4. Ran tests?
    test_count = 0
    for c in calls:
        if c["name"] in BASH_TOOLS:
            cmd = json.dumps(c["args"])
            if TEST_RE.search(cmd):
                test_count += 1
    if test_count == 0:
        signals.append("never_ran_tests")

    # 5. Search thrashing
    search_calls = [c for c in calls if is_search(c["name"])]
    empty_searches = sum(1 for c in search_calls if is_empty_result(c["output"]))
    if len(search_calls) > 0 and empty_searches / len(search_calls) > 0.6:
        signals.append("search_thrashing")

    # 6. Code graph errors
    index_errs = sum(1 for e in errors if "not indexed" in (e.get("error", "")).lower() or "index_repository" in (e.get("error", "")).lower())
    if index_errs > 0:
        signals.append("code_graph_index_errors")

    # 7. Localization miss (if gold patch available)
    if gold_patch:
        gold_files = patched_files(gold_patch)
        edited_files = set()
        for c in edit_calls:
            args = c.get("args", {})
            for k in ["path", "file_path", "file", "filename", "target_file"]:
                if k in args:
                    f = args[k].lstrip("/")
                    if f.startswith("testbed/"):
                        f = f[len("testbed/"):]
                    edited_files.add(f)
        if edited_files and gold_files and not (edited_files & gold_files):
            signals.append("wrong_file_localization")
        elif gold_files and len(gold_files) > len(edited_files & gold_files):
            signals.append("partial_file_coverage")

    # 8. Repeated failed edits
    failed_edits = sum(1 for e in errors if is_edit(e.get("name", "")))
    if failed_edits >= 3:
        signals.append("repeated_edit_failures")

    # 9. Very short trace (gave up early)
    if len(calls) < 5 and done is not None:
        signals.append("gave_up_early")

    # 10. Agent expressed uncertainty/confusion in text
    text = extract_agent_text(deltas).lower()
    confusion_phrases = ["i'm not sure", "i cannot", "unable to determine", "this is tricky",
                          "i don't understand", "beyond my", "not clear how", "stuck"]
    for p in confusion_phrases:
        if p in text:
            signals.append("expressed_uncertainty")
            break

    return signals, {
        "test_count": test_count,
        "edit_count": len(edit_calls),
        "search_count": len(search_calls),
        "empty_search": empty_searches,
        "error_count": len(errors),
        "total_tools": len(calls),
        "turns": metrics.get("numTurns", 0),
        "tokens": metrics.get("totalTokens", 0),
        "cost": metrics.get("totalCostUsd", 0),
        "model": metrics.get("primaryModel", "unknown"),
        "status": (done or {}).get("status"),
        "reason": reason,
    }

def load_gold_patches():
    """Load gold patches from instances.json files."""
    golds = {}
    for b in ["a", "b", "c"]:
        p = RUN_BASE / f"lite-86-bucket-{b}" / "instances.json"
        if not p.exists(): continue
        for item in json.loads(p.read_text()):
            golds[item["instance_id"]] = item.get("patch", "")
    return golds

def load_predictions():
    """Load model predictions from eval-v1."""
    preds = {}
    pred_file = RUN_BASE / "lite-86-eval-v1" / "predictions.jsonl"
    if pred_file.exists():
        for line in pred_file.read_text().splitlines():
            if not line.strip(): continue
            o = json.loads(line)
            preds[o["instance_id"]] = o.get("model_patch", "")
    return preds

def classify_failure_mode(signals, stats):
    if "harness_crash_or_timeout" in signals:
        return "A_harness_crash"
    if "no_edits_produced" in signals:
        if "gave_up_early" in signals:
            return "B_gave_up_no_attempt"
        return "C_explored_but_no_edit"
    if "wrong_file_localization" in signals:
        return "D_wrong_file"
    if "hit_turn_limit" in signals:
        if "repeated_edit_failures" in signals:
            return "E_turn_limit_edit_loop"
        return "F_turn_limit_exhaustion"
    if "search_thrashing" in signals:
        return "G_search_thrashing"
    if "repeated_edit_failures" in signals:
        return "H_edit_failures"
    if "never_ran_tests" in signals and stats["edit_count"] > 0:
        return "I_no_verification"
    if stats["edit_count"] > 0:
        return "J_wrong_fix"
    return "K_other"

FAILURE_MODE_DESCRIPTIONS = {
    "A_harness_crash": "Harness crash/timeout/OOM - agent trace incomplete",
    "B_gave_up_no_attempt": "Agent gave up early without attempting edits",
    "C_explored_but_no_edit": "Agent explored codebase but never produced edits",
    "D_wrong_file": "Wrong file localization - edited files don't match gold",
    "E_turn_limit_edit_loop": "Hit turn limit while stuck in edit retry loop",
    "F_turn_limit_exhaustion": "Hit turn limit - ran out of turns",
    "G_search_thrashing": "Search thrashing - >60% empty search results",
    "H_edit_failures": "Repeated edit tool failures (>=3)",
    "I_no_verification": "Produced edits but never ran tests to verify",
    "J_wrong_fix": "Applied fix but patch doesn't match gold (wrong logic)",
    "K_other": "Other / uncategorized",
}


def main():
    # Load the 77 unresolved instance IDs
    if LITE77_FILE.exists():
        ids_77 = {l.strip() for l in LITE77_FILE.read_text().splitlines() if l.strip()}
    else:
        print(f"WARNING: {LITE77_FILE} not found, analyzing all trace instances")
        ids_77 = None

    gold_patches = load_gold_patches()
    predictions = load_predictions()

    results = []
    for bucket_dir in BUCKETS:
        d = TRACE_BASE / bucket_dir / "instances"
        if not d.is_dir():
            print(f"SKIP: {d} not found")
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".jsonl"): continue
            inst = fn[:-6]
            if ids_77 and inst not in ids_77: continue

            calls, errors, done, started, deltas = parse_trace(d / fn)
            gold = gold_patches.get(inst, "")
            pred = predictions.get(inst, "")

            signals, stats = detect_failure_signals(calls, errors, done, deltas, gold)

            # Localization analysis using predictions
            if pred and gold:
                pred_files = patched_files(pred)
                gold_files = patched_files(gold)
                file_overlap = pred_files & gold_files
                loc_status = "correct" if file_overlap == gold_files else ("partial" if file_overlap else ("wrong" if pred_files else "empty"))
            else:
                pred_files, gold_files, file_overlap = set(), set(), set()
                loc_status = "no_pred" if not pred else "no_gold"

            mode = classify_failure_mode(signals, stats)

            results.append({
                "inst": inst,
                "bucket": bucket_dir[-1],
                "mode": mode,
                "signals": signals,
                "stats": stats,
                "loc_status": loc_status,
                "pred_files": sorted(pred_files),
                "gold_files": sorted(gold_files),
                "file_overlap": sorted(file_overlap),
                "gold_hunk_count": gold.count("\n@@ ") + (1 if gold.startswith("@@ ") else 0) if gold else 0,
            })

    n = len(results)
    print("=" * 90)
    print(f"LITE-300 FINAL 67 UNRESOLVED — DEEP FAILURE ANALYSIS  ({n} instances traced)")
    print("=" * 90)

    # --- 1. Failure mode distribution ---
    print("\n" + "=" * 70)
    print("1. FAILURE MODE DISTRIBUTION")
    print("=" * 70)
    mode_counts = Counter(r["mode"] for r in results)
    for mode, cnt in mode_counts.most_common():
        desc = FAILURE_MODE_DESCRIPTIONS.get(mode, mode)
        pct = 100 * cnt / n
        bar = "█" * int(pct / 2)
        print(f"  {mode:30s} {cnt:3d} ({pct:5.1f}%)  {bar}")
        print(f"    → {desc}")

    # --- 2. Localization accuracy ---
    print("\n" + "=" * 70)
    print("2. FILE LOCALIZATION ACCURACY")
    print("=" * 70)
    loc_counts = Counter(r["loc_status"] for r in results)
    for k, v in loc_counts.most_common():
        print(f"  {k:15s}: {v:3d} ({100*v/n:.1f}%)")

    print("\n  Wrong-file instances (agent edited completely wrong files):")
    for r in results:
        if r["loc_status"] == "wrong" and r["pred_files"]:
            print(f"    {r['inst']:40s}")
            print(f"      agent→ {r['pred_files']}")
            print(f"      gold → {r['gold_files']}")

    # --- 3. Project breakdown ---
    print("\n" + "=" * 70)
    print("3. PROJECT BREAKDOWN (unresolved by project)")
    print("=" * 70)
    proj_counter = Counter()
    proj_modes = defaultdict(list)
    for r in results:
        proj = r["inst"].rsplit("-", 1)[0] if "__" in r["inst"] else r["inst"]
        proj = r["inst"].split("__")[0] + "__" + r["inst"].split("__")[1].rsplit("-", 1)[0] if "__" in r["inst"] else r["inst"]
        proj_counter[proj] += 1
        proj_modes[proj].append(r["mode"])
    for proj, cnt in proj_counter.most_common():
        modes = Counter(proj_modes[proj])
        mode_str = ", ".join(f"{m.split('_',1)[1]}={c}" for m, c in modes.most_common(3))
        print(f"  {proj:35s}: {cnt:2d}  [{mode_str}]")

    # --- 4. Gold patch complexity ---
    print("\n" + "=" * 70)
    print("4. GOLD PATCH COMPLEXITY (harder instances)")
    print("=" * 70)
    multi_file = [r for r in results if len(r["gold_files"]) >= 2]
    many_hunks = [r for r in results if r["gold_hunk_count"] >= 3]
    print(f"  Multi-file gold patches (>=2 files): {len(multi_file)}/{n}")
    for r in sorted(multi_file, key=lambda x: -len(x["gold_files"])):
        print(f"    {r['inst']:40s} files={len(r['gold_files'])} hunks={r['gold_hunk_count']} mode={r['mode']}")
    print(f"\n  Many-hunk gold patches (>=3 hunks): {len(many_hunks)}/{n}")

    # --- 5. Agent effort stats ---
    print("\n" + "=" * 70)
    print("5. AGENT EFFORT STATISTICS")
    print("=" * 70)
    turns = [r["stats"]["turns"] for r in results if r["stats"]["turns"]]
    tokens = [r["stats"]["tokens"] for r in results if r["stats"]["tokens"]]
    costs = [r["stats"]["cost"] for r in results if r["stats"]["cost"]]
    edits = [r["stats"]["edit_count"] for r in results]
    tests = [r["stats"]["test_count"] for r in results]
    print(f"  Turns:  avg={sum(turns)/max(len(turns),1):.1f}  median={sorted(turns)[len(turns)//2] if turns else 0}  max={max(turns) if turns else 0}")
    print(f"  Tokens: avg={sum(tokens)/max(len(tokens),1):,.0f}  max={max(tokens) if tokens else 0:,}")
    print(f"  Cost:   avg=${sum(costs)/max(len(costs),1):.3f}  total=${sum(costs):.2f}")
    print(f"  Edits:  avg={sum(edits)/n:.1f}  zero_edit={sum(1 for e in edits if e==0)}")
    print(f"  Tests:  avg={sum(tests)/n:.1f}  never_tested={sum(1 for t in tests if t==0)}")

    # --- 6. Signal co-occurrence ---
    print("\n" + "=" * 70)
    print("6. FAILURE SIGNAL FREQUENCY")
    print("=" * 70)
    signal_counts = Counter()
    for r in results:
        for s in r["signals"]:
            signal_counts[s] += 1
    for s, c in signal_counts.most_common():
        print(f"  {s:35s}: {c:3d} ({100*c/n:.1f}%)")

    # --- 7. Detailed per-instance summary ---
    print("\n" + "=" * 70)
    print("7. PER-INSTANCE SUMMARY (sorted by failure mode)")
    print("=" * 70)
    for r in sorted(results, key=lambda x: (x["mode"], x["inst"])):
        sigs = ", ".join(r["signals"][:3]) if r["signals"] else "none"
        s = r["stats"]
        print(f"  {r['inst']:45s} {r['mode']:30s} loc={r['loc_status']:8s} turns={s['turns']:3d} edits={s['edit_count']:2d} tests={s['test_count']:2d} errs={s['error_count']:3d}")

    # --- 8. Actionable recommendations ---
    print("\n" + "=" * 70)
    print("8. ACTIONABLE RECOMMENDATIONS")
    print("=" * 70)

    wrong_file_n = sum(1 for r in results if "wrong_file_localization" in r["signals"])
    no_edit_n = sum(1 for r in results if "no_edits_produced" in r["signals"])
    no_test_n = sum(1 for r in results if "never_ran_tests" in r["signals"] and r["stats"]["edit_count"] > 0)
    turn_limit_n = sum(1 for r in results if "hit_turn_limit" in r["signals"])
    thrash_n = sum(1 for r in results if "search_thrashing" in r["signals"])
    crash_n = sum(1 for r in results if "harness_crash_or_timeout" in r["signals"])

    recs = []
    if no_edit_n:
        recs.append(f"[{no_edit_n} instances] Agent explored but never edited — improve action-bias / commit-to-fix prompt")
    if wrong_file_n:
        recs.append(f"[{wrong_file_n} instances] Wrong file localization — improve code navigation / search strategy")
    if no_test_n:
        recs.append(f"[{no_test_n} instances] Edited but never tested — add mandatory test-before-submit step")
    if turn_limit_n:
        recs.append(f"[{turn_limit_n} instances] Hit turn limit — increase budget or improve early-exit strategy")
    if thrash_n:
        recs.append(f"[{thrash_n} instances] Search thrashing — improve query formulation or switch to broader search")
    if crash_n:
        recs.append(f"[{crash_n} instances] Harness crash/timeout — investigate infra issues")

    for i, rec in enumerate(recs, 1):
        print(f"  {i}. {rec}")

    # --- 9. Output as JSON for canvas ---
    output = {
        "total_analyzed": n,
        "failure_modes": {mode: cnt for mode, cnt in mode_counts.most_common()},
        "failure_mode_descriptions": FAILURE_MODE_DESCRIPTIONS,
        "localization": {k: v for k, v in loc_counts.most_common()},
        "projects": {p: c for p, c in proj_counter.most_common()},
        "signals": {s: c for s, c in signal_counts.most_common()},
        "effort": {
            "avg_turns": sum(turns) / max(len(turns), 1),
            "avg_tokens": sum(tokens) / max(len(tokens), 1),
            "avg_cost": sum(costs) / max(len(costs), 1),
            "total_cost": sum(costs),
        },
        "instances": [{
            "id": r["inst"],
            "mode": r["mode"],
            "loc": r["loc_status"],
            "signals": r["signals"],
            "turns": r["stats"]["turns"],
            "edits": r["stats"]["edit_count"],
            "tests": r["stats"]["test_count"],
            "errors": r["stats"]["error_count"],
            "gold_files": r["gold_files"],
            "pred_files": r["pred_files"],
        } for r in sorted(results, key=lambda x: (x["mode"], x["inst"]))],
    }
    json_out = Path(__file__).parent / "lite67_analysis.json"
    json_out.write_text(json.dumps(output, indent=2))
    print(f"\n  JSON output written to {json_out}")


if __name__ == "__main__":
    main()
