# SWE-bench eval — quick troubleshooting

Full doc: [packages/harness/eval/swe-bench/README.md](../../../packages/harness/eval/swe-bench/README.md)

| Symptom | Fix |
|---------|-----|
| `princeton-nlp/SWE-bench_Lite` fails | Use `SWE-bench/SWE-bench_Lite` |
| `.venv/bin/python ENOENT` | `pnpm --filter @forgelet/harness eval:swe:setup` or `SWEBENCH_PYTHON` |
| `readFile(...).trim is not a function` | Fixed in `runner.ts`; pull latest |
| Cloud HF unreachable | Mac `hf-cache.tar.gz` + `HF_*_OFFLINE=1` |
| Cloud `raw.githubusercontent.com` unreachable | Mac `pproxy` + `ssh -R 7890:...` + Docker proxy |
| Mac `7890` connection refused | Start `pproxy`; company network ≠ Clash port |
| Only 3 instances ran | User passed `--limit 3` |
| Eval stuck at `0/N` | Normal first instance; check `docker ps` |
| `tar LIBARCHIVE.xattr` | Ignore; use `COPYFILE_DISABLE=1 tar` on Mac |

## Config template (optional local file, gitignored)

User may keep `swe-bench.local.env` (not in repo):

```bash
SWE_CLOUD_HOST=119.91.220.67
SWE_CLOUD_USER=ubuntu
SWE_PROXY_PORT=7890
```
