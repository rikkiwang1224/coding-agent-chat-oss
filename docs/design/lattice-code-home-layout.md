# Lattice Code Home：存储与会话模型

> 存储与会话模型的真相源。Harness 与桌面端集成见 [harness-desktop-integration.md](./harness-desktop-integration.md)。  
> 约定：所有用户数据、评测产物、轨迹 **不进用户 git 仓库、不进本 monorepo**；根目录为 `LATTICE_CODE_HOME`（默认 `~/.lattice-code`）。

---

## 1. 已拍板决策

| 议题 | 决策 |
|------|------|
| `threadId` 与 `agentSessionId` | **永远相等**（一张侧边栏卡片 = 一个 Harness `sessionId`） |
| 侧边栏列表数据源 | **只扫** `LATTICE_CODE_HOME/workspaces/{workspaceHash}/threads/*.json` |
| Session 路径 | `${LATTICE_CODE_HOME}/sessions/{workspaceHash}/{sessionId}.json` |
| 轨迹路径 | `${LATTICE_CODE_HOME}/traces/...`（默认开启，见 §4） |
| 评测产物 | `${LATTICE_CODE_HOME}/runs/...`（与 traces 分离，见 §5） |
| 用户 workspace 内 | **不再写入** `.lattice-code/harness-sessions`、不依赖 `query-loop-sessions` 建列表 |

---

## 2. 产品会话模型

```text
Workspace（用户选中的代码库根）
  └── Chat / Thread（侧边栏 1 张卡片）
        id = threadId = agentSessionId   （三者同一 UUID）
        ├── threads/{threadId}.json       UI：标题、气泡、展示用 toolCalls
        ├── sessions/{workspaceHash}/{threadId}.json   Harness 续跑：messages[]
        └── traces/desktop/{workspaceHash}/{threadId}/trace.jsonl   调试/复盘
```

| 关系 | 基数 | 说明 |
|------|------|------|
| Workspace → Thread | 1 : N | 多个聊天卡片 |
| Thread ↔ agentSessionId | 1 : 1 | **同 ID**，终身不变 |
| 用户每次 Send | resume | `runMode=resume`，`sessionId=threadId`（首轮除外，见下） |
| 单次 Send→agent.done | 1 run | `taskId` 仅用于 trace 分段，**不换** sessionId |

**发消息流程（目标态）**

1. **New Chat** → 生成 `threadId`（UUID），写入空 `threads/{threadId}.json`；尚无 session 文件亦可。
2. **第一次 Send** → `sessionId = threadId`，`runMode=run`（或首次即 `resume` 且空 messages 由 loop 处理）。
3. **后续 Send** → `runMode=resume`，`sessionId=threadId`；Harness `load` → 追加 user → `save`。
4. **agent.done** → 更新 `threads/{threadId}.json` 的 `messages`；trace 追加 jsonl。
5. **切换侧边栏卡片** → 读 `threads/{threadId}.json` 恢复 UI，`setSessionId(threadId)`，下一条 Send 走 resume。

**废弃字段**：`LocalThread.runSessionIds[]` 不再作为真相来源；可保留只读兼容，新写入不再依赖。

---

## 3. Session / Thread / Trace 分工

| 层 | 路径 | 消费者 | 内容 |
|----|------|--------|------|
| **Thread** | `workspaces/{hash}/threads/{threadId}.json` | 侧边栏、聊天气泡 | 人类可读消息 + 展示用 `toolCalls` |
| **Session** | `sessions/{hash}/{sessionId}.json` | Harness `AgentLoop` 续跑 | `SessionData.messages[]`（含 `reasoning_content`） |
| **Trace** | `traces/.../trace.jsonl` | 人、benchmark 复盘 | 全量 `AgentEvent`（delta、权限、完整 tool IO） |

- **Session ≠ Trace**：Session 是给模型的「工作记忆」；Trace 是「黑匣子」，不参与推理。
- **Thread ≠ Session**：Thread 服务 UI；Session 服务 API。run 结束后 Thread 与 Session 应对齐，但格式不同。

---

## 4. 目录布局（`LATTICE_CODE_HOME`）

