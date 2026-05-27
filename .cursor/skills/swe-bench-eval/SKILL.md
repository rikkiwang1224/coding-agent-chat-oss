---
name: swe-bench-eval
description: >-
  Run Forgelet SWE-bench evaluation end-to-end. Final scoring path: Mac
  fetches instances.json → ECS docker-batch.sh runs the agent inside each
  instance's official SWE-bench Docker image (agent self-verifies with
  pytest) → predictions.jsonl → sb-cli submit for hosted grading. Mac-only
  pnpm eval:swe remains as a fallback (no self-verify, low baseline). Use
  when the user mentions SWE-bench, swe-bench eval, eval:swe, sb-cli,
  docker-batch, docker-smoke, instance docker, real-repo benchmark, lite-50,
  or cloud Docker verification.
---

# SWE-bench Eval (Forgelet)

**Full workflow:** [packages/harness/eval/swe-bench/WORKFLOW.md](../../../packages/harness/eval/swe-bench/WORKFLOW.md)

## Final scoring path (recommended)

```
1. Mac fetch        → ~/.forgelet/runs/swe-bench/lite-full/instances.json
2. Mac slice        → jq '.[0:50]' ... > lite-50/instances.json
3. Mac sync         → rsync code + instances.json to ECS
4. ECS docker batch → ~/swe-batch/lite-50/predictions.jsonl
                       (agent in /testbed, conda activate testbed, self-verifies)
5. Mac pull         → rsync predictions.jsonl back
6. Mac sb-cli       → hosted scoring, ~minutes
7. Mac analyze      → diff vs gold + logs/<id>/agent.log
```

| Step | Where | Command |
|------|-------|---------|
| Fetch | Mac | `.venv/bin/python fetch_instances.py --dataset lite --output ...` |
| Sync | Mac | `rsync ./ ubuntu@$ECS_IP:~/coding-agent-chat-oss/` + `pnpm --filter @forgelet/sdk-runtime build` on ECS |
| Batch | ECS | `nohup ~/docker-batch.sh ~/swe-batch/instances.json ~/swe-batch/lite-50 > ~/swe-batch/lite-50.log 2>&1 </dev/null &` |
| Submit | Mac | `sb-cli submit swe-bench_lite test --predictions_path ... --run_id ...` |
| Debug | Mac | `less logs/<id>/agent.log` + `diff /tmp/agent.patch /tmp/gold.patch` |

Dataset ID: **`SWE-bench/SWE-bench_Lite`** (not `princeton-nlp/...`).

## Before starting

```
- [ ] Repo root, pnpm install, DEEPSEEK_API_KEY in .env
- [ ] Mac: sb-cli installed + SWEBENCH_API_KEY in env
- [ ] Mac: pnpm eval:swe:setup (Python venv for fetch_instances.py)
- [ ] ECS: docker, ~/node-prebuilt/node-v20, ~/coding-agent-chat-oss installed + sdk-runtime built
- [ ] ECS: ~/coding-agent-chat-oss/.env with DEEPSEEK_API_KEY
- [ ] Run-id chosen
```

## Key scripts (in repo)

| Path | Use |
|------|-----|
| `packages/harness/eval/swe-bench/docker-batch.sh` | Batch over N instances, writes predictions.jsonl |
| `packages/harness/eval/swe-bench/docker-smoke.sh` | Single instance, streams stdout (debug) |
| `packages/harness/eval/swe-bench/fetch_instances.py` | One-time HF dataset fetch |
| `packages/harness/eval/swe-bench/run.ts` | Mac-only fallback path (`pnpm eval:swe`) |

## Fallback — Mac-only (no docker, no self-verify)

Useful for **prompt / tool-chain dev iteration** (small turnaround), not for scoring (baseline < 10%):

```bash
pnpm eval:swe -- \
  --instances ~/.forgelet/runs/swe-bench/lite-50/instances.json \
  --output ~/.forgelet/runs/swe-bench/<run-id> \
  --skip-eval --max-turns 50 --timeout-s 600 --run-id <run-id>
sb-cli submit swe-bench_lite test --predictions_path .../predictions.jsonl --run_id <run-id>
```

## Why "agent in instance Docker" wins

| Aspect | Mac-only | ECS docker batch |
|--------|----------|------------------|
| `pytest` available | ❌ (no python deps) | ✅ (conda testbed env) |
| Agent can self-verify patch | ❌ blind edit | ✅ runs tests, iterates |
| `bash` / `read` / `edit` tools | ✅ on host fs | ✅ inside container fs |
| Baseline pass rate (lite) | ~5-10% | aimed ~30%+ |
| Setup | `pnpm install` only | docker + node tarball + sdk-runtime build |

## Agent responsibilities

1. Use ECS docker path for any "real" scoring run. Mac-only is debug only.
2. Always run `pnpm --filter @forgelet/sdk-runtime build` on ECS after rsync — `"main": "dist/index.js"` makes dist the import root.
3. Never commit `.env`, predictions, repos, or API keys.
4. After scoring, run `diff` agent vs gold patch + read `logs/<id>/agent.log` for unresolved.

## Related commands

```bash
sb-cli get-quotas
sb-cli get-report swe-bench_lite test <run-id> -o ~/.forgelet/runs/swe-bench/sb-cli-reports --overwrite 1
pnpm eval:swe:setup
pnpm eval:swe:traces -- --run-id <id>
pnpm eval:swe:verify -- <predictions.jsonl> --run-id <id>
```
