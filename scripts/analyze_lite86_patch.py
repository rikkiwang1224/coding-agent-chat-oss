#!/usr/bin/env python3
"""Compare agent (model) patch vs gold patch for the lite-86 re-run.
Categorizes failure: empty patch, wrong-file (localization miss), right-file-wrong-fix.
"""
import json, os, re
from collections import Counter, defaultdict

RUN = os.path.expanduser("~/.lattice-code/runs/swe-bench")
EVAL = os.path.join(RUN, "lite-86-eval-v1")

def load_report():
    with open(os.path.join(EVAL, "eval-report.json")) as f:
        return json.load(f)

def load_preds():
    preds = {}
    with open(os.path.join(EVAL, "predictions.jsonl")) as f:
        for line in f:
            line=line.strip()
            if not line: continue
            o=json.loads(line)
            preds[o["instance_id"]] = o.get("model_patch") or ""
    return preds

def load_instances():
    inst = {}
    for b in ["a","b","c"]:
        p = os.path.join(RUN, f"lite-86-bucket-{b}", "instances.json")
        if not os.path.exists(p): continue
        with open(p) as f:
            for it in json.load(f):
                inst[it["instance_id"]] = it
    return inst

FILE_RE = re.compile(r'^\+\+\+ b/(.+)$', re.M)
FILE_RE2 = re.compile(r'^diff --git a/(\S+) b/(\S+)', re.M)

def patched_files(diff):
    if not diff: return set()
    files = set(FILE_RE.findall(diff))
    for a,b in FILE_RE2.findall(diff):
        files.add(b)
    return {f for f in files if f and f != "/dev/null"}

def count_hunks(diff):
    return diff.count("\n@@ ") + (1 if diff.startswith("@@ ") else 0) if diff else 0

def main():
    rep = load_report()
    preds = load_preds()
    inst = load_instances()
    resolved = set(rep["resolved_ids"])
    unresolved = set(rep["unresolved_ids"])
    empty = set(rep["empty_patch_ids"])
    error = set(rep["error_ids"])

    cat_counter = Counter()
    wrong_file_list, right_file_list = [], []
    rows = []
    for iid in rep["submitted_ids"]:
        mp = preds.get(iid, "")
        gold = inst.get(iid, {}).get("patch", "")
        mfiles = patched_files(mp)
        gfiles = patched_files(gold)
        overlap = mfiles & gfiles
        if iid in resolved: status="RESOLVED"
        elif iid in empty: status="EMPTY"
        elif iid in error: status="ERROR"
        else: status="UNRESOLVED"

        if not mp.strip():
            cat = "empty_patch"
        elif not (mfiles & gfiles):
            cat = "wrong_file"   # localization miss: no file overlap with gold
        else:
            cat = "right_file"
        rows.append((iid, status, cat, len(mfiles), len(gfiles), len(overlap), mfiles, gfiles))

    print("="*90)
    print("AGENT PATCH vs GOLD PATCH — localization analysis (lite-86 re-run)")
    print("="*90)
    print(f"resolved={len(resolved)} unresolved={len(unresolved)} empty={len(empty)} error={len(error)}")

    # category by status
    print("\n## Failure category among NON-resolved instances")
    nonres = [r for r in rows if r[1] != "RESOLVED"]
    for cat, c in Counter(r[2] for r in nonres).most_common():
        print(f"  {cat:15s} : {c}")

    print("\n## RESOLVED instances - sanity (should be right_file)")
    for r in rows:
        if r[1]=="RESOLVED":
            print(f"  {r[0]:38s} cat={r[2]:11s} mfiles={r[3]} gfiles={r[4]} overlap={r[5]}")

    print("\n## WRONG-FILE failures (agent edited file(s) gold never touched -> localization miss)")
    for r in nonres:
        if r[2]=="wrong_file":
            print(f"  {r[0]:38s} [{r[1]}]")
            print(f"      agent: {sorted(r[6])}")
            print(f"      gold : {sorted(r[7])}")

    print("\n## RIGHT-FILE but UNRESOLVED (correct localization, wrong/incomplete fix)")
    rf = [r for r in nonres if r[2]=="right_file"]
    print(f"  count = {len(rf)}")
    for r in rf:
        # multi-file gold the agent only partly covered?
        missed = r[7] - r[6]
        flag = " <== MISSED gold files: "+str(sorted(missed)) if missed else ""
        print(f"  {r[0]:38s} mfiles={r[3]} gfiles={r[4]} overlap={r[5]}{flag}")

    # multi-file gold patches the agent under-covered
    print("\n## Gold patches spanning MULTIPLE files (harder localization)")
    multi = [r for r in rows if r[4] >= 2]
    for r in multi:
        print(f"  {r[0]:38s} [{r[1]}] goldfiles={r[4]} agentcovered={r[5]}")

if __name__ == "__main__":
    main()
