# SWE-bench Lite-300 — current standing

| Metric | Value |
|---|---|
| Resolved | **238 / 300 (79.3%)** |
| Unresolved | 62 |
| Target | 240 (80%) — short by 2 |

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

## Tried and abandoned

- **requests httpbin false-negatives (3 instances).** `psf__requests-2148 /
  -2317 / -2674` fail on `httpbin.org` 503s and blocked egress. A local httpbin
  + `www.google.co.uk` stub removes the 503s, but the gold patches still don't
  pass: requests 2.x ships an old urllib3 that crashes on certain responses
  (`getresponse(buffering=True)`) regardless of the server. These are real
  eval-environment false negatives we can't fix from the harness, so the
  requests-specific eval.sh injection was reverted.

## Remaining 62 unresolved — by repo

```
20 sympy        6 matplotlib     3 psf (httpbin)
12 sphinx-doc   4 scikit-learn   3 astropy
 7 django       3 pytest-dev     2 pydata
                                 1 pylint-dev / pallets
```

After the mechanical fixes, the remaining gap is dominated by reasoning
failures (correct file located, wrong fix). Closing the last 2 to reach 80%
would require multi-sample selection (best-of-N), which is intentionally out of
scope for now.
