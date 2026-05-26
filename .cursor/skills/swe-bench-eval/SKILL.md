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

**Full workflow:** [packages/harness/eval/swe-bench/WORKFLOW.md](../../../packages/harness/eval/swe-bench/WORKFLOW.md)

Mac runs **agent** (`pnpm eval:swe --skip-eval`). Cloud runs **Docker grading** (`evaluate.sh`). Mac analyzes **unresolved** via `pnpm eval:swe:analyze`.

## End-to-end loop (5 steps)

```
1. Mac Agent     → ~/.forgelet/runs/swe-bench/eval-<run-id>/predictions.jsonl
                 → ~/.forgelet/traces/swe-bench/eval-<run-id>/instances/*.jsonl
2. Mac tunnel    → start-proxy-tunnel.sh <ECS_IP>
3. Cloud Docker  → ~/forgelet-eval/<model>.<run-id>.json (resolved_ids / unresolved_ids)
4. Mac pull      → runs/eval-<run-id>/cloud-results/*.json
5. Mac analyze   → pnpm eval:swe:analyze -- <run-id> [model] [ecs-ip]
```

| Step | Where | Command |
|------|-------|---------|
| Agent | Mac | `pnpm eval:swe -- --skip-eval --run-id <id> [--limit N]` |
| Tunnel | Mac | `.cursor/skills/swe-bench-eval/scripts/start-proxy-tunnel.sh <ECS_IP>` |
| Grade | Cloud | `bash evaluate.sh ... SWE-bench/SWE-bench_Lite <run-id> 1` |
| Results | Cloud → Mac | `jq '{resolved_ids, unresolved_ids}' *.json` |
| Debug | Mac | `pnpm eval:swe:analyze -- <run-id>` |

Dataset ID: **`SWE-bench/SWE-bench_Lite`** (not `princeton-nlp/...`).

## Before starting

```
- [ ] Repo root, pnpm install, DEEPSEEK_API_KEY in .env
- [ ] pnpm eval:swe:setup (Python venv)
- [ ] run-id chosen; limit or instance-ids if smoke
- [ ] Cloud: ECS IP, HF cache, Docker proxy — if grading on cloud
```

## Workflow A — Agent (Mac)

```bash
pnpm eval:swe -- \
  --dataset lite \
  --run-id <run-id> \
  --instance-ids id1,id2 \
  --skip-eval
```

Artifacts under `~/.forgelet/` (see WORKFLOW.md). Traces on by default; `--no-trace` to disable.

## Workflow B — Cloud grade

**Mac (keep running):**

```bash
.cursor/skills/swe-bench-eval/scripts/start-proxy-tunnel.sh <ECS_IP>
```

**Upload + cloud commands:**

```bash
.cursor/skills/swe-bench-eval/scripts/print-cloud-commands.sh <run-id> <ECS_IP>
```

Cloud eval ends with `deepseek-v4-pro.<run-id>.json` containing `resolved_ids` / `unresolved_ids`.

## Workflow C — Analyze unresolved (Mac)

After pulling the cloud JSON (or pass ECS IP to auto-scp):

```bash
pnpm eval:swe:analyze -- <run-id>
pnpm eval:swe:analyze -- <run-id> deepseek-v4-pro <ECS_IP>
```

For one instance:

```bash
pnpm eval:swe:traces -- --run-id <run-id> --instance <instance_id>
```

## Workflow D — Gold / HF cache

See [WORKFLOW.md](../../../packages/harness/eval/swe-bench/WORKFLOW.md) and [reference.md](reference.md).

## Helper scripts

| Script | Purpose |
|--------|---------|
| `scripts/run-agent.sh` | Agent phase, loads `.env` |
| `scripts/start-proxy-tunnel.sh <ECS_IP>` | pproxy + ssh -R |
| `scripts/print-cloud-commands.sh <run-id> <ECS_IP>` | scp + cloud eval + analyze |
| `packages/harness/eval/swe-bench/analyze-run.sh` | resolved/unresolved + trace summary |

## Agent responsibilities

1. Run agent when asked; use WORKFLOW.md for cloud + analyze steps.
2. Never commit `.env`, predictions, repos, or API keys.
3. Keep pproxy + ssh tunnel up during cloud eval.
4. After cloud grade, run or suggest `pnpm eval:swe:analyze` for unresolved instances.

## Related commands

```bash
pnpm eval:swe:setup
pnpm eval:swe:traces -- --run-id <id>
pnpm eval:swe:verify -- <predictions.jsonl> --run-id <id>
```