```text
${LATTICE_CODE_HOME}/                          # 默认 ~/.lattice-code，环境变量 LATTICE_CODE_HOME
├── workspaces/{workspaceHash}/
│   ├── workspace.json
│   ├── session-index.json                 # 可选：该工作区 agent 会话索引
│   └── threads/{threadId}.json            # 侧边栏唯一列表源
├── sessions/{workspaceHash}/
│   └── {sessionId}.json                   # Harness SessionData；sessionId === threadId
└── traces/
    ├── desktop/{workspaceHash}/{sessionId}/
    │   ├── manifest.json
    │   └── trace.jsonl                    # 同 session 多轮 Send 追加
    ├── eval/{runId}/instances/{taskId}.jsonl
    └── swe-bench/{runId}/instances/{instance_id}.jsonl

${LATTICE_CODE_HOME}/runs/                     # 评测结果（非过程）
├── eval/{runId}/report.json
└── swe-bench/{runId}/
    ├── predictions.jsonl
    ├── run-report.json
    └── cloud-results/*.json
```

**环境变量**

| 变量 | 作用 |
|------|------|
| `LATTICE_CODE_HOME` | 上述树根 |
| `LATTICE_CODE_TRACE_ROOT` | 可选，仅覆盖 `traces/` |
| `LATTICE_CODE_RUNS_ROOT` | 可选，仅覆盖 `runs/` |

---

## 5. `traces` 与 `runs` 的关系

同一次 benchmark 共用 `runId`，职责分离：

| 目录 | 存什么 | 用途 |
|------|--------|------|
| `traces/swe-bench/{runId}/` | Agent 过程 JSONL | 查「模型当时干了啥」 |
| `runs/swe-bench/{runId}/` | `predictions.jsonl`、`cloud-results/` | 官方 harness / 通过率 |

复盘：`cloud-results` 找 unresolved id → `traces/.../instances/{id}.jsonl`。

桌面场景通常只有 `traces/desktop/...`，无 `runs/`。

---

## 6. 轨迹（Trace）统一方案

- **写入点**：`HarnessEngine.emitEvent` fan-out → `TraceSink`（默认 `JsonlTraceSink`）+ 调用方 `emit`（IPC）。
- **记录格式**：每行 `TraceRecord` = `{ schemaVersion, runKind, runId, instanceId?, workspaceRoot, event: AgentEvent }`。
- **默认开启**；CLI 使用 `--no-trace` 关闭。废弃 swe-bench 专用 `--save-traces` 与 repo 内 `runs/eval-*` 默认路径。
- **Hooks**：`preToolUse` / `postToolUse` 做策略；**不**与 Trace 双写两套逻辑（审计 = TraceSink 的一种 sink）。

---

## 7. Thread 文件 schema（侧边栏）

```ts
interface ThreadRecord {
  id: string;                    // threadId === agentSessionId
  title: string;
  summary: string;
  placeholder?: string;
  sessionState?: string;
  scope?: string;
  updatedAt: string;             // ISO
  messages: SerializedMessage[]; // UI 气泡
  // runSessionIds?: string[];   // 废弃，勿再写入
}
```

**列表 API**：`listStoredThreads(workspaceRoot)` 仅 `readdir(workspaces/{hash}/threads/)`，不扫 session 目录、不扫用户 repo 下 `.lattice-code`。

**加载会话**：选中卡片 → 读 `threads/{threadId}.json` → `setSessionId(threadId)`；若需完整 tool 历史，可再从 `sessions/{hash}/{threadId}.json` 或 trace 补充（P2）。

---

## 8. Session 文件 schema（Harness）

路径：`sessions/{workspaceHash}/{sessionId}.json`，格式现有 `SessionData`：

```ts
interface SessionData {
  id: string;                    // === threadId
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  metadata: {
    model?: string;
    workspaceRoot?: string;
    turnCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
}
```

`SessionStore` 构造需 `workspaceRoot`（算 hash）+ `sessionId`，不再使用 `resolveHarnessSessionDir(workspaceRoot)` 写入用户仓库。

---

## 9. 迁移与兼容

| 旧路径 | 处理 |
|--------|------|
| `{workspace}/.lattice-code/harness-sessions/*.json` | 不自动迁移；可选一次性导入脚本；新写入只走 `LATTICE_CODE_HOME/sessions/` |
| `~/.lattice-code/sessions/{id}/snapshot.json`（旧 SDK 扁平） | 侧边栏**不**扫描；`loadSessionThread` 可只读回显历史（P1 可选，非列表源） |
| `{workspace}/.lattice-code/query-loop-sessions` | 不再作为列表源 |

