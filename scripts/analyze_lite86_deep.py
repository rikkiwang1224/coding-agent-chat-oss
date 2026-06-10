#!/usr/bin/env python3
"""Deeper look: incomplete traces, self-verification behavior, and final-summary confidence."""
import json, os, re
from collections import Counter

BASE = os.path.expanduser("~/.lattice-code/traces/swe-bench")
BUCKETS = ["eval-lite-86-bucket-a", "eval-lite-86-bucket-b", "eval-lite-86-bucket-c"]

def parse(fp):
    calls, outputs, errors, done, started = [], {}, [], None, None
    raw_events = []
    with open(fp) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: ev = json.loads(line).get("event", {})
            except: continue
            raw_events.append(ev)
            t, p = ev.get("type",""), ev.get("payload",{})
            if t=="tool.called": calls.append({"id":p.get("toolCallId"),"name":p.get("toolName",""),"args":p.get("args",{})})
            elif t=="tool.output": outputs[p.get("toolCallId")]=p.get("output","")
            elif t=="tool.error": errors.append(p)
            elif t=="agent.done": done=p
            elif t=="agent.started": started=p
    for c in calls: c["output"]=outputs.get(c["id"],"")
    return calls, errors, done, started, raw_events

# Heuristic: did the agent RUN TESTS to verify the fix?
TEST_RE = re.compile(r"\b(pytest|py\.test|tox|unittest|runtests|test\.py|nosetests|python -m pytest|manage\.py test|reproduce)\b", re.I)
def ran_tests(calls):
    cnt = 0
    for c in calls:
        if c["name"] == "bash":
            cmd = json.dumps(c["args"])
            if TEST_RE.search(cmd):
                cnt += 1
    return cnt

def main():
    none_status, verified, not_verified = [], [], []
    for b in BUCKETS:
        d = os.path.join(BASE, b, "instances")
        if not os.path.isdir(d): continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".jsonl"): continue
            inst = fn[:-6]
            calls, errors, done, started, raw = parse(os.path.join(d, fn))
            tcount = ran_tests(calls)
            if done is None:
                none_status.append((inst, b[-1], len(calls), len(raw)))
            (verified if tcount>0 else not_verified).append((inst, tcount, done is not None))

    print("="*80); print("INCOMPLETE TRACES (no agent.done — likely harness crash/timeout/OOM)"); print("="*80)
    for inst, bk, nc, nr in none_status:
        print(f"  {inst:40s} bucket={bk} tool_calls={nc} raw_events={nr}")

    print("\n"+"="*80); print("SELF-VERIFICATION (ran tests / reproduce script via bash)"); print("="*80)
    print(f"  ran tests at least once : {len(verified)}/{len(verified)+len(not_verified)}")
    print(f"  NEVER ran tests         : {len(not_verified)}/{len(verified)+len(not_verified)}")
    print("\n  Instances that NEVER ran any test/reproduce:")
    for inst, tc, hasdone in not_verified:
        print(f"    {inst:40s}")

if __name__ == "__main__":
    main()
