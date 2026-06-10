# 执行环境隔离：ExecutionEnvironment

> ETCLOVG 的 Execution 层。Agent 的命令执行通过 `ExecutionEnvironment` 接口统一接入，隔离策略集中在该层实现，实现可替换。  
> 默认面向桌面端 coding agent，不依赖 Docker；容器实现仅用于评测/CI 等可选场景。

---

## 1. 背景

Agent 通过两类工具访问宿主环境，约束不一致：

| 通道 | 约束 | 说明 |
|------|------|------|
| 文件工具（`read/write/edit/apply_patch`） | `resolvePath()` 限制在 `workspaceRoot` 内 | 路径越界已防护 |
| `bash` | `cwd` 初始为 `workspaceRoot`；命令黑名单；超时 | 可 `cd` 到 workspace 外；继承完整宿主环境变量 |

因此 bash 通道可以读取 shell 环境中的 API key、访问 workspace 外的文件，且不受文件工具路径检查约束。  
本设计将 shell 执行收口到 `ExecutionEnvironment`，在此层施加 env 过滤、资源限制等策略。

---

## 2. 目标与非目标

**目标**

- 命令执行经 `ExecutionEnvironment` 统一入口，隔离逻辑不分散在工具实现中。
- 实现可替换（`LocalEnvironment` / `SandboxedEnvironment` / `DockerEnvironment`），替换时工具层与 Agent 循环无需改动。
- 默认过滤敏感环境变量并设置资源上限，同时保持常见开发任务（构建、测试）可正常运行。
- 通过环境变量提供覆盖项，便于调试或兼容特殊工作流。

**非目标**

- microVM、gVisor 等多租户级隔离（本地 agent 场景暂不引入）。
- 将 Docker 作为桌面端硬依赖。
- 将文件 I/O 纳入执行环境——文件工具已有 workspace 路径限制，当前优先处理 bash 通道。

---

## 3. 架构

```text
ToolExecutor
  └── getExecEnv()  ──►  ExecutionEnvironment（接口）
                              ├── LocalEnvironment        本地 bash（默认）
                              ├── SandboxedEnvironment    macOS Seatbelt / Linux bwrap
                              └── DockerEnvironment       容器（可选）
```

接口（`packages/harness/src/execution/execution-environment.ts`）：

```ts
export interface ExecutionEnvironment {
  execute(command: string, timeoutMs?: number, signal?: AbortSignal):
    Promise<{ exitCode: number; output: string }>;
  getCwd(): Promise<string>;
  destroy(): void;
}
export type ExecutionEnvironmentFactory = (workspaceRoot: string) => ExecutionEnvironment;
```

`ToolExecutorOptions.createExecutionEnvironment` 为注入点，默认 `(root) => new LocalEnvironment(root)`。

| 文件 | 说明 |
|------|------|
| `execution/execution-environment.ts` | 接口与工厂类型 |
| `execution/local-environment.ts` | 默认实现（由原 `ShellSession` 迁移） |
| `tools/shell-session.ts` | 兼容别名：`ShellSession = LocalEnvironment` |
| `tools/executor.ts` | `getExecEnv()` 与工厂注入 |

### 3.1 实现选型

| 实现 | 手段 | 场景 |
|------|------|------|
| `LocalEnvironment` | 环境变量过滤、ulimit、超时 | 桌面端默认 |
| `SandboxedEnvironment` | macOS `sandbox-exec`；Linux `bubblewrap`；Windows 回退为进程级限制 | 需要更强隔离时 |
| `DockerEnvironment` | 容器边界 | CI、SWE-bench 等已有 Docker 的环境 |

若后续在进程级限制文件系统访问，文件工具 I/O 可能也需要经 `ExecutionEnvironment` 路由，接口可据此扩展。

---

## 4. LocalEnvironment 默认行为

### 4.1 环境变量过滤

bash 启动前，对继承的环境变量调用 `redactSensitiveEnv()`（变量名大小写不敏感）：

