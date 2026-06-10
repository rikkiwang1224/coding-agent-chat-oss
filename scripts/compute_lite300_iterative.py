#!/usr/bin/env python3
"""Compute lite-300 resolve rate using iterative retry ledger (not segment sum)."""

from __future__ import annotations

import json
from pathlib import Path

HOME = Path.home()
LATTICE_CODE_RUNS = HOME / ".lattice-code/runs/swe-bench"


def load_report(path: Path) -> dict:
    return json.loads(path.read_text())


def apply_report(status: dict, report: dict) -> tuple[int, int]:
    """Update status dict from eval report. Returns (newly_resolved, updated)."""
    newly = 0
    updated = 0
    for iid in report.get("resolved_ids", []):
        if status.get(iid) is not True:
            newly += 1
        status[iid] = True
        updated += 1
    for key in ("unresolved_ids", "empty_patch_ids", "error_ids"):
        for iid in report.get(key, []):
            if status.get(iid) is True:
                updated += 1
            status[iid] = False
    return newly, updated


def apply_log_dir(status: dict, root: Path) -> tuple[int, int]:
    newly = 0
    updated = 0
    if not root.exists():
        return newly, updated
    for rp in root.glob("*/report.json"):
        iid = rp.parent.name
        data = load_report(rp).get(iid, {})
        resolved = bool(data.get("resolved"))
        if resolved:
            if status.get(iid) is not True:
                newly += 1
            status[iid] = True
        else:
            if status.get(iid) is True:
                updated += 1
            status[iid] = False
        updated += 1
    return newly, updated


def main() -> None:
    all300_path = LATTICE_CODE_RUNS / "lite-full" / "instances.json"
    if not all300_path.exists():
        all300_path = Path("/home/ubuntu/swe-batch/lite-full/instances.json")
    all300 = {i["instance_id"] for i in load_report(all300_path)}

    status: dict[str, bool] = {}

    segments = [
        ("1-50", LATTICE_CODE_RUNS / "lite-50-eval-20260528/eval-report.json"),
        ("51-100", LATTICE_CODE_RUNS / "lite-51-100-rv1-eval-rerun8/eval-report.json"),
        ("101-150", LATTICE_CODE_RUNS / "lite-101-150-base-eval-20260601/eval-report.json"),
        ("151-200", LATTICE_CODE_RUNS / "lite-151-200-base-eval-20260601/eval-report.json"),
        ("201-250", LATTICE_CODE_RUNS / "lite-201-250-base-eval-20260602/eval-report.json"),
        ("251-300", LATTICE_CODE_RUNS / "lite-251-300-cg-eval/eval-report.json"),
    ]

    print("=== Pass 1: initial segment evals ===")
    for name, path in segments:
        if not path.exists():
            print(f"  {name}: MISSING {path}")
            continue
        r = load_report(path)
        apply_report(status, r)
        print(f"  {name}: {len(r.get('resolved_ids', []))} resolved in segment")

    pass1_resolved = sum(1 for v in status.values() if v)
    pass1_unresolved = sum(1 for v in status.values() if not v)
    print(f"  Pass1 cumulative: {pass1_resolved} resolved, {pass1_unresolved} unresolved ({len(status)}/300 tracked)")

    retries = [
        ("lite-108-merged", LATTICE_CODE_RUNS / "lite-108-eval-merged/eval-report.json"),
        ("guard-retest-29", LATTICE_CODE_RUNS / "guard-retest-29/eval-report.json"),
        ("lite-86-v1", LATTICE_CODE_RUNS / "lite-86-eval-v1/eval-report.json"),
    ]

    print("\n=== Retry rounds (overwrite unresolved only) ===")
    for name, path in retries:
        if not path.exists():
            print(f"  {name}: MISSING")
            continue
        r = load_report(path)
        newly, _ = apply_report(status, r)
        print(f"  {name}: +{newly} newly resolved (eval had {len(r.get('resolved_ids', []))} resolved)")

    ecs_log_roots = [
        ("lite-86-v2", Path("/home/ubuntu/coding-agent-chat-oss/packages/harness/eval/swe-bench/logs/run_evaluation/lite-86-eval-v2")),
        ("lite-77-thinking", Path("/home/ubuntu/coding-agent-chat-oss/packages/harness/eval/swe-bench/logs/run_evaluation/lite-77-thinking-eval")),
    ]
    for name, root in ecs_log_roots:
        newly, n = apply_log_dir(status, root)
        if n:
            print(f"  {name}: +{newly} newly resolved ({n} reports)")

    resolved = sum(1 for v in status.values() if v)
    unresolved = sum(1 for v in status.values() if not v)
    missing = all300 - set(status.keys())

    print("\n=== Lite 300 iterative ledger ===")
    print(f"Tracked:              {len(status)}/300")
    print(f"Resolved:             {resolved} ({100*resolved/300:.1f}%)")
    print(f"Unresolved (+empty):  {unresolved}")
    print(f"Missing from ledger:  {len(missing)}")

    # Compare to user's 77 starting point for current round
    u77 = LATTICE_CODE_RUNS.parent
    lite77 = Path("/Users/jinping.wang/Workspace/coding agent/coding-agent-chat-oss/packages/harness/eval/swe-bench/lite-77-unresolved.txt")
    if lite77.exists():
        ids77 = {l.strip() for l in lite77.read_text().splitlines() if l.strip()}
        still_bad = [i for i in ids77 if status.get(i) is not True]
        fixed = [i for i in ids77 if status.get(i) is True]
        print(f"\n=== Current round (started from 77) ===")
        print(f"Starting pool:        77")
        print(f"Now resolved in pool: {len(fixed)}")
        print(f"Still unresolved:     {len(still_bad)}")


if __name__ == "__main__":
    main()
