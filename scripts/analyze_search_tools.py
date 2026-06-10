#!/usr/bin/env python3
"""Analyze search tool usage patterns in SWE-bench traces.

Focuses on:
1. Which search tools are used and how often
2. Functional overlap between tools
3. "Empty-handed fallback" pattern: tool returns nothing, immediately tries another
"""

import json
import os
import sys
from collections import defaultdict, Counter
from pathlib import Path
from typing import Any

TRACE_BASE = os.path.expanduser("~/.forgelet/traces/swe-bench")
BUCKETS = [
    "eval-lite-108-bucket-a",
    "eval-lite-108-bucket-b",
    "eval-lite-108-bucket-c",
    "eval-lite-108-retry",
]

SEARCH_TOOLS = {
    "code_graph_search",
    "code_graph_semantic_search",
    "code_graph_trace",
    "code_graph_impact",
    "code_graph_architecture",
    "code_graph_snippet",
    "grep_search",
    "file_search",
    "list_dir",
    "read_file",
    "codebase_search",
    "find_by_name",
    "search_files",
    "ripgrep_search",
    "find_files",
    "glob_search",
}

def is_search_tool(name: str) -> bool:
    if name in SEARCH_TOOLS:
        return True
    lower = name.lower()
    for kw in ["search", "grep", "find", "glob", "list_dir"]:
        if kw in lower:
            return True
    return False

def is_empty_result(output: str) -> bool:
    if not output:
        return True
    lower = output.strip().lower()
    if lower in ("", "no results", "no matches", "no results found", "[]", "none"):
        return True
    for phrase in [
        "found 0 result",
        "no result",
        "no matches found",
        "no files found",
        "no match",
        "nothing found",
        "could not find",
        "0 results",
        "no occurrences",
    ]:
        if phrase in lower:
            return True
    return False

def parse_trace(filepath: str):
    """Parse a JSONL trace file and extract tool call/output events."""
    events = []
    with open(filepath, "r") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                event = obj.get("event", {})
                events.append(event)
            except json.JSONDecodeError:
                continue
    return events

def analyze_trace(events: list):
    """Analyze a single trace for search tool patterns."""
    tool_calls = []
    tool_outputs = {}
    
    for event in events:
        etype = event.get("type", "")
        payload = event.get("payload", {})
        
        if etype == "tool.called":
            tool_calls.append({
                "id": payload.get("toolCallId", ""),
                "name": payload.get("toolName", ""),
                "args": payload.get("args", {}),
                "timestamp": event.get("timestamp", ""),
            })
        elif etype == "tool.output":
            tool_outputs[payload.get("toolCallId", "")] = {
                "name": payload.get("toolName", ""),
                "output": payload.get("output", ""),
            }
    
    for tc in tool_calls:
        if tc["id"] in tool_outputs:
            tc["output"] = tool_outputs[tc["id"]]["output"]
            tc["empty"] = is_empty_result(tc["output"])
        else:
            tc["output"] = None
            tc["empty"] = None
    
    return tool_calls

def find_fallback_patterns(tool_calls: list):
    """Find cases where a search tool returns empty and the next call is also a search tool."""
    patterns = []
    search_calls = [(i, tc) for i, tc in enumerate(tool_calls) if is_search_tool(tc["name"])]
    
    for idx in range(len(search_calls) - 1):
        pos_a, call_a = search_calls[idx]
        pos_b, call_b = search_calls[idx + 1]
        
        if call_a.get("empty") and pos_b == pos_a + 1:
            patterns.append({
                "tool_a": call_a["name"],
                "args_a": call_a["args"],
                "output_a": (call_a.get("output", "") or "")[:200],
                "tool_b": call_b["name"],
                "args_b": call_b["args"],
            })
    
    return patterns

def find_consecutive_search_runs(tool_calls: list):
    """Find runs of consecutive search tool calls."""
    runs = []
    current_run = []
    
    for tc in tool_calls:
        if is_search_tool(tc["name"]):
            current_run.append(tc)
        else:
            if len(current_run) >= 2:
                runs.append(current_run)
            current_run = []
    if len(current_run) >= 2:
        runs.append(current_run)
    
    return runs

def find_redundant_searches(tool_calls: list):
    """Find cases where similar queries are issued to different tools."""
    search_calls = [tc for tc in tool_calls if is_search_tool(tc["name"])]
    redundant = []
    
    for i in range(len(search_calls)):
        for j in range(i + 1, min(i + 5, len(search_calls))):
            a = search_calls[i]
            b = search_calls[j]
            if a["name"] == b["name"]:
                continue
            
            args_a_str = json.dumps(a["args"], sort_keys=True).lower()
            args_b_str = json.dumps(b["args"], sort_keys=True).lower()
            
            a_keywords = set(args_a_str.split())
            b_keywords = set(args_b_str.split())
            
            if len(a_keywords & b_keywords) > 3:
                redundant.append({
                    "tool_a": a["name"],
                    "args_a": a["args"],
                    "tool_b": b["name"],
                    "args_b": b["args"],
                })
    
    return redundant