- 名称模式：`API_KEY`、`ACCESS_KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`PASSWD`、`CREDENTIAL`、`PRIVATE_KEY`、`SESSION_KEY`、`PASSPHRASE`
- 前缀：`AWS_`、`TENCENTCLOUD_`、`ALIYUN_`、`OPENAI_`、`ANTHROPIC_`、`DEEPSEEK_`、`KIMI_`、`MOONSHOT_`、`GLM_`、`ZHIPU_`、`GROQ_`、`GEMINI_`、`MISTRAL_`、`OPENROUTER_`
- 固定名称：`LATTICE_CODE_API_KEY`

过滤后，shell 内无法通过 `printenv` 等命令读取上述变量。

### 4.2 资源限制（ulimit）

在 shell 启动时设置 ulimit；单条命令失败时忽略（`2>/dev/null`），避免影响用户命令的退出码：

| ulimit | 默认值 | 说明 |
|--------|--------|------|
| `-c`（core dump） | `0` | 禁用 core dump |
| `-u`（进程数） | `4096` | 限制子进程数量 |
| `-f`（文件大小） | `~4GB`（4194304 blocks） | 限制单文件写入大小 |

默认值按常见构建/测试负载设置，一般开发任务不应触及上限。

### 4.3 配置覆盖

| 环境变量 | 说明 |
|----------|------|
| `LATTICE_CODE_EXEC_ENV_ALLOW=NAME,NAME` | 指定变量名，跳过过滤（例如保留 `GITHUB_TOKEN`） |
| `LATTICE_CODE_EXEC_ENV_PASSTHROUGH=1` | 关闭过滤，透传全部环境变量 |
| `LATTICE_CODE_EXEC_MAX_PROCS` | 覆盖 `ulimit -u`；设为空或 `unlimited` 表示不限制 |
| `LATTICE_CODE_EXEC_MAX_FILESIZE` | 覆盖 `ulimit -f`（单位：1KB block） |
| `LATTICE_CODE_EXEC_CORE` | 覆盖 `ulimit -c` |
| `LATTICE_CODE_BASH_TIMEOUT_MS` | bash 命令默认超时 |

---

## 5. 业界对照（选型依据）

本地优先的 coding agent 在执行隔离上大致分两个流派，本设计属于前者。

**流派一：OS 原生沙箱（按操作系统分派）** —— 即本设计 `SandboxedEnvironment` 的思路。

| Agent | macOS | Linux |
|-------|-------|-------|
| OpenAI Codex CLI | `sandbox-exec`（Seatbelt） | Landlock + seccomp |
| Claude Code | `sandbox-exec` | `bubblewrap` |
| Gemini CLI | `sandbox-exec` | 容器（Docker/Podman） |

**流派二：容器 / 远程 VM（回避 OS 分派）** —— 统一塞进 Linux 容器或云端 VM，无需 per-OS 代码，但依赖 Docker 或远程基建。

| Agent | 隔离方式 |
|-------|---------|
| OpenHands / SWE-agent | Docker runtime，每任务一容器 |
| Devin | 云端 sandboxed VM |
| Cursor 云端 agent / Codex 云端版 | 远程容器 |

**结论**
- OS 级区分是"本地直接操作用户 workspace"类 agent 的常见做法，非过度设计。
- 本设计 `SandboxedEnvironment`（Seatbelt + bwrap）与 Codex CLI / Claude Code 收敛到同一方案。
- Windows 普遍是短板：多数 agent 在 Windows 上不支持沙箱或退化处理（本设计回退为进程级限制），与业界一致。
- 多数实现将沙箱与网络开关绑定（默认禁网、按需放开），对应本设计 Linux 侧的 `--unshare-net`。

> 备注：上述为撰写时的公开认知，各项目实现持续演进。

---

## 6. 实现状态与待办

| 能力 | 状态 |
|------|------|
| `ExecutionEnvironment` 接口 + 工厂注入点 | ✅ 已实现 |
| `LocalEnvironment`：env 过滤 + ulimit + 超时 | ✅ 已实现（桌面端默认） |
| `SandboxedEnvironment`：OS 级沙箱（macOS `sandbox-exec` / Linux `bubblewrap` / Windows 进程级回退） | ⬜ 待办，暂不开发 |
| `DockerEnvironment`：容器后端 | ⬜ 待办（仅 CI/SWE 场景按需） |

**当前隔离边界**：所有平台统一使用 `LocalEnvironment`，已做到密钥不泄漏给 shell、资源有上限；但**尚无文件系统 / 网络牢笼**——agent 仍可读写 workspace 外文件、可联网。OS 级沙箱（`SandboxedEnvironment`）为后续待办，启动时再按平台分派。
