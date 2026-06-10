#!/usr/bin/env python3
"""Deep analysis of search tool overlap and wasteful patterns.

Focus:
1. code_graph_search vs code_graph_code_search vs code_graph_semantic_search overlap
2. Chains of failed code_graph_code_search calls (thrashing)
3. Cases where code_graph_code_search fails but code_graph_search/semantic_search would work
4. Average search calls per instance, and how many are wasted
"""

import json
import os
from collections import Counter, defaultdict
from pathlib import Path

TRACE_BASE = os.path.expanduser("~/.lattice-code/traces/swe-bench")
BUCKETS = [
    "eval-lite-108-bucket-a",
    "eval-lite-108-bucket-b",
    "eval-lite-108-bucket-c",
    "eval-lite-108-retry",
]

def parse_trace(filepath):
    events = []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                events.append(obj.get("event", {}))
            except json.JSONDecodeError:
                continue
    return events

def extract_tool_sequence(events):
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
            tid = payload.get("toolCallId", "")
            tool_outputs[tid] = payload.get("output", "")
    
    for tc in tool_calls:
        tc["output"] = tool_outputs.get(tc["id"], "")
        tc["empty"] = is_empty(tc["output"])
    return tool_calls

def is_empty(output):
    if not output:
        return True
    lower = output.strip().lower()
    for phrase in ["found 0 result", "no result", "no matches found", "no files found",
                   "no match", "nothing found", "0 results"]:
        if phrase in lower:
            return True
    return False

def count_output_results(output):
    """Rough count of results from output text."""
    lower = output.strip().lower()
    if is_empty(output):
        return 0
    for prefix in ["found ", "results: "]:
        idx = lower.find(prefix)
        if idx >= 0:
            rest = lower[idx+len(prefix):]
            num_str = ""
            for c in rest:
                if c.isdigit():
                    num_str += c
                else:
                    break
            if num_str:
                return int(num_str)
    return -1  # unknown but non-empty

