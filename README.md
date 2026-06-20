<p align="center">
  <img src="brand/lattice-code-icon.svg" width="80" />
</p>

<h1 align="center">Lattice Code</h1>

<p align="center">
  <strong>为 DeepSeek 深度调优的开源编程 Agent</strong><br/>
  本地运行 · 桌面聊天 + 终端 CLI · 自带 SWE-bench 评测流水线
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-54C7B8.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/SWE--bench_Lite--300-80.3%25-brightgreen" alt="SWE-bench Score" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-F4A84C.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/pnpm-8.10-20282A.svg" alt="pnpm" />
</p>

<p align="center">
  <!-- TODO: 替换为你的 demo GIF 或截图 -->
  <!-- <img src="docs/demo.gif" width="700" /> -->
</p>

---

## 为什么选 Lattice Code？

市面上大多数编程 Agent（Aider、Cline、Cursor、Claude Code）都是围绕 Claude 或 GPT 构建的。**Lattice Code 是专门为 DeepSeek 设计的。**

| | Lattice Code | 其他编程 Agent |
|---|---|---|
| **模型适配** | 针对 DeepSeek API 行为、thinking mode、cache 定价深度调优 | 通用适配，未针对特定模型优化 |
| **使用成本** | DeepSeek 定价，远低于 Claude/GPT | 依赖高价闭源模型 |
| **网络要求** | 直连 DeepSeek API，国内无障碍 | 部分需要翻墙 |
| **数据安全** | 完全本地运行，API Key 和数据不出你的机器 | 部分依赖云端服务 |
| **评测能力** | 自带完整 SWE-bench 评测流水线，可复现结果 | 通常不附带评测工具 |

> **SWE-bench Lite-300 得分 80.3%**——这个分数你可以用自带的评测流水线自己跑出来验证。

---

## 功能概览

- **DeepSeek 原生适配** — 默认 `deepseek-v4-pro`，支持 thinking mode（`off` / `high` / `max`），cache 感知的成本追踪
- **桌面 + CLI 双端一致** — Electron 桌面聊天和终端 `lc` 命令共用同一个 harness，行为完全一致
- **统一 harness** — 文件读写、bash、grep、结构化工具权限、会话恢复、JSONL trace
- **多模型可切换** — 也支持 Anthropic、Kimi、GLM、Bedrock、Vertex 等，通过设置一键切换
- **显式权限控制** — 危险操作需确认，信任环境可 `-y` 跳过
- **自带评测** — 内置 SWE-bench Docker 评测、合成任务测试、Terminal-Bench（via Harbor）

---

## 快速开始

### 桌面应用

```bash
pnpm install
cp .env.example .env    # 填入你的 DeepSeek API Key
pnpm dev
```

打开 **Settings** 确认 API Key 和模型（默认 `deepseek-v4-pro`）。

### 终端 CLI

```bash
# 开发模式（无需全局安装）
pnpm install
pnpm --filter @lattice-code/cli build:deps
pnpm --filter @lattice-code/cli build

# 使用
pnpm lc "解释 src/ 下的认证逻辑"      # 单次提问
pnpm dev:cli -i                        # 交互式会话
```

**全局安装：**

```bash
cd apps/cli && pnpm link --global
lc --version

# 或发布后
pnpm add -g @lattice-code/cli
```

### 常用命令

```bash
lc "解释这段代码的作用"                    # 单次提问
lc -i                                     # 交互式多轮对话
lc -c /path/to/repo "给 parser 加测试"    # 指定仓库
lc --resume -s <session-id> "继续"        # 恢复会话
lc -y "跑 linter 并修复问题"              # 自动批准权限
```

---

## 架构

项目提供三个界面，共用同一个 Agent 引擎：

```
┌─────────────────────┐     ┌─────────────────────┐
│  chat-desktop        │     │  lc (CLI)           │
│  Electron + React    │     │  终端 REPL           │
└──────────┬──────────┘     └──────────┬──────────┘
           │                           │
           └───────────┬───────────────┘
                       ▼
            ┌─────────────────────┐
            │  @lattice-code/     │
            │  harness            │  工具 · LLM · 会话 · trace
            └──────────┬──────────┘
                       │
     ┌─────────────────┼─────────────────┐
     ▼                 ▼                 ▼
 sdk-runtime      storage-core      shared-types
 (模型提供商)     (~/.lattice-code)   (事件/协议)
```

