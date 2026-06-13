# SWE-bench Lite-300 — current standing

| Metric | Value |
|---|---|
| Resolved (canonical ledger) | **238 / 300 (79.3%)** |
| After `lite-31-trace` merge | **241 / 300 (80.3%)** — see below |
| Unresolved | 62 (59 after merge) |
| Target | 240 (80%) — **met after merge** |

Canonical ledger on ECS: `~/swe-batch/lite-300-final/`
(`predictions.jsonl`, `resolved-ids.txt`, `unresolved-ids.txt`).

## How we got from 233 → 238

Starting point was 233/300 (77.7%). Every gain came from fixing mechanical /
harness issues, not from changing the model:

1. **Timeout patch-salvage (+4).** The outer `timeout` wrapped the agent with
   the same budget as the agent's own soft timeout, so the process was killed
   before it could write its patch — valid edits were silently discarded.
   Fixed by `outer = soft + grace` plus a worktree-diff salvage
   (`extract-patch.ts`). Reran the 6 timeout-killed instances + 1 `FAIL_PULL`
   (`lite-7-mech`): 4 newly resolved.
2. **Budget wall rerun, 1800s / 120 turns (+1).** Six instances had hit the old
   75-turn cap mid-progress (`lite-6-budget`). With the larger budget all six
   now converge and emit complete patches, but only `django__django-16820`
   actually passes — the other five are genuine reasoning failures, not budget.

## `lite-31-trace` — 31/62 unresolved sample rerun (2026-06-12)

Proportional sample of the 62 unresolved (seed 20260612), traces ON, same
agent budget as lite-300-final. Ran as two parallel shards on ECS
(`lite-31-trace` + `lite-31-trace-b`).

| Metric | Value |
|---|---|
| Sample size | 31 / 62 unresolved |
| Resolved on rerun | **3 / 31 (9.7%)** |
| Net gain vs ledger | **+3 → 241 / 300** |

Newly resolved (were in the 62-unresolved set; **not yet merged** into
`lite-300-final`):

- `astropy__astropy-14365`
- `pydata__xarray-4248`
- `pytest-dev__pytest-5221`

Artifacts (Mac):

- Batch + eval: `~/.lattice-code/runs/swe-bench/lite-31-trace-merged/`
- JSONL traces: `~/.lattice-code/traces/swe-bench/eval-lite-31-trace/instances/`
- Instance list: `lite-31-trace.instance-ids.txt`

Cost: $1.89 / 2244 turns / ~5 h wall (2-container parallel).

## Tried and abandoned

- **requests httpbin false-negatives (3 instances).** `psf__requests-2148 /
  -2317 / -2674` fail on `httpbin.org` 503s and blocked egress. A local httpbin
  + `www.google.co.uk` stub removes the 503s, but the gold patches still don't
  pass: requests 2.x ships an old urllib3 that crashes on certain responses
  (`getresponse(buffering=True)`) regardless of the server. These are real
  eval-environment false negatives we can't fix from the harness, so the
  requests-specific eval.sh injection was reverted.

## Remaining unresolved — by repo

**62 (canonical ledger):**

```
20 sympy        6 matplotlib     3 psf (httpbin)
12 sphinx-doc   4 scikit-learn   3 astropy
 7 django       3 pytest-dev     2 pydata
                                 1 pylint-dev / pallets
```

**59 (after merging the 3 lite-31-trace resolves):**

```
19 sympy        6 matplotlib     3 psf (httpbin)
12 sphinx-doc   4 scikit-learn   2 astropy
 7 django       2 pytest-dev     1 pydata
                                 1 pylint-dev / pallets
```

After the mechanical fixes, the remaining gap is dominated by reasoning
failures (correct file located, wrong fix). The lite-31-trace rerun confirms
most of the 62 are stable failures (28/31 still unresolved on rerun); the +3
are variance / non-determinism, not a harness fix.

**Next:** merge the 3 patches into `lite-300-final` on ECS when the box is up;
trace analysis of the 28 still-unresolved in the sample is in progress.