def main():
    all_tool_counts = Counter()
    all_search_tool_counts = Counter()
    all_fallback_patterns = []
    all_redundant = []
    total_instances = 0
    instances_with_fallback = 0
    total_search_calls = 0
    total_empty_search = 0
    
    tool_pair_fallbacks = Counter()
    tool_pair_consecutive = Counter()
    
    per_instance_details = []
    
    for bucket in BUCKETS:
        bucket_dir = os.path.join(TRACE_BASE, bucket, "instances")
        if not os.path.exists(bucket_dir):
            print(f"WARNING: {bucket_dir} does not exist")
            continue
        
        for fname in sorted(os.listdir(bucket_dir)):
            if not fname.endswith(".jsonl"):
                continue
            
            total_instances += 1
            instance_id = fname.replace(".jsonl", "")
            filepath = os.path.join(bucket_dir, fname)
            
            events = parse_trace(filepath)
            tool_calls = analyze_trace(events)
            
            for tc in tool_calls:
                all_tool_counts[tc["name"]] += 1
                if is_search_tool(tc["name"]):
                    all_search_tool_counts[tc["name"]] += 1
                    total_search_calls += 1
                    if tc.get("empty"):
                        total_empty_search += 1
            
            fallbacks = find_fallback_patterns(tool_calls)
            if fallbacks:
                instances_with_fallback += 1
                for fb in fallbacks:
                    pair = (fb["tool_a"], fb["tool_b"])
                    tool_pair_fallbacks[pair] += 1
                    all_fallback_patterns.append({
                        "instance": instance_id,
                        "bucket": bucket,
                        **fb,
                    })
            
            runs = find_consecutive_search_runs(tool_calls)
            for run in runs:
                for k in range(len(run) - 1):
                    pair = (run[k]["name"], run[k + 1]["name"])
                    tool_pair_consecutive[pair] += 1
            
            redundant = find_redundant_searches(tool_calls)
            for r in redundant:
                all_redundant.append({
                    "instance": instance_id,
                    "bucket": bucket,
                    **r,
                })
    
    print("=" * 80)
    print("SEARCH TOOL USAGE ANALYSIS - SWE-bench Lite 108")
    print("=" * 80)
    
    print(f"\nTotal instances analyzed: {total_instances}")
    print(f"Total tool calls: {sum(all_tool_counts.values())}")
    print(f"Total search tool calls: {total_search_calls}")
    print(f"Total empty search results: {total_empty_search} ({total_empty_search/max(total_search_calls,1)*100:.1f}%)")
    
    print("\n" + "-" * 60)
    print("ALL TOOL USAGE (sorted by frequency)")
    print("-" * 60)
    for tool, count in all_tool_counts.most_common():
        marker = " [SEARCH]" if is_search_tool(tool) else ""
        print(f"  {tool:40s} {count:5d}{marker}")
    
    print("\n" + "-" * 60)
    print("SEARCH TOOL USAGE ONLY")
    print("-" * 60)
    for tool, count in all_search_tool_counts.most_common():
        empty = sum(1 for tc in all_fallback_patterns if tc.get("tool_a") == tool)
        print(f"  {tool:40s} {count:5d}")
    
    print("\n" + "-" * 60)
    print(f"EMPTY-THEN-SWITCH FALLBACK PATTERNS ({len(all_fallback_patterns)} total occurrences)")
    print(f"Instances with at least one fallback: {instances_with_fallback}/{total_instances}")
    print("-" * 60)
    
    print("\n  Tool pair fallback frequency (tool_A empty -> tool_B):")
    for pair, count in tool_pair_fallbacks.most_common(20):
        print(f"    {pair[0]:35s} -> {pair[1]:35s} : {count}")
    
    print("\n  Consecutive search tool pairs (any result, not just empty):")
    for pair, count in tool_pair_consecutive.most_common(20):
        print(f"    {pair[0]:35s} -> {pair[1]:35s} : {count}")
    
    print("\n" + "-" * 60)
    print(f"DETAILED FALLBACK EXAMPLES (first 30)")
    print("-" * 60)
    for i, fb in enumerate(all_fallback_patterns[:30]):
        print(f"\n  [{i+1}] Instance: {fb['instance']} ({fb['bucket']})")
        print(f"      Tool A: {fb['tool_a']}")
        print(f"      Args A: {json.dumps(fb['args_a'], ensure_ascii=False)[:150]}")
        print(f"      Output: {fb['output_a'][:150]}")
        print(f"      Tool B: {fb['tool_b']}")
        print(f"      Args B: {json.dumps(fb['args_b'], ensure_ascii=False)[:150]}")
    
    # Per-tool empty rate
    print("\n" + "-" * 60)
    print("PER-TOOL EMPTY RESULT RATE")
    print("-" * 60)
    tool_total = Counter()
    tool_empty = Counter()
    for bucket in BUCKETS:
        bucket_dir = os.path.join(TRACE_BASE, bucket, "instances")
        if not os.path.exists(bucket_dir):
            continue
        for fname in sorted(os.listdir(bucket_dir)):
            if not fname.endswith(".jsonl"):
                continue
            filepath = os.path.join(bucket_dir, fname)
            events = parse_trace(filepath)
            tool_calls = analyze_trace(events)
            for tc in tool_calls:
                if is_search_tool(tc["name"]):
                    tool_total[tc["name"]] += 1
                    if tc.get("empty"):
                        tool_empty[tc["name"]] += 1
    
    for tool in sorted(tool_total.keys(), key=lambda x: tool_total[x], reverse=True):
        total = tool_total[tool]
        empty = tool_empty[tool]
        rate = empty / max(total, 1) * 100
        print(f"  {tool:40s}  total={total:5d}  empty={empty:4d}  rate={rate:5.1f}%")

    print("\n" + "=" * 80)
    print("DONE")
    print("=" * 80)


if __name__ == "__main__":
    main()
