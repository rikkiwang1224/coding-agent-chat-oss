#!/usr/bin/env python3
"""Merge a partial SWE-bench eval report into a base (full-batch) report.

Use when some instances had empty patches in the first eval, you re-ran the
agent for those ids only, then ran ``run_evaluation --instance_ids ...`` on
just the repaired predictions.  Merge the partial scores into the original
report instead of re-evaluating all N instances.

Usage:
  python3 merge-eval-report.py \\
    --base  ~/.forgelet/runs/swe-bench/lite-51-100-rv1-eval-rerun8/eval-report.json \\
    --partial ~/.forgelet/runs/swe-bench/lite-51-100-rv1-eval-partial8/eval-report.json \\
    --out ~/.forgelet/runs/swe-bench/lite-51-100-rv1-eval-merged/eval-report.json

  # Restrict merge to specific ids (must appear in --partial):
  python3 merge-eval-report.py --base ... --partial ... --out ... \\
    --ids django__django-15061 django__django-15202

Inputs are the ``forgelet-docker*.json`` / ``eval-report.json`` files produced
by ``swebench.harness.run_evaluation`` (schema_version 2).
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

ID_LIST_KEYS = (
    "completed_ids",
    "empty_patch_ids",
    "submitted_ids",
    "resolved_ids",
    "unresolved_ids",
    "error_ids",
    "incomplete_ids",
)

COUNT_KEYS = (
    "submitted_instances",
    "completed_instances",
    "resolved_instances",
    "unresolved_instances",
    "empty_patch_instances",
    "error_instances",
)


def load_report(path: Path) -> dict:
    return json.loads(path.read_text())


def classify_ids(report: dict) -> dict[str, str]:
    """Map instance_id → eval bucket for ids present in *report*."""
    out: dict[str, str] = {}
    for key, label in (
        ("resolved_ids", "resolved"),
        ("unresolved_ids", "unresolved"),
        ("error_ids", "error"),
        ("empty_patch_ids", "empty"),
    ):
        for iid in report.get(key, []) or []:
            out[iid] = label
    return out


def remove_id(report: dict, iid: str, *, keep_submitted: bool = False) -> None:
    for key in ID_LIST_KEYS:
        if keep_submitted and key == "submitted_ids":
            continue
        ids = report.get(key)
        if not ids:
            continue
        report[key] = [x for x in ids if x != iid]


def add_id(report: dict, key: str, iid: str) -> None:
    ids = list(report.get(key, []) or [])
    if iid not in ids:
        ids.append(iid)
    report[key] = sorted(ids)


def recompute_counts(report: dict) -> None:
    report["submitted_instances"] = len(report.get("submitted_ids", []) or [])
    report["resolved_instances"] = len(report.get("resolved_ids", []) or [])
    report["unresolved_instances"] = len(report.get("unresolved_ids", []) or [])
    report["empty_patch_instances"] = len(report.get("empty_patch_ids", []) or [])
    report["error_instances"] = len(report.get("error_ids", []) or [])
    report["completed_instances"] = (
        report["resolved_instances"] + report["unresolved_instances"]
    )


def merge_reports(
    base: dict,
    partial: dict,
    merge_ids: list[str] | None = None,
    *,
    expect_was_empty: bool = True,
) -> dict:
    merged = copy.deepcopy(base)
    partial_status = classify_ids(partial)

    if merge_ids is None:
        empty_in_base = set(merged.get("empty_patch_ids", []) or [])
        merge_ids = sorted(
            iid for iid in partial_status if iid in empty_in_base or not expect_was_empty
        )
        if expect_was_empty:
            # Default: every id in partial that was empty in base.
            merge_ids = sorted(empty_in_base & set(partial_status.keys()))

    if not merge_ids:
        raise SystemExit(
            "error: no instance ids to merge "
            "(partial report has no overlap with base empty_patch_ids)"
        )

    warnings: list[str] = []
    empty_in_base = set(merged.get("empty_patch_ids", []) or [])

    for iid in merge_ids:
        if iid not in partial_status:
            raise SystemExit(
                f"error: {iid} not found in partial report "
                "(resolved/unresolved/error/empty lists)"
            )
        if expect_was_empty and iid not in empty_in_base:
            warnings.append(
                f"{iid}: was not empty in base report (still merging from partial)"
            )

        status = partial_status[iid]
        if status == "empty":
            warnings.append(
                f"{iid}: partial eval still empty — patch missing or harness skipped"
            )

        remove_id(merged, iid, keep_submitted=True)

        if status == "resolved":
            add_id(merged, "resolved_ids", iid)
            add_id(merged, "completed_ids", iid)
        elif status == "unresolved":
            add_id(merged, "unresolved_ids", iid)
            add_id(merged, "completed_ids", iid)
        elif status == "error":
            add_id(merged, "error_ids", iid)
        else:
            add_id(merged, "empty_patch_ids", iid)

    recompute_counts(merged)

    submitted = set(merged.get("submitted_ids", []) or [])
    accounted = (
        set(merged.get("resolved_ids", []) or [])
        | set(merged.get("unresolved_ids", []) or [])
        | set(merged.get("empty_patch_ids", []) or [])
        | set(merged.get("error_ids", []) or [])
    )
    if submitted != accounted:
        warnings.append(
            f"submitted_ids ({len(submitted)}) != resolved+unresolved+empty+error "
            f"({len(accounted)}) after merge — check inputs"
        )

    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)

    return merged


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Merge partial SWE-bench eval report into a base report.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--base",
        type=Path,
        required=True,
        help="Full-batch eval-report.json (may contain empty_patch_ids)",
    )
    parser.add_argument(
        "--partial",
        type=Path,
        required=True,
        help="Partial eval report (--instance_ids run)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Merged eval-report.json output path",
    )
    parser.add_argument(
        "--ids",
        nargs="+",
        metavar="INSTANCE_ID",
        help="Instance ids to merge (default: base empty ∩ partial evaluated)",
    )
    parser.add_argument(
        "--allow-non-empty",
        action="store_true",
        help="Allow merging ids that were not empty in the base report",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print summary only, do not write --out",
    )
    args = parser.parse_args()

    base = load_report(args.base)
    partial = load_report(args.partial)
    merged = merge_reports(
        base,
        partial,
        merge_ids=args.ids,
        expect_was_empty=not args.allow_non_empty,
    )

    resolved = merged["resolved_instances"]
    submitted = merged["submitted_instances"]
    rate = (resolved / submitted * 100) if submitted else 0.0
    print(
        f"merged: {resolved}/{submitted} resolved ({rate:.0f}%), "
        f"empty={merged['empty_patch_instances']}, "
        f"unresolved={merged['unresolved_instances']}, "
        f"error={merged['error_instances']}"
    )

    if args.dry_run:
        return

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(merged, indent=4, ensure_ascii=False) + "\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
