---
name: swe-bench-eval
description: >-
  Run Forgelet SWE-bench evaluation end-to-end: Mac harness agent generates
  predictions.jsonl, optional Tencent Cloud Docker grading via evaluate.sh,
  HF offline cache, and pproxy SSH tunnel for GitHub. Use when the user mentions
  SWE-bench, swe-bench eval, eval:swe, real-repo benchmark, tencent-smoke, or
  cloud Docker verification.
---

# SWE-bench Eval (Forgelet)

Mac runs **agent** (`eval:swe --skip-eval`). Cloud runs **Docker grading** (`evaluate.sh`). Full runbook: [packages/harness/eval/swe-bench/README.md](../../../packages/harness/eval/swe-bench/README.md).

## Architecture (do not confuse)

| Step | Where | Command / artifact |
|------|-------|-------------------|
| Agent | Mac, repo root | `pnpm --filter @forgelet/harness eval:swe -- --skip-eval` |
| Output | Mac | `packages/harness/eval/swe-bench/runs/eval-<run-id>/predictions.jsonl` |
| Grade | Cloud ECS | `bash evaluate.sh predictions.jsonl SWE-bench/SWE-bench_Lite <run-id> <workers>` |

Dataset ID for harness: **`SWE-bench/SWE-bench_Lite`** (not `princeton-nlp/...`).

## Before starting

Copy checklist and track progress:

```
- [ ] At repo root: coding-agent-chat-oss/
- [ ] pnpm install done
- [ ] DEEPSEEK_API_KEY in .env (never paste keys in chat/commits)
- [ ] Python venv: packages/harness/eval/swe-bench/.venv (eval:swe:setup)
- [ ] User intent: smoke N / full lite / verify-only / resume
- [ ] If cloud eval: ECS IP, SSH, HF cache on cloud, pproxy+tunnel running
```

Read `.env` for `DEEPSEEK_API_KEY`. Export `SWEBENCH_PYTHON` to `.venv/bin/python` if missing.

## Workflow A — Agent only (Mac)

```bash
# From repo root; scripts/run-agent.sh wraps this
pnpm --filter @forgelet/harness eval:swe -- \
  --dataset lite \
  --limit 3 \
  --skip-eval \
  --run-id <run-id>
```

| Flag | Effect |
|------|--------|
| `--limit N` | Only N instances (omit = 300 on lite) |
| `--skip-eval` | No local Docker |
| `--resume` | Skip instance_ids already in predictions.jsonl |
| `--instance-ids a,b` | Specific tasks |

On success: `Patches: X/X non-empty`. Report path to `predictions.jsonl` and `run-report.json`.

## Workflow B — Upload + cloud grade

**Prerequisites on cloud** (one-time): Docker + Tencent mirror, `~/forgelet-eval` with `evaluate.sh` + `.venv` + `requirements.txt`, HF cache extracted, Docker `http-proxy` to `127.0.0.1:7890`.

**Mac must keep running** during cloud eval:

1. `python3 -m pproxy -l http://127.0.0.1:7890` (or user’s proxy port)
2. `ssh -N -o ServerAliveInterval=60 -R 7890:127.0.0.1:7890 ubuntu@<ECS_IP>`

**Upload:**

```bash
scp packages/harness/eval/swe-bench/runs/eval-<run-id>/predictions.jsonl \
  ubuntu@<ECS_IP>:~/forgelet-eval/predictions.jsonl
```

**Cloud shell** (user or agent via SSH instructions):

```bash
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,mirror.ccs.tencentyun.com
export HF_HOME=$HOME/.cache/huggingface
export HF_HUB_OFFLINE=1
export HF_DATASETS_OFFLINE=1
cd ~/forgelet-eval
export SWEBENCH_PYTHON=$HOME/forgelet-eval/.venv/bin/python
bash evaluate.sh ~/forgelet-eval/predictions.jsonl SWE-bench/SWE-bench_Lite <run-id> 1
```

Progress `0/N` for 30–60+ minutes on first instance is **normal**; suggest `docker ps` to confirm work.

**Results:** `~/forgelet-eval/evaluation_results/<run-id>/results.json` — report **resolved** rate.

## Workflow C — Gold smoke (cloud env check)

```bash
bash evaluate.sh gold SWE-bench/SWE-bench_Lite validate-gold 1
```

Same proxy + HF offline env as Workflow B.

## Workflow D — HF cache Mac → cloud

When cloud cannot reach Hugging Face:

```bash
COPYFILE_DISABLE=1 tar czf ~/hf-cache.tar.gz -C ~/.cache huggingface
scp ~/hf-cache.tar.gz ubuntu@<ECS_IP>:~/
# On cloud: mkdir -p ~/.cache && tar xzf ~/hf-cache.tar.gz -C ~/.cache
```

Mac prefetch check:

```bash
export HF_ENDPOINT=https://hf-mirror.com
.venv/bin/python -c "from datasets import load_dataset; print(len(load_dataset('SWE-bench/SWE-bench_Lite', split='test')))"
# expect 300
```

## Agent responsibilities

1. **Run** Workflow A via `scripts/run-agent.sh` when user wants agent phase (execute, don’t only print).
2. **Ask** for `<run-id>`, `--limit`, and `<ECS_IP>` if missing and cloud grade requested.
3. **Never** commit `.env`, `predictions.jsonl`, `repos/`, `runs/`, or API keys.
4. **Remind** pproxy + ssh -R must stay up during cloud eval.
5. On errors, see [reference.md](reference.md) then README troubleshooting.

## Helper scripts

| Script | Purpose |
|--------|---------|
| `scripts/run-agent.sh` | Agent phase from repo root, loads `.env` |
| `scripts/print-cloud-commands.sh <run-id> <ecs-ip>` | Copy-paste cloud eval + scp block |

## Related commands

```bash
pnpm --filter @forgelet/harness eval:swe:setup
pnpm --filter @forgelet/harness eval:swe:verify -- <path-to-predictions.jsonl> --dataset lite
```
