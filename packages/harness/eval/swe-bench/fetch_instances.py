#!/usr/bin/env python3
"""Export SWE-bench instances from HuggingFace to JSON for the TypeScript agent runner."""

from __future__ import annotations

import argparse
import json
import sys

DATASETS = {
    "lite": ("SWE-bench/SWE-bench_Lite", "test"),
    "verified": ("SWE-bench/SWE-bench_Verified", "test"),
    "full": ("SWE-bench/SWE-bench", "test"),
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch SWE-bench instances")
    parser.add_argument(
        "--dataset",
        choices=list(DATASETS.keys()),
        default="lite",
        help="Dataset preset (default: lite)",
    )
    parser.add_argument("--split", default=None, help="Override HF split name")
    parser.add_argument("--output", required=True, help="Output JSON file path")
    parser.add_argument("--limit", type=int, default=None, help="Max instances to export")
    parser.add_argument(
        "--instance-ids",
        nargs="*",
        default=None,
        help="Only export these instance_ids",
    )
    args = parser.parse_args()

    try:
        from datasets import load_dataset
    except ImportError:
        print("Install dependencies: pip install -r requirements.txt", file=sys.stderr)
        sys.exit(1)

    hf_name, default_split = DATASETS[args.dataset]
    split = args.split or default_split

    print(f"Loading {hf_name} split={split}…", file=sys.stderr)
    ds = load_dataset(hf_name, split=split)

    rows: list[dict] = []
    id_set = set(args.instance_ids) if args.instance_ids else None

    for row in ds:
        item = dict(row)
        if id_set and item.get("instance_id") not in id_set:
            continue
        rows.append(item)
        if args.limit and len(rows) >= args.limit:
            break

    if id_set:
        found = {r["instance_id"] for r in rows}
        missing = id_set - found
        if missing:
            print(f"Warning: instance_ids not found: {missing}", file=sys.stderr)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False)

    print(f"Wrote {len(rows)} instance(s) to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
