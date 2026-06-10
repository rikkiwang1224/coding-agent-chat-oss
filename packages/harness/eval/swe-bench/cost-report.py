#!/usr/bin/env python3
"""Generate a per-instance cost/time report for a SWE-bench batch run.

Reads a run directory produced by `docker-batch.sh` and emits:

  <run_dir>/cost-report.tsv   — machine-readable per-instance table
  <run_dir>/cost-report.md    — human-readable Markdown summary

Inputs combined per row:
  - summary.tsv                 → status, patch_lines, wall_s
  - logs/<id>/agent.log footer  → turns, llm_s, cost_usd, cache hit ratio
  - eval-report.json (optional) → eval_status (resolved/unresolved/empty/error)

Logs come from `docker-batch.sh` (ECS) and live at:
  - ECS:  ~/swe-batch/<run>/logs/<id>/agent.log
  - Mac:  ~/.lattice-code/runs/swe-bench/<run>/logs/<id>/agent.log  (after rsync)

Usage:
  python3 cost-report.py <run_dir>
  python3 cost-report.py ~/.lattice-code/runs/swe-bench/lite-50-p0p1-v1
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Optional

ANSI = re.compile(r"\x1b\[[0-9;]*m")
# Footer printed by apps/cli/src/terminal.ts on agent.done:
#   "<turns> turns · <elapsed>s · ~$<cost>"
# Older builds use "·", newer might use "•"; allow either.
FOOTER = re.compile(r"(\d+)\s+turns\s*[·•]\s*([\d.]+)s\s*[·•]\s*~?\$?([\d.]+)")


def parse_footer(log_path: Path) -> dict[str, Optional[float]]:
    if not log_path.is_file():
        return {"turns": None, "llm_s": None, "cost_usd": None}
    text = ANSI.sub("", log_path.read_text(errors="replace"))
    last = None
    for m in FOOTER.finditer(text):
        last = m
    if not last:
        return {"turns": None, "llm_s": None, "cost_usd": None}
    return {
        "turns": int(last.group(1)),
        "llm_s": float(last.group(2)),
        "cost_usd": float(last.group(3)),
    }


def load_eval_status(report_path: Path) -> dict[str, str]:
    """Map instance_id → resolved/unresolved/empty/error from eval-report.json."""
    if not report_path.is_file():
        return {}
    rep = json.loads(report_path.read_text())
    out: dict[str, str] = {}
    for key, label in [
        ("resolved_ids", "resolved"),
        ("unresolved_ids", "unresolved"),
        ("empty_patch_ids", "empty"),
        ("error_ids", "error"),
    ]:
        for inst_id in rep.get(key, []) or []:
            out[inst_id] = label
    return out


def write_tsv(rows: list[dict], path: Path) -> None:
    cols = [
        "instance_id",
        "batch_status",
        "eval_status",
        "cost_usd",
        "turns",
        "llm_s",
        "wall_s",
        "patch_lines",
        "agent_log",
    ]
    with path.open("w") as f:
        f.write("\t".join(cols) + "\n")
        for r in rows:
            f.write(
                "\t".join(
                    str(r.get(c, "") if r.get(c) is not None else "") for c in cols
                )
                + "\n"
            )


def write_markdown(rows: list[dict], totals: dict, path: Path, run_dir: Path) -> None:
    lines: list[str] = []
    lines.append(f"# SWE-bench run cost report — `{run_dir.name}`\n")
    lines.append("")
    lines.append("## Totals")
    lines.append("")
    lines.append(f"- Instances: **{totals['n']}**")
    lines.append(f"- Total LLM cost: **${totals['cost']:.4f}**")
    lines.append(
        f"- Median cost / instance: ${totals['median_cost']:.4f}  ·  max: ${totals['max_cost']:.4f}"
    )
    lines.append(f"- Total agent turns: **{totals['turns']}**")
    lines.append(
        f"- Total agent LLM wall: **{totals['llm_s'] / 60:.1f} min**  ·  total container wall: **{totals['wall_s'] / 60:.1f} min**"
    )
    if totals.get("eval_breakdown"):
        lines.append("")
        lines.append("## Eval breakdown")
        lines.append("")
        lines.append("| status | n | cost ($) | avg turns | avg llm_s |")
        lines.append("|---|---|---|---|---|")
        for status, agg in sorted(totals["eval_breakdown"].items()):
            lines.append(
                f"| {status} | {agg['n']} | {agg['cost']:.4f} | "
                f"{agg['avg_turns']:.1f} | {agg['avg_llm_s']:.1f} |"
            )
    lines.append("")
    lines.append("## Per-instance")
    lines.append("")
    lines.append(
        "| instance_id | eval | cost | turns | llm_s | wall_s | log |"
    )
    lines.append("|---|---|---|---|---|---|---|")
    for r in rows:
        cost = f"${r['cost_usd']:.4f}" if r.get("cost_usd") is not None else "—"
        turns = str(r.get("turns") or "—")
        llm_s = f"{r['llm_s']:.0f}" if r.get("llm_s") is not None else "—"
        wall_s = f"{r['wall_s']:.0f}" if r.get("wall_s") is not None else "—"
        eval_s = r.get("eval_status") or r.get("batch_status") or "—"
        # Relative log path makes the markdown click-friendly inside the run dir.
        log_rel = Path(r["agent_log"]).relative_to(run_dir) if r.get("agent_log") else "—"
        lines.append(
            f"| `{r['instance_id']}` | {eval_s} | {cost} | {turns} | {llm_s} | {wall_s} | `{log_rel}` |"
        )
    path.write_text("\n".join(lines) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run_dir", type=Path, help="batch run directory")
    args = ap.parse_args()

    run_dir: Path = args.run_dir.expanduser().resolve()
    summary_path = run_dir / "summary.tsv"
    logs_dir = run_dir / "logs"
    eval_report = run_dir / "eval-report.json"

    if not summary_path.is_file():
        sys.exit(f"summary.tsv missing under {run_dir}")
    if not logs_dir.is_dir():
        sys.exit(f"logs/ missing under {run_dir}")

    eval_status = load_eval_status(eval_report)

    rows: list[dict] = []
    for line in summary_path.read_text().splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        inst_id, batch_status, patch_lines, wall_s = parts[0], parts[1], parts[2], parts[3]
        log_path = logs_dir / inst_id / "agent.log"
        footer = parse_footer(log_path)
        rows.append(
            {
                "instance_id": inst_id,
                "batch_status": batch_status,
                "eval_status": eval_status.get(inst_id),
                "patch_lines": int(patch_lines) if patch_lines.isdigit() else None,
                "wall_s": float(wall_s) if wall_s.replace(".", "", 1).isdigit() else None,
                "turns": footer["turns"],
                "llm_s": footer["llm_s"],
                "cost_usd": footer["cost_usd"],
                "agent_log": str(log_path) if log_path.is_file() else None,
            }
        )

    rows.sort(key=lambda r: r["instance_id"])

    n = len(rows)
    cost_vals = [r["cost_usd"] for r in rows if r["cost_usd"] is not None]
    cost_vals.sort()
    median_cost = cost_vals[n // 2] if cost_vals else 0.0
    totals = {
        "n": n,
        "cost": sum(cost_vals),
        "median_cost": median_cost,
        "max_cost": max(cost_vals) if cost_vals else 0.0,
        "turns": sum(r["turns"] or 0 for r in rows),
        "llm_s": sum(r["llm_s"] or 0 for r in rows),
        "wall_s": sum(r["wall_s"] or 0 for r in rows),
    }
    # Eval breakdown if we have eval-report.json.
    if eval_status:
        breakdown: dict[str, dict] = {}
        for r in rows:
            status = r.get("eval_status") or "n/a"
            agg = breakdown.setdefault(
                status, {"n": 0, "cost": 0.0, "turns": 0, "llm_s": 0.0}
            )
            agg["n"] += 1
            agg["cost"] += r["cost_usd"] or 0
            agg["turns"] += r["turns"] or 0
            agg["llm_s"] += r["llm_s"] or 0
        for agg in breakdown.values():
            n_c = max(1, agg["n"])
            agg["avg_turns"] = agg["turns"] / n_c
            agg["avg_llm_s"] = agg["llm_s"] / n_c
        totals["eval_breakdown"] = breakdown

    tsv_path = run_dir / "cost-report.tsv"
    md_path = run_dir / "cost-report.md"
    write_tsv(rows, tsv_path)
    write_markdown(rows, totals, md_path, run_dir)

    print(f"Wrote {tsv_path}")
    print(f"Wrote {md_path}")
    print()
    print(
        f"Totals: ${totals['cost']:.4f} across {n} instances  "
        f"(median ${median_cost:.4f}, max ${totals['max_cost']:.4f})"
    )
    print(
        f"        {totals['turns']} turns  ·  agent {totals['llm_s'] / 60:.1f} min  ·  "
        f"container {totals['wall_s'] / 60:.1f} min"
    )
    n_no_footer = sum(1 for r in rows if r["turns"] is None)
    if n_no_footer:
        print(f"        {n_no_footer} instance(s) missing footer — agent crashed/timed-out:")
        for r in rows:
            if r["turns"] is None:
                print(f"          - {r['instance_id']} (status={r['batch_status']})")


if __name__ == "__main__":
    main()