| 界面 | 命令 | 适用场景 |
|---|---|---|
| **桌面聊天** | `pnpm dev` | 工作区选择、历史记录、图片附件、权限 UI |
| **终端 CLI** | `lc` | 脚本、SSH、CI、无头自动化 |
| **Harness** | `@lattice-code/harness` | 聊天、CLI、评测流水线共用的 Agent 循环 |

---

## 配置

配置优先级：**CLI 参数** → **环境变量** → **`~/.lattice-code/config.json`**

```bash
# 配置文件
lc config set provider deepseek
lc config set api-key sk-your-key-here
lc config set model deepseek-v4-pro

# 环境变量
export DEEPSEEK_API_KEY=sk-...
export LATTICE_CODE_MODEL=deepseek-v4-pro
export LATTICE_CODE_PROVIDER=deepseek
```

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 主 API Key（也可用 `LATTICE_CODE_API_KEY`） |
| `LATTICE_CODE_HOME` | 配置、会话、trace、评测数据的根目录 |
| `LATTICE_CODE_MODEL` / `LATTICE_CODE_PROVIDER` / `LATTICE_CODE_BASE_URL` | 默认 LLM 路由 |

完整参数：`lc --help` · 配置项：`lc config set --help`

---

## CLI 参数速查

| 参数 | 说明 |
|---|---|
| `-i` | 交互式多轮会话 |
| `-c <dir>` | 工作区根目录（默认当前目录） |
| `-s <id>` / `--resume` | 恢复已有会话 |
| `-y` | 自动批准工具权限 |
| `-v` | 详细工具输出 |
| `--no-trace` | 禁用 `~/.lattice-code/traces/cli/` 下的 JSONL 记录 |
| `--model`, `--provider`, `--api-key`, `--base-url` | 单次运行覆盖 |

---

## 模型支持

**主力模型：** DeepSeek（`https://api.deepseek.com`，默认 `deepseek-v4-pro`）

**也支持：** Anthropic · Kimi · GLM · Amazon Bedrock · Google Vertex AI · 自定义 OpenAI 兼容端点

DeepSeek 是所有场景（CLI、桌面、评测）的默认选择。通过桌面设置或 `lc config set` 切换。

---

## 项目结构

```
apps/cli                终端 CLI（lc / lattice-code）
apps/chat-desktop       Electron 桌面聊天
packages/harness        Agent 循环、工具、评测运行器
packages/sdk-core       AgentEngine 接口
packages/sdk-runtime    模型提供商预设与成本计算
packages/shared-types   事件与工具协议
packages/storage-core   ~/.lattice-code 路径工具
brand/                  图标与品牌规范
docs/design/            存储与产品设计文档
```

---

## 开发与评测

```bash
pnpm typecheck          # 类型检查
pnpm test               # 运行测试

# 桌面应用
pnpm --filter @lattice-code/chat-desktop build
pnpm --filter @lattice-code/chat-desktop start

# CLI 测试
pnpm --filter @lattice-code/cli test

# Harness 合成任务评测
pnpm eval

# SWE-bench 评测（Mac agent → Docker → trace 分析）
pnpm eval:swe -- --dataset lite --limit 3 --skip-eval --run-id my-run
pnpm eval:swe:analyze -- my-run
```

完整评测流程见 [packages/harness/eval/swe-bench/WORKFLOW.md](packages/harness/eval/swe-bench/WORKFLOW.md)。

---

## 安全说明

- 工具权限由 harness 强制执行，仅在信任环境中使用 `-y`
- 聊天中的外部链接在系统浏览器中打开，不会创建新的 Electron 窗口
- API Key 存储在本地（桌面设置文件或 `~/.lattice-code/config.json`），暂未集成系统钥匙串

---

## 品牌

图标与配色：[brand/BRAND.md](brand/BRAND.md)

## 许可证

[MIT](LICENSE) — Copyright (c) Lattice Code contributors
