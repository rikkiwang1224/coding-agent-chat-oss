# Forgelet

Open-source desktop chat client for coding agents powered by the Claude Agent SDK.

![Forgelet icon](brand/forgelet-icon.svg)

Forgelet means "a small forge": a compact local workbench where prompts, tool calls, and code context are shaped into useful changes.

This repository deliberately keeps a small scope:

- Electron desktop chat UI
- workspace picker and workspace-scoped chat history
- image attachments and clipboard image paste
- local model provider settings
- Claude Agent SDK runtime adapter

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

You can configure the provider from the app's Settings screen. Settings are stored locally in Electron's user data directory.

## Security Notes

- Agent runs use the Claude Agent SDK default permission mode. Tool execution and file edits follow the SDK's normal confirmation flow unless you explicitly change the permission mode through environment configuration.
- Links rendered from chat messages are not allowed to create new Electron windows. External `http` and `https` links open in the system browser; other protocols are ignored.
- API keys saved in Settings are stored locally in Electron's user data directory as part of `chat-desktop-settings.json`. This is convenient for local development, but it is not an OS keychain-backed secret store yet.
- Runtime data is stored under `~/.forgelet` by default. Set `FORGELET_HOME` to use a different directory.
- Forgelet calls the Claude Agent SDK with project-scoped settings enabled. By default it writes `.claude/settings.local.json` inside the selected workspace to disable Claude Code attribution trailers in generated git commits. Set `FORGELET_CLAUDE_ATTRIBUTION=1` if you explicitly want those trailers.

## Third-Party Terms

Forgelet source code is MIT licensed. The app also uses the Anthropic Claude Agent SDK as an optional runtime dependency. Anthropic's [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says the TypeScript SDK bundles a native Claude Code binary for the user's platform, and that use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service unless a specific component says otherwise.

Forgelet does not offer Claude.ai login or route a user's Claude subscription credentials. Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says third-party products using the Agent SDK should use API key authentication through Claude Console or a supported cloud provider. Users should provide an Anthropic API key, supported cloud-provider credentials, or another Anthropic-compatible provider key in Settings or environment configuration.

Before publishing packaged desktop binaries, review the current Anthropic terms and include any required third-party notices for bundled runtime dependencies.

## Provider Support

The app includes presets for:

- Anthropic
- DeepSeek
- Kimi
- GLM
- Amazon Bedrock
- Google Vertex AI
- Custom Anthropic-compatible endpoints

The runtime maps provider settings into the environment expected by the Claude Agent SDK.

## Project Layout

- `apps/chat-desktop`: Electron main process, preload bridge, and React renderer.
- `packages/harness`: Standalone coding agent loop (tools + LLM) for eval and automation.
  - `packages/harness/eval/tasks`: Synthetic integration tasks (daily harness iteration).
  - `packages/harness/eval/swe-bench`: [SWE-bench](packages/harness/eval/swe-bench/README.md) real-repo benchmark (Mac agent + cloud Docker eval).
- `packages/sdk-runtime`: Claude Agent SDK adapter, provider/env resolution, session snapshots, and cost estimation.
- `packages/sdk-core`: engine/session contracts and runtime config helpers.
- `packages/shared-types`: shared event and tool protocol types.
- `packages/storage-core`: local workspace/session/thread storage helpers.

## Development Commands

```bash
pnpm typecheck
pnpm --filter @forgelet/chat-desktop build
pnpm --filter @forgelet/chat-desktop start

# Harness eval (synthetic tasks)
pnpm --filter @forgelet/harness eval

# SWE-bench (real repos; see packages/harness/eval/swe-bench/README.md)
pnpm --filter @forgelet/harness eval:swe -- --dataset lite --limit 3 --skip-eval
```

## Brand Assets

The source icon and brand notes live in `brand/`.
