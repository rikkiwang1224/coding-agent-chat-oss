# SWE-bench eval — quick troubleshooting

Full workflow: [packages/harness/eval/swe-bench/WORKFLOW.md](../../../packages/harness/eval/swe-bench/WORKFLOW.md)

Final scoring path: **Mac fetch → ECS `docker-batch.sh` (agent in instance Docker, self-verify) → `sb-cli submit`.** Mac-only `eval:swe` exists as a fallback (no self-verify, baseline < 10%).

| Symptom | Fix |
|---------|-----|
| `LLM API error 404` from agent | `packages/sdk-runtime/src/providers/presets.ts` had `/anthropic` suffix; pull latest + `pnpm --filter @forgelet/sdk-runtime build` (also on ECS — `"main": "dist/index.js"` makes dist authoritative) |
| `ModuleNotFoundError: No module named 'erfa'` (in container) | conda not activated; ensure `source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed` in `bash -lc` |
| `libnode.so.109: not found` (in container) | Don't mount host node; use prebuilt tarball at `~/node-prebuilt/node-v20/bin/node` |
| `FAIL_PULL` row in `summary.tsv` | docker hub throttle; `grep -v <id> done.txt > done.txt.new && mv done.txt.new done.txt`, then rerun batch (resume-safe) |
| ECS disk near full | Lower `KEEP_IMAGES` (default 15) or `docker image prune -a -f --filter "until=2h"` |
| Single instance never completes | Check `logs/<id>/agent.log`; raise `PER_INSTANCE_TIMEOUT` if it's still doing useful work |
| `princeton-nlp/SWE-bench_Lite` fails (Mac fetch) | Use `SWE-bench/SWE-bench_Lite` |
| `.venv/bin/python ENOENT` (Mac fetch) | `pnpm eval:swe:setup` or `SWEBENCH_PYTHON` |
| Mac-only path scored < 10% | Expected. Switch to ECS docker path |

## Config template (optional local file, gitignored)

```bash
# swe-bench.local.env
SWE_CLOUD_HOST=<ECS_IP>
SWE_CLOUD_USER=ubuntu
```
