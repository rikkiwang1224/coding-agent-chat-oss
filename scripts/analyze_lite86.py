#!/usr/bin/env python3
"""Analyze the lite-86 (historically unresolved) re-run traces.

Extracts per-instance signals to characterize coding-agent failure modes:
- terminal status / reason
- turns, tokens, cost
- tool call counts, tool error counts + error categories
- whether the agent actually produced edits (patch signal)
- search efficiency (empty-result rate, thrashing)
"""
import json, os, re
from collections import Counter, defaultdict

BASE = os.path.expanduser("~/.forgelet/traces/swe-bench")
BUCKETS = ["eval-lite-86-bucket-a", "eval-lite-86-bucket-b", "eval-lite-86-bucket-c"]

EDIT_TOOLS = {"edit_file", "apply_patch", "str_replace", "write_file", "create_file",
              "search_replace", "multi_edit", "insert", "edit", "apply_edit"}
SEARCH_TOOLS_KW = ["search", "grep", "find", "glob", "index_repository", "list_dir", "text_search"]

def is_search(name):
    n = name.lower()
    return any(k in n for k in SEARCH_TOOLS_KW)

def is_empty(out):
    if not out:
        return True
    low = out.strip().lower()
    for p in ["found 0 result", "no result", "no matches", "no files found", "no match",
              "nothing found", "could not find", "0 results", "no occurrences",
              "not found or not indexed", "symbol not found", "[]"]:
        if p in low:
            return True
    return False

def categorize_error(err):
    low = (err or "").lower()
    if "not indexed" in low or "index_repository first" in low or "no projects indexed" in low:
        return "code_graph_not_indexed"
    if "symbol not found" in low:
        return "symbol_not_found"
    if "timeout" in low or "timed out" in low:
        return "timeout"
    if "no such file" in low or "does not exist" in low or "not found" in low:
        return "file_not_found"
    if "permission" in low:
        return "permission"
    if "invalid" in low or "parse" in low or "json" in low:
        return "bad_args"
    return "other"

def parse(fp):
    calls, outputs, errors, done = [], {}, [], None
    started = None
    with open(fp) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line).get("event", {})
            except json.JSONDecodeError:
                continue
            t = ev.get("type", "")
            p = ev.get("payload", {})
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
    for c in calls:
        c["output"] = outputs.get(c["id"], "")
        c["empty"] = is_empty(c["output"])
    return calls, errors, done, started

def main():
    rows = []
    for b in BUCKETS:
        d = os.path.join(BASE, b, "instances")
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".jsonl"):
                continue
            inst = fn[:-6]
            calls, errors, done, started = parse(os.path.join(d, fn))
            tool_counts = Counter(c["name"] for c in calls)
            edit_calls = sum(tool_counts[t] for t in tool_counts if t in EDIT_TOOLS or "edit" in t.lower() or "patch" in t.lower() or "write" in t.lower())
            search_calls = [c for c in calls if is_search(c["name"])]
            empty_search = sum(1 for c in search_calls if c["empty"])
            err_cats = Counter(categorize_error(e["error"]) for e in errors)
            metrics = (done or {}).get("metrics", {}) or {}
            rows.append({
                "inst": inst, "bucket": b[-1],
                "status": (done or {}).get("status"),
                "terminalReason": (done or {}).get("terminalReason"),
                "turns": metrics.get("numTurns"),
                "totalTokens": metrics.get("totalTokens"),
                "cost": metrics.get("totalCostUsd"),
                "model": metrics.get("primaryModel"),
                "n_tools": len(calls),
                "n_edits": edit_calls,
                "n_search": len(search_calls),
                "empty_search": empty_search,
                "n_errors": len(errors),
                "err_cats": dict(err_cats),
                "tool_counts": dict(tool_counts),
            })

    n = len(rows)
    print("="*80); print(f"LITE-86 RE-RUN TRACE ANALYSIS  ({n} instances)"); print("="*80)

    # status
    print("\n## Terminal status / reason")
    for k, c in Counter((r["status"], r["terminalReason"]) for r in rows).most_common():
        print(f"  {str(k):45s} : {c}")

    # no-edit instances (agent never modified code -> guaranteed unresolved)
    no_edit = [r for r in rows if r["n_edits"] == 0]
    print(f"\n## Instances with ZERO edit/patch tool calls: {len(no_edit)}/{n}")
    for r in no_edit:
        print(f"  {r['inst']:40s} status={r['status']} reason={r['terminalReason']} tools={r['n_tools']} errs={r['n_errors']}")

    # error categories aggregate
    print("\n## Tool-error categories (aggregate across all instances)")
    agg = Counter()
    for r in rows:
        for k, v in r["err_cats"].items():
            agg[k] += v
    for k, v in agg.most_common():
        print(f"  {k:30s} : {v}")
    insts_with_index_err = [r for r in rows if r["err_cats"].get("code_graph_not_indexed")]
    print(f"\n  instances hitting 'code_graph_not_indexed': {len(insts_with_index_err)}/{n}")

    # tool usage aggregate
    print("\n## Most-used tools (aggregate)")
    tagg = Counter()
    for r in rows:
        for k, v in r["tool_counts"].items():
            tagg[k] += v
    for k, v in tagg.most_common(25):
        print(f"  {k:35s} : {v}")

    # search efficiency
    tot_s = sum(r["n_search"] for r in rows)
    tot_e = sum(r["empty_search"] for r in rows)
    print(f"\n## Search efficiency: {tot_s} search calls, {tot_e} empty ({tot_e/max(tot_s,1)*100:.1f}%)")

    # turns / tokens
    turns = [r["turns"] for r in rows if r["turns"]]
    toks = [r["totalTokens"] for r in rows if r["totalTokens"]]
    print(f"\n## Effort: avg turns={sum(turns)/max(len(turns),1):.1f}  max={max(turns) if turns else 0}")
    print(f"          avg tokens={sum(toks)/max(len(toks),1):,.0f}  max={max(toks) if toks else 0:,}")
    maxturn = [r for r in rows if (r["turns"] or 0) >= 40]
    print(f"  instances >=40 turns: {len(maxturn)}")
    for r in sorted(maxturn, key=lambda x: -(x['turns'] or 0))[:15]:
        print(f"    {r['inst']:40s} turns={r['turns']} status={r['status']} reason={r['terminalReason']} edits={r['n_edits']}")

    # high error instances
    print("\n## Top instances by tool errors")
    for r in sorted(rows, key=lambda x: -x["n_errors"])[:15]:
        print(f"  {r['inst']:40s} errs={r['n_errors']:3d} cats={r['err_cats']} status={r['status']}")

    # heavy search thrashers
    print("\n## Top instances by empty search calls")
    for r in sorted(rows, key=lambda x: -x["empty_search"])[:15]:
        print(f"  {r['inst']:40s} search={r['n_search']:3d} empty={r['empty_search']:3d} status={r['status']}")

if __name__ == "__main__":
    main()
