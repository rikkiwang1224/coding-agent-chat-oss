<div align="center">

<img src="brand/lattice-code-icon.svg" width="88" alt="Lattice Code" />

# Lattice Code

**Lattice — the structural layer where code, context, and agents connect.**

Local-first coding agent with a desktop chat app, a terminal CLI, and one shared harness for tools, sessions, and benchmarks.

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-54C7B8.svg)](LICENSE)
[![pnpm](https://img.shields.io/badge/pnpm-8.10-20282A.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-F4A84C.svg)](tsconfig.base.json)

</div>

---

## Overview

Lattice Code is an open-source agent workbench built around a single idea: your repository, conversation history, tool calls, and model context should form one coherent structure—not a pile of disconnected prompts.

The project ships three surfaces on the same engine:

| Surface | Command | Best for |
|---------|---------|----------|
| **Desktop chat** | `pnpm dev` | Workspace picker, threaded history, image attachments, permission UI |
| **Terminal CLI** | `lc` | Scripts, SSH sessions, CI, headless automation |
| **Harness** | `@lattice-code/harness` | Shared agent loop used by chat, CLI, and eval pipelines |

Everything runs locally. API keys and runtime data stay on your machine under `~/.lattice-code/` unless you point the agent elsewhere.

## Features

- **Unified harness** — read/write files, bash, grep, structured tool permissions, session resume, JSONL traces
- **Bring your own model** — DeepSeek, Anthropic, Kimi, GLM, Bedrock, Vertex, or any OpenAI-compatible endpoint
- **Desktop + CLI parity** — same agent behavior in the chat app and `lc`
- **Explicit permissions** — destructive or sensitive tool calls can require confirmation (or `-y` in trusted environments)
- **Benchmark-ready** — synthetic harness tasks, [SWE-bench](packages/harness/eval/swe-bench/README.md) Docker eval, Terminal-Bench via Harbor
- **Small, inspectable scope** — no hosted backend required; the monorepo stays focused on agent UX and the loop itself

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│  chat-desktop       │     │  lc (CLI)           │
│  Electron + React   │     │  terminal REPL      │
└──────────┬──────────┘     └──────────┬──────────┘
           │                           │
           └───────────┬───────────────┘
                       ▼
            ┌─────────────────────┐
            │  @lattice-code/     │
            │  harness            │  tools · LLM · sessions · traces
            └──────────┬──────────┘
                       │
     ┌─────────────────┼─────────────────┐
     ▼                 ▼                 ▼
 sdk-runtime      storage-core      shared-types
 (providers)      (~/.lattice-code)  (events / protocol)
```

Runtime layout, session paths, and trace directories are documented in [docs/design/lattice-code-home-layout.md](docs/design/lattice-code-home-layout.md).

## Quick start

### Desktop

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open **Settings** in the app to choose provider and model. Desktop settings live in Electron user data (`chat-desktop-settings.json`).

### CLI

**Development (no global install)**

```bash
pnpm install
pnpm --filter @lattice-code/cli build:deps
pnpm --filter @lattice-code/cli build
pnpm lc --help
pnpm dev:cli -i    # interactive session via tsx
```

**Global install (local link)**

```bash
pnpm --filter @lattice-code/cli build:deps
pnpm --filter @lattice-code/cli build
cd apps/cli && pnpm link --global
lc --version
```

When published:

```bash
pnpm add -g @lattice-code/cli
```

### First run

```bash
# one-shot
lc "explain how authentication works in src/"

# interactive
lc -i

# another repo
lc -c /path/to/repo "add tests for the parser"
```

## Configuration

Settings merge in this order: **CLI flags** → **environment** → **`~/.lattice-code/config.json`**.

**Config file** (`lc config set`):

```bash
lc config set provider deepseek
lc config set api-key sk-your-key-here
lc config set model deepseek-v4-pro
```

**Environment**:

```bash
export DEEPSEEK_API_KEY=sk-...
export LATTICE_CODE_MODEL=deepseek-v4-pro
export LATTICE_CODE_PROVIDER=deepseek
export LATTICE_CODE_HOME=~/.lattice-code   # optional override
```

Copy `.env.example` to `.env` at the repo root for local development; the CLI loads the nearest `.env` without overriding shell variables.

| Variable | Purpose |
|----------|---------|
| `LATTICE_CODE_HOME` | Root for config, sessions, traces, eval runs |
| `LATTICE_CODE_API_KEY` | API key fallback |
| `LATTICE_CODE_MODEL` / `LATTICE_CODE_PROVIDER` / `LATTICE_CODE_BASE_URL` | Default LLM routing |

Full CLI flags: `lc --help` · config keys: `lc config set --help`

## CLI reference (common)

| Flag | Description |
|------|-------------|
| `-i` | Interactive multi-turn session |
| `-c <dir>` | Workspace root (default: cwd) |
| `-s <id>` / `--resume` | Continue an existing session |
| `-y` | Auto-approve tool permissions |
| `-v` | Verbose tool output |
| `--no-trace` | Disable JSONL under `~/.lattice-code/traces/cli/` |
| `--model`, `--provider`, `--api-key`, `--base-url` | One-run overrides |

```bash
lc --resume -s <session-id> "continue where we left off"
echo "review the diff" | lc
lc -y "run the linter and fix issues"
```

## Provider presets

Anthropic · DeepSeek · Kimi · GLM · Amazon Bedrock · Google Vertex AI · custom OpenAI-compatible endpoints

Desktop Settings and `lc config set` both map to the harness LLM client (`apiKey`, `baseUrl`, `model`).

## Project layout

```
apps/cli              Terminal CLI (`lc`, `lattice-code`)
apps/chat-desktop       Electron chat UI
packages/harness        Agent loop, tools, eval runners
packages/sdk-core       AgentEngine interface
packages/sdk-runtime    Provider presets and cost helpers
packages/shared-types   Events and tool protocol
packages/storage-core   ~/.lattice-code path helpers
brand/                  Icon and brand notes
docs/design/            Storage and product design notes
```

## Development

```bash
pnpm typecheck
pnpm test

# desktop
pnpm --filter @lattice-code/chat-desktop build
pnpm --filter @lattice-code/chat-desktop start

# cli
pnpm --filter @lattice-code/cli test

# harness eval (synthetic tasks; uses repo-root .env)
pnpm eval

# SWE-bench (Mac agent → cloud Docker → trace analysis)
pnpm eval:swe -- --dataset lite --limit 3 --skip-eval --run-id my-run
pnpm eval:swe:analyze -- my-run
```

See [packages/harness/eval/swe-bench/WORKFLOW.md](packages/harness/eval/swe-bench/WORKFLOW.md) for the full benchmark loop.

## Security notes

- Tool permissions are enforced by the harness. Use `-y` only in environments you trust.
- External links from chat open in the system browser; new Electron windows are not created for untrusted URLs.
- API keys are stored locally (desktop settings file or `~/.lattice-code/config.json`). OS keychain integration is not implemented yet.

## Brand

Icon and palette: [brand/BRAND.md](brand/BRAND.md)

## License

[MIT](LICENSE) — Copyright (c) Lattice Code contributors