def main():
    print("=" * 80)
    print("DEEP SEARCH TOOL OVERLAP ANALYSIS")
    print("=" * 80)

    # 1. Analyze code_graph_code_search thrashing chains
    print("\n" + "=" * 60)
    print("1. code_graph_code_search THRASHING CHAINS")
    print("   (consecutive empty code_graph_code_search calls)")
    print("=" * 60)
    
    thrash_chains = []
    all_instances = []
    
    for bucket in BUCKETS:
        bucket_dir = os.path.join(TRACE_BASE, bucket, "instances")
        if not os.path.exists(bucket_dir):
            continue
        for fname in sorted(os.listdir(bucket_dir)):
            if not fname.endswith(".jsonl"):
                continue
            instance_id = fname.replace(".jsonl", "")
            filepath = os.path.join(bucket_dir, fname)
            tool_calls = extract_tool_sequence(parse_trace(filepath))
            all_instances.append((instance_id, bucket, tool_calls))
            
            chain = []
            for tc in tool_calls:
                if tc["name"] == "code_graph_code_search" and tc["empty"]:
                    chain.append(tc)
                else:
                    if len(chain) >= 2:
                        thrash_chains.append({
                            "instance": instance_id,
                            "bucket": bucket,
                            "length": len(chain),
                            "queries": [c["args"].get("query", "") for c in chain],
                            "file_patterns": [c["args"].get("file_pattern", "") for c in chain],
                        })
                    chain = []
            if len(chain) >= 2:
                thrash_chains.append({
                    "instance": instance_id,
                    "bucket": bucket,
                    "length": len(chain),
                    "queries": [c["args"].get("query", "") for c in chain],
                    "file_patterns": [c["args"].get("file_pattern", "") for c in chain],
                })
    
    print(f"\n  Total thrashing chains (>=2 consecutive empty code_graph_code_search): {len(thrash_chains)}")
    chain_lengths = Counter(c["length"] for c in thrash_chains)
    print(f"  Chain length distribution: {dict(sorted(chain_lengths.items()))}")
    
    print(f"\n  Top 15 longest chains:")
    for i, chain in enumerate(sorted(thrash_chains, key=lambda x: x["length"], reverse=True)[:15]):
        print(f"\n  [{i+1}] Instance: {chain['instance']} ({chain['bucket']}) — chain length {chain['length']}")
        for j, (q, fp) in enumerate(zip(chain["queries"], chain["file_patterns"])):
            print(f"      [{j+1}] query={q!r:60s} file_pattern={fp!r}")

    # 2. Overlap: same query used on different tools
    print("\n" + "=" * 60)
    print("2. SAME/SIMILAR QUERY ACROSS DIFFERENT TOOLS")
    print("   (searching for same thing with different tools)")
    print("=" * 60)
    
    overlap_cases = []
    for instance_id, bucket, tool_calls in all_instances:
        search_tools_used = defaultdict(list)
        for tc in tool_calls:
            if tc["name"] in ("code_graph_search", "code_graph_code_search", 
                              "code_graph_semantic_search", "glob_search"):
                query = tc["args"].get("query", "") or tc["args"].get("name_pattern", "") or tc["args"].get("pattern", "")
                if query:
                    search_tools_used[query.lower().strip()].append({
                        "tool": tc["name"],
                        "args": tc["args"],
                        "empty": tc["empty"],
                    })
        
        for query, usages in search_tools_used.items():
            tools_used = set(u["tool"] for u in usages)
            if len(tools_used) >= 2:
                overlap_cases.append({
                    "instance": instance_id,
                    "bucket": bucket,
                    "query": query,
                    "tools": [(u["tool"], u["empty"]) for u in usages],
                })
    
    print(f"\n  Total cases where same query was sent to >=2 different tools: {len(overlap_cases)}")
    for i, case in enumerate(overlap_cases[:20]):
        print(f"\n  [{i+1}] Instance: {case['instance']} ({case['bucket']})")
        print(f"      Query: {case['query'][:80]}")
        for tool, empty in case["tools"]:
            status = "EMPTY" if empty else "HIT"
            print(f"      -> {tool:35s} [{status}]")
    
    # 3. code_graph_code_search with regex patterns (often fails)
    print("\n" + "=" * 60)
    print("3. code_graph_code_search WITH COMPLEX REGEX (high fail rate)")
    print("=" * 60)
    
    regex_chars = set(".*+?[](){}|\\^$")
    regex_calls = {"total": 0, "empty": 0, "queries": []}
    plain_calls = {"total": 0, "empty": 0}
    
    for instance_id, bucket, tool_calls in all_instances:
        for tc in tool_calls:
            if tc["name"] == "code_graph_code_search":
                query = tc["args"].get("query", "")
                has_regex = bool(set(query) & regex_chars)
                if has_regex:
                    regex_calls["total"] += 1
                    if tc["empty"]:
                        regex_calls["empty"] += 1
                        regex_calls["queries"].append({
                            "instance": instance_id,
                            "query": query,
                            "file_pattern": tc["args"].get("file_pattern", ""),
                        })
                else:
                    plain_calls["total"] += 1
                    if tc["empty"]:
                        plain_calls["empty"] += 1
    
    if regex_calls["total"]:
        print(f"\n  Regex queries:  total={regex_calls['total']}  empty={regex_calls['empty']}  rate={regex_calls['empty']/regex_calls['total']*100:.1f}%")
    if plain_calls["total"]:
        print(f"  Plain queries:  total={plain_calls['total']}  empty={plain_calls['empty']}  rate={plain_calls['empty']/plain_calls['total']*100:.1f}%")
    
    print(f"\n  Sample failed regex queries (first 20):")
    for i, q in enumerate(regex_calls["queries"][:20]):
        print(f"    [{i+1}] query={q['query']!r:60s} file_pattern={q['file_pattern']!r}")
    
    # 4. code_graph_search vs code_graph_code_search usage context
    print("\n" + "=" * 60)
    print("4. TOOL ROLE ANALYSIS: What each tool is used for")
    print("=" * 60)
    
    tool_query_samples = defaultdict(list)
    for instance_id, bucket, tool_calls in all_instances:
        for tc in tool_calls:
            if tc["name"] in ("code_graph_search", "code_graph_code_search", 
                              "code_graph_semantic_search", "glob_search"):
                tool_query_samples[tc["name"]].append({
                    "args": tc["args"],
                    "empty": tc["empty"],
                    "instance": instance_id,
                })
    
    for tool_name in ["code_graph_search", "code_graph_code_search", 
                      "code_graph_semantic_search", "glob_search"]:
        samples = tool_query_samples.get(tool_name, [])
        print(f"\n  {tool_name} — {len(samples)} total calls")
        
        has_query = sum(1 for s in samples if s["args"].get("query"))
        has_name = sum(1 for s in samples if s["args"].get("name_pattern"))
        has_file = sum(1 for s in samples if s["args"].get("file_pattern"))
        has_pattern = sum(1 for s in samples if s["args"].get("pattern"))
        has_label = sum(1 for s in samples if s["args"].get("label"))
        
        print(f"    has query={has_query}, name_pattern={has_name}, file_pattern={has_file}, pattern={has_pattern}, label={has_label}")
        print(f"    Sample args (first 5):")
        for s in samples[:5]:
            print(f"      {json.dumps(s['args'], ensure_ascii=False)[:120]}  [{'EMPTY' if s['empty'] else 'HIT'}]")

    # 5. Per-instance search efficiency
    print("\n" + "=" * 60)
    print("5. PER-INSTANCE SEARCH EFFICIENCY")
    print("=" * 60)
    
    efficiencies = []
    for instance_id, bucket, tool_calls in all_instances:
        search_calls = [tc for tc in tool_calls if tc["name"] in 
                        ("code_graph_search", "code_graph_code_search", 
                         "code_graph_semantic_search", "glob_search")]
        total = len(search_calls)
        empty = sum(1 for tc in search_calls if tc["empty"])
        if total > 0:
            efficiencies.append({
                "instance": instance_id,
                "bucket": bucket,
                "total": total,
                "empty": empty,
                "rate": empty / total * 100,
            })
    
    efficiencies.sort(key=lambda x: x["empty"], reverse=True)
    
    print(f"\n  Top 20 instances by wasted search calls:")
    for i, e in enumerate(efficiencies[:20]):
        print(f"    [{i+1}] {e['instance']:50s} total={e['total']:3d}  empty={e['empty']:3d}  waste_rate={e['rate']:5.1f}%")
    
    avg_total = sum(e["total"] for e in efficiencies) / max(len(efficiencies), 1)
    avg_empty = sum(e["empty"] for e in efficiencies) / max(len(efficiencies), 1)
    print(f"\n  Average search calls per instance: {avg_total:.1f}")
    print(f"  Average empty search calls per instance: {avg_empty:.1f}")

    # 6. What happens after code_graph_code_search fails — what tool "rescues"?
    print("\n" + "=" * 60)
    print("6. RESCUE PATTERNS: What succeeds after code_graph_code_search fails?")
    print("=" * 60)
    
    rescue_tools = Counter()
    rescue_examples = []
    for instance_id, bucket, tool_calls in all_instances:
        for i in range(len(tool_calls) - 1):
            if tool_calls[i]["name"] == "code_graph_code_search" and tool_calls[i]["empty"]:
                next_tc = tool_calls[i + 1]
                if not next_tc["empty"]:
                    rescue_tools[next_tc["name"]] += 1
                    if len(rescue_examples) < 30:
                        rescue_examples.append({
                            "instance": instance_id,
                            "failed_query": tool_calls[i]["args"].get("query", ""),
                            "failed_file_pattern": tool_calls[i]["args"].get("file_pattern", ""),
                            "rescue_tool": next_tc["name"],
                            "rescue_args": next_tc["args"],
                        })
    
    print(f"\n  Tools that rescue after code_graph_code_search fails:")
    for tool, count in rescue_tools.most_common():
        print(f"    {tool:40s} : {count}")
    
    print(f"\n  Example rescues (first 20):")
    for i, ex in enumerate(rescue_examples[:20]):
        print(f"\n    [{i+1}] {ex['instance']}")
        print(f"        Failed: code_graph_code_search query={ex['failed_query']!r:50s} file_pattern={ex['failed_file_pattern']!r}")
        print(f"        Rescue: {ex['rescue_tool']} args={json.dumps(ex['rescue_args'], ensure_ascii=False)[:120]}")

    print("\n" + "=" * 80)
    print("DONE")
    print("=" * 80)


if __name__ == "__main__":
    main()
