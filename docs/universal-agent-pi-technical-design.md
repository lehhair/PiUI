# Universal Agent 应用技术设计与工程交接文档

> 文档状态：历史设计稿
> 研究日期：2026-07-24  
> 首个 Agent：Pi  
> UI 参考代码：`/workspace/OpenCodeUI/`  
> Pi SDK 参考代码：`/workspace/pi-mono/`

> 当前实现的数据与远程 API 边界以 [`PI_SDK_API_MATRIX.md`](./PI_SDK_API_MATRIX.md) 为准。本文早期章节中的服务端 timeline/projection 草案已经废弃；浏览器现在直接消费 Pi native entries、native tree 和原始 JSON events，并只在 App 内派生 React 渲染对象。

## 1. 文档目的

本文档用于把现有研究结果直接交给工程团队实施。它不是概念提案，而是首版产品的架构约束、模块边界、协议草案、数据模型、进程生命周期、安全要求、前端改造清单、开发顺序和验收标准。

文中使用以下标记：

- **已验证事实**：来自当前工作区代码和官方 SDK 文档
- **设计决定**：建议首版按此实现，变更时需要记录 ADR
- **待产品决定**：工程开始前或对应阶段前必须确认

## 2. 产品目标

构建一个拥有自定义后端和自有协议的通用 Agent 应用。首个完整接入对象是 Pi，未来其他 Agent 通过独立 Driver 接入。

首版必须做到：

1. 在浏览器或桌面 UI 中创建、恢复和管理 Pi 会话
2. 完整呈现文本、thinking、工具调用、工具结果、重试、压缩和队列状态
3. 保留 Pi 原生的会话树、分支、fork、模型和 thinking level 等能力
4. 提供文件浏览、代码预览、Git diff 和 PTY 终端
5. 支持 Pi skills、prompt templates、extensions 和项目 trust
6. 前后端通过本项目自定义的版本化协议通信
7. 后续增加其他 Agent 时，不要求它们兼容 Pi、ACP 或 OpenCode SDK

## 3. 明确不做的事情

以下内容不属于本项目目标：

- 不兼容 `@opencode-ai/sdk`
- 不实现 OpenCode API 的兼容层
- 不使用 ACP 作为内部协议
- 不把 Pi CLI RPC 作为主要运行方式
- 不把所有 Agent 能力压缩成只有线性聊天和工具调用的最小接口
- 不保证浏览器能渲染任意 Pi TUI `custom()` 组件
- 不声称项目 trust 是沙箱
- 不在共享工作目录模式下声称 session diff 具有严格的因果归属
- 首版不支持多租户云服务。首版安全模型按本机单用户设计

## 4. 研究结论

### 4.1 当前版本基线

**已验证事实**：

- OpenCodeUI 当前版本为 `0.6.34`
- OpenCodeUI 使用 React `19.2.0`、Vite `8.0.3`、TypeScript `5.9.3`
- OpenCodeUI 依赖 `@opencode-ai/sdk ^1.16.0`
- Pi coding-agent 当前包为 `@earendil-works/pi-coding-agent 0.81.1`
- Pi SDK 要求 Node.js `>=22.19.0`
- Pi 代码采用 MIT License
- OpenCodeUI 采用 `GPL-3.0-only`

### 4.2 Pi 应使用 SDK 嵌入

**已验证事实**：Pi SDK 明确支持自定义 Web、桌面和移动 UI。核心入口包括：

- `createAgentSession()`
- `createAgentSessionRuntime()`
- `AgentSession`
- `AgentSessionRuntime`
- `SessionManager`
- `createAgentSessionServices()`
- `createAgentSessionFromServices()`
- `ModelRuntime`
- `SettingsManager`
- `DefaultResourceLoader`

**设计决定**：Pi Driver 的 worker 进程直接导入 SDK。父后端和浏览器均不启动 `pi --mode rpc`。Pi RPC 代码只作为以下能力的实现参考：

- 命令与事件映射
- extension UI 的请求和响应
- runtime 替换后的重新订阅和 extension 重新绑定

原因：RPC 暴露的是固定子集，并明确不支持部分 TUI 能力；SDK 可以直接访问完整 session、runtime、tree、resource 和 event API。

### 4.3 Pi 会话不是线性消息列表

**已验证事实**：Pi session 是 JSONL v3 文件。第一行是 header，后续 entry 通过 `id` 和 `parentId` 形成树。主要 entry 类型包括：

- `message`
- `model_change`
- `thinking_level_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `session_info`

`message` 内的角色包括：

- `user`
- `assistant`
- `toolResult`
- `bashExecution`
- `custom`
- `branchSummary`
- `compactionSummary`

**设计决定**：Pi JSONL 和 `SessionManager` 是 Pi 历史的唯一真相来源。前端聊天列表只是 presentation projection，不能反向替代树，也不能把 JSONL 重写成 OpenCode 的 `message + parts` 格式。

**已验证事实**：`SessionManager.branch()` 和 `resetLeaf()` 只修改内存 leaf，不会单独追加 JSONL entry。无 summary、无 label 的纯 tree navigation 如果在后续消息产生前退出，重新打开文件时 `_buildIndex()` 会把最后追加的 entry 当作 leaf，刚才选择的位置不会由 JSONL 自动恢复。

**设计决定**：应用每次 tree navigation 后把 `active_leaf_id` 和当时的 session fingerprint 保存到 SQLite。重新创建 runtime 时，先打开 `SessionManager`，验证 entry 仍存在且文件 fingerprint 可接受，再调用 `branch(active_leaf_id)` 或 `resetLeaf()`，然后创建 `AgentSession`。一旦检测到文件由外部 Pi 修改，放弃 app checkpoint，以文件当前状态为准并提示用户。

### 4.4 Pi session 文件没有并发写锁

**已验证事实**：`SessionManager` 使用同步 `appendFileSync()` 追加 JSONL，并未对 session 文件使用 `proper-lockfile`。Pi 在 auth、settings 和 trust 文件上使用锁，但 session 文件没有同类保护。

**设计决定**：后端必须保证同一个 Pi session 文件同时最多有一个可写 runtime。多个浏览器 pane 可以订阅同一个 runtime，但不能各自启动 Pi 实例写同一文件。

本项目的 sidecar lock 只能约束本项目进程，不能约束用户同时运行的外部 Pi CLI。因此还需要检测外部修改并进入冲突状态。

### 4.5 Pi 原生安全边界

**已验证事实**：

- Pi 没有内置沙箱
- Pi 和 extension 拥有启动它的系统用户权限
- project trust 只控制项目设置、skills、prompts、themes、packages 和 extensions 的加载
- `AGENTS.md`、`CLAUDE.md` 等上下文文件默认不受 project trust 阻止
- extension 是可执行 TypeScript，拥有完整进程权限

**设计决定**：安全设计必须分成两层：

1. API 层限制浏览器可访问的 workspace、文件、session 和 terminal
2. OS、容器或 VM 层限制 Agent 进程实际拥有的文件、网络和凭据权限

只做 workspace 路径校验，不等于限制 Pi 的 `bash` 工具。

### 4.6 OpenCodeUI 可复用价值与耦合情况

**已验证事实**：OpenCodeUI 的布局、移动端交互、聊天虚拟列表、Markdown、代码、diff、文件浏览器和 xterm 表现成熟。但以下部分直接以 OpenCode SDK 类型为事实来源：

- `src/api/`
- `src/types/api/`
- `src/types/message.ts`
- `src/store/messageStore.ts`
- `src/hooks/useGlobalEvents.ts`
- `src/hooks/useChatSession.ts`
- session、permission、question、model、file 和 PTY 相关 hooks/contexts

`ChatPane`、`MessageRenderer`、`ToolPartView`、`InputBox`、`FileExplorer`、`SessionChangesPanel` 和 `Terminal` 都能保留大量视觉和交互实现，但不能原样接入新后端。

## 5. 必须先决定的产品问题

### 5.1 OpenCodeUI 许可证路线

这是开始复制代码前的硬性决定。

**路线 A：产品接受 GPL-3.0**

- 可以 fork 和修改 OpenCodeUI 源码
- 保留原版权和许可证声明
- 分发修改后的桌面程序或前端代码时，按 GPL 提供对应源码
- 工程仓库和发布流程必须加入 license、NOTICE、source offer 检查

**路线 B：产品需要闭源或非 GPL 分发**

- 不复制 OpenCodeUI 源文件
- 只能把现有产品当作交互需求和视觉参考
- UI 组件必须独立重写，并保留独立设计和提交记录
- 不应先复制再“洗掉”依赖，这在许可证上没有意义

仅在公司内部运行和向外分发的法律后果不同，Web 服务和桌面二进制也不同。最终结论应由法律人员确认，本文不构成法律意见。

Pi 为 MIT License，使用或分发时保留版权和 MIT 文本即可。

### 5.2 运行隔离等级

需要在以下模式中选择首发模式：

| 模式           | Pi 运行位置                  | 适用场景             | 主要限制                 |
| -------------- | ---------------------------- | -------------------- | ------------------------ |
| Local trusted  | 宿主机子进程                 | 个人本机、可信仓库   | Pi 拥有当前用户权限      |
| Container      | 每 workspace 或 session 容器 | 不可信项目、自动任务 | 需要挂载、镜像和凭据管理 |
| Remote sandbox | 远程容器或 VM                | 多用户、无人值守     | 需要文件同步和远程 PTY   |

**建议首版**：只发布 Local trusted，界面明确显示运行边界；同时让 worker launcher 接口可替换，后续增加 Container launcher。

### 5.3 Session diff 的产品语义

必须区分：

- `working-tree`：当前工作区相对 Git/index 的变化
- `branch`：当前分支相对默认分支的变化
- `session-baseline`：当前文件状态相对会话打开时的变化
- `turn-baseline`：当前文件状态相对本轮开始时的变化

共享目录中，外部编辑器、其他 session 和用户命令都可能修改文件。因此后两者只能表示“两个时间点之间的变化”，不能严格证明是谁造成的。

如果产品要求严格归属，必须为每个 session 使用独立 Git worktree 或独立沙箱文件系统。

## 6. 总体架构

### 6.1 进程结构

```text
Browser / Tauri WebView
        |
        | REST + versioned WebSocket
        v
Node.js Orchestrator
  |-- HTTP API and authentication
  |-- Workspace service
  |-- Session registry and command mutex
  |-- Runtime supervisor and session lease
  |-- Event log and replay buffer
  |-- SQLite metadata
  |-- Git and diff service
  |-- PTY service
  |-- Driver registry
        |
        | Node IPC, private protocol
        v
Pi Worker Process, one per active writable runtime
  |-- @earendil-works/pi-coding-agent SDK
  |-- AgentSessionRuntime
  |-- Pi JSONL SessionManager
  |-- Project resources and extensions
  |-- Extension UI bridge
```

### 6.2 为什么使用子进程

**设计决定**：每个活跃的 Pi runtime 放在独立 Node.js child process 中，而不是全部嵌入后端主进程。

理由：

- extension 可以执行任意代码，崩溃和泄漏需要隔离
- session 运行可能长时间占用资源
- 单个 Agent 崩溃不应带走 HTTP、PTY 和其他会话
- worker 可以单独设置环境变量、cwd、uid、资源限制和容器 launcher
- idle session 可以释放进程，再从 JSONL 恢复

子进程不是安全沙箱。Local trusted 模式下，它仍然拥有同一系统用户权限。

### 6.3 运行时共享规则

- 同一个 Pi session 最多一个 writable worker
- 多个 pane 查看同一个 session 时共享 worker 和 event stream
- 每个 pane 保存自己的滚动、折叠、输入草稿和布局状态
- session 的模型、thinking level、队列、streaming、tree leaf 属于共享 runtime 状态
- 一个 pane 修改共享状态，其他 pane 必须同步看到

### 6.4 Fork 与共享 runtime

Pi 的 `AgentSessionRuntime.fork()` 会替换当前 runtime 中的 session。共享 viewer 下不能把这个动作当作当前 pane 的本地导航。

**设计决定**：fork 按以下事务处理：

1. source worker 执行 Pi 原生 `runtime.fork()`，保留 extension hook 语义
2. worker 报告 session identity 从 source 变为 fork target
3. orchestrator 原子更新 worker lease，将该 worker 绑定到新 session
4. 发起 fork 的 pane 导航到新 session
5. 仍查看 source session 的其他 pane 收到 `runtime.released`
6. 如 source 仍有 viewer，orchestrator 为 source 懒加载一个新 worker
7. 两边分别发送最新 snapshot

显式的“打开另一个 session”不调用共享 worker 的 `switchSession()`，而是让 pane 订阅目标 session 对应的 worker。只有 extension 命令内部发起 session replacement 时，才由当前 worker 完成 replacement 并通知 orchestrator。

## 7. 推荐仓库结构

```text
apps/
  web/                    # React UI
  server/                 # HTTP/WS orchestrator
  desktop/                # 可选 Tauri shell
packages/
  protocol/               # TypeBox schema、DTO、事件和命令
  domain/                 # 不依赖 React/Pi 的领域类型和 reducer
  driver-api/             # Driver 接口、capability 定义
  driver-pi/              # Pi adapter、projection、worker client
  pi-worker/              # child process 入口和 SDK 生命周期
  storage/                # SQLite migrations/repositories
  workspace/              # 路径安全、文件、搜索、watch
  git/                    # Git status/diff/baseline
  pty/                    # node-pty 和 replay buffer
  ui/                     # 通用视觉组件，可选
docs/
  architecture/
  adr/
```

**设计决定**：使用 pnpm workspace 或 npm workspace 均可，但全仓 Node 版本锁定到 Pi 要求的 `>=22.19.0`。协议 schema 应从单一 TypeBox 定义同时生成运行时校验和 TypeScript 类型，禁止手写两套结构。

推荐后端组件：

- Fastify 作为 HTTP server
- TypeBox 作为 schema
- WebSocket 使用 Fastify 官方插件或 `ws`
- SQLite 使用 `better-sqlite3`
- PTY 使用 `node-pty`
- Git 使用受控参数的 `git` 子进程，不拼接 shell 字符串
- 测试使用 Vitest 和 Playwright

具体依赖版本在实现时锁定精确版本，并接受依赖安全审查。

## 8. Driver 设计

### 8.1 设计原则

Driver 抽象只统一真正通用的生命周期，不抹掉 Pi 原生能力。

通用能力包括：

- 创建和打开 session
- 获取 snapshot
- prompt、queue、abort
- 订阅事件
- dispose
- 查询 capability

Pi 专属能力放在版本化 namespace 下：

- `pi.sessionTree.v1`
- `pi.compaction.v1`
- `pi.thinkingLevels.v1`
- `pi.promptTemplates.v1`
- `pi.skills.v1`
- `pi.extensions.v1`
- `pi.extensionUI.v1`

### 8.2 Driver 接口草案

```ts
interface AgentDriver {
  readonly manifest: DriverManifest;

  listSessions(input: ListSessionsInput): Promise<DriverSessionSummary[]>;
  createSession(input: CreateSessionInput): Promise<DriverSessionRef>;
  openRuntime(input: OpenRuntimeInput): Promise<AgentRuntime>;
}

interface AgentRuntime {
  readonly ref: DriverSessionRef;

  getSnapshot(): Promise<DriverSnapshot>;
  execute(command: DriverCommand): Promise<DriverCommandResult>;
  subscribe(listener: (event: DriverEvent) => void): () => void;
  dispose(reason: DisposeReason): Promise<void>;
}

interface DriverManifest {
  id: string;
  version: string;
  protocolVersion: number;
  capabilities: Record<string, { version: number; enabled: boolean }>;
}
```

### 8.3 Pi Worker 内部命令

父进程与 worker 使用 Node IPC，不把此协议暴露给浏览器。每条请求包含 `requestId`，worker 返回 response，并独立发送 event。

首版命令：

- `runtime.open`
- `runtime.snapshot`
- `runtime.dispose`
- `session.prompt`
- `session.steer`
- `session.followUp`
- `session.abort`
- `session.setModel`
- `session.setThinkingLevel`
- `session.setSteeringMode`
- `session.setFollowUpMode`
- `session.clearQueue`
- `session.compact`
- `session.abortCompaction`
- `session.setAutoCompaction`
- `session.setAutoRetry`
- `session.abortRetry`
- `session.setName`
- `session.getTree`
- `session.navigateTree`
- `session.fork`
- `session.clone`
- `session.reloadResources`
- `session.setActiveTools`
- `extensionUI.respond`

### 8.4 Pi runtime 创建要求

Worker 的创建流程必须遵循 Pi 自己的 runtime 模式：

1. 创建或打开 `SessionManager`
2. 验证 app leaf checkpoint；有效时先调用 `branch()` 或 `resetLeaf()`
3. 以未信任状态创建 `SettingsManager`
4. 使用 `createAgentSessionServices()` 构建 cwd-bound services
5. 通过 `resourceLoaderReloadOptions.resolveProjectTrust` 完成 trust
6. 使用 `createAgentSessionFromServices()` 创建 session
7. 使用 `createAgentSessionRuntime()` 管理 replacement
8. 调用 `session.bindExtensions()` 绑定 Web extension UI
9. 订阅 `session.subscribe()`
10. runtime 替换后取消旧订阅、重新绑定 extension、重新订阅

不能直接调用最简 `createAgentSession()` 后再补 trust，因为项目 extension 可能已经被加载。

### 8.5 必须映射的 Pi 事件

Pi `AgentSessionEvent` 至少包含以下事件，adapter 不应丢弃：

- `agent_start`
- `agent_end`
- `agent_settled`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `queue_update`
- `entry_appended`
- `session_info_changed`
- `thinking_level_changed`
- `compaction_start`
- `compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `summarization_retry_scheduled`
- `summarization_retry_attempt_start`
- `summarization_retry_finished`

`entry_appended` 只在 extension 通过 `pi.appendEntry()` 追加 custom entry 时由当前实现发出，不能当成所有消息的通用持久化通知。普通 user、assistant 和 toolResult 的 `message_end` 会先通知 subscriber，随后才调用 `SessionManager.appendMessage()`。Worker 收到 `message_end` 时先更新 transient projection，再在当前 handler 退出后的 microtask 或 `agent_settled` 阶段读取 `SessionManager.getEntries()` 做持久化校正。流式 `message_update` 仍是临时状态，worker 崩溃后可能无法恢复，前端必须允许 snapshot 回退到最后已写入 JSONL 的状态。

## 9. 内部领域模型

### 9.1 两层模型

后端和前端都需要区分：

1. **Native model**：Pi header、entries、tree、leaf、原始 message content 和 details
2. **Presentation model**：为聊天列表、工具卡、状态栏和输入框准备的 DTO

Native model 不允许由 presentation reducer 覆盖。Presentation 可以随 UI 版本重建。

### 9.2 Session Snapshot 草案

```ts
interface SessionSnapshotV1 {
  protocolVersion: 1;
  epoch: string;
  sequence: number;

  session: {
    id: string;
    directory: string;
    driverId: "pi";
    driverSessionId: string;
    title?: string;
    state:
      | "idle"
      | "running"
      | "retrying"
      | "compacting"
      | "crashed"
      | "conflict";
    createdAt: string;
    updatedAt: string;
  };

  runtime: {
    attached: boolean;
    model?: ModelRefV1;
    thinkingLevel: string;
    availableThinkingLevels: string[];
    isStreaming: boolean;
    isCompacting: boolean;
    retry?: RetryStateV1;
    queue: QueueStateV1;
    contextUsage?: ContextUsageV1;
    activeTools: string[];
  };

  timeline: TimelineItemV1[];

  native: {
    namespace: "pi";
    schemaVersion: 1;
    leafId: string | null;
    entries: PiSessionEntryDtoV1[];
    tree: PiSessionTreeNodeDtoV1[];
    diagnostics: DiagnosticV1[];
    resources: PiResourceSummaryV1;
  };
}
```

### 9.3 Timeline Item 草案

```ts
type TimelineItemV1 =
  | UserTimelineItemV1
  | AssistantTimelineItemV1
  | BashTimelineItemV1
  | CustomTimelineItemV1
  | CompactionTimelineItemV1
  | BranchSummaryTimelineItemV1
  | StateChangeTimelineItemV1;

interface AssistantTimelineItemV1 {
  type: "assistant";
  id: string;
  entryId?: string;
  parentEntryId?: string | null;
  timestamp: number;
  status: "streaming" | "completed" | "error" | "aborted";
  provider: string;
  model: string;
  stopReason?: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | ToolPresentationV1
  >;
  usage?: UsageV1;
  error?: ProblemV1;
}

interface ToolPresentationV1 {
  type: "tool";
  callId: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  input: unknown;
  output?: Array<TextOrImageContentV1>;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
  normalized?: {
    title?: string;
    cwd?: string;
    exitCode?: number;
    patch?: string;
    files?: FileChangeSummaryV1[];
  };
  nativeDetails?: unknown;
}
```

### 9.4 工具调用配对规则

Pi 的 assistant message 中含 `toolCall` block，随后单独的 `toolResult` message 通过 `toolCallId` 配对。

Projection reducer 必须：

1. 保留原始 assistant entry 和 toolResult entry
2. 在 presentation 中按 `toolCallId` 合并成工具卡
3. 运行时优先使用 `tool_execution_*` 更新 pending/running 状态
4. 最终以持久化 `toolResult` 为准
5. 未找到 result 时保留 pending 或 interrupted 状态，不伪造成功
6. `details` 原样保留，同时提取稳定的 normalized 字段

Pi `edit` 工具会在 `details.patch` 提供标准 unified patch，可直接用于 diff UI。不能假设 `bash` 的文件变化也会有 patch。

### 9.5 附件语义

Pi prompt 原生支持文本和 `ImageContent[]`。OpenCodeUI 当前的任意 file、folder、PDF、audio 和 video attachment 语义不能照搬。

首版规则：

- 图片：服务端校验 MIME 和大小后转换为 Pi `ImageContent`
- 源码文件和目录：在 prompt 中插入 workspace-relative 引用，由 Pi 使用 read/grep 等工具读取
- PDF、音频、视频：只有当前 driver/model 明确声明支持时才开放
- 浏览器不能提交任意宿主机绝对路径

## 10. 浏览器协议

### 10.1 协议原则

- 所有路由带 `/api/v1`
- 所有 WS envelope 带 `protocolVersion`
- 所有命令带客户端生成的 `commandId`
- 所有 session event 带 `epoch` 和单调递增 `sequence`
- snapshot 是恢复真相，event 是增量
- REST 返回错误使用 `application/problem+json`
- 浏览器使用 app session ID 和 canonical workspace path，不接触 Pi session 文件绝对路径

### 10.2 Event Envelope

```ts
interface EventEnvelopeV1<T = unknown> {
  protocolVersion: 1;
  epoch: string;
  sequence: number;
  eventId: string;
  sessionId?: string;
  workspacePath?: string;
  timestamp: string;
  type: string;
  payload: T;
}
```

`epoch` 在 server 或 session event buffer 重建时变化。客户端 reconnect 时提交最后的 `{epoch, sequence}`：

- epoch 相同且 replay buffer 仍保留事件：补发缺失事件
- epoch 不同或事件已淘汰：发送 `session.resync_required`
- 客户端收到后重新获取 snapshot，并用 snapshot 的 sequence 替换本地 cursor

### 10.3 WebSocket 订阅

连接：`GET /api/v1/events`

连接后客户端发送：

```json
{
  "type": "subscribe",
  "sessionIds": ["app-session-id"],
  "cursors": {
    "app-session-id": { "epoch": "...", "sequence": 42 }
  }
}
```

支持后续 `subscribe`、`unsubscribe` 和 `ping`。不要为每个 pane 建独立后端事件连接，页面使用一个连接复用多个 session。

### 10.4 REST 路由草案

#### 系统与 workspace

- `GET /api/v1/health`
- `GET /api/v1/capabilities`
- `GET /api/v1/workspaces`
- `POST /api/v1/workspaces`
- `GET /api/v1/workspaces/:encodedWorkspacePath`
- `DELETE /api/v1/workspaces/:encodedWorkspacePath`
- `POST /api/v1/workspaces/:encodedWorkspacePath/trust`

#### Session

- `GET /api/v1/sessions?workspacePath=&driverId=&cursor=&limit=&search=`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:sessionId`
- `GET /api/v1/sessions/:sessionId/snapshot`
- `DELETE /api/v1/sessions/:sessionId`
- `PATCH /api/v1/sessions/:sessionId/metadata`
- `POST /api/v1/sessions/:sessionId/pin`
- `DELETE /api/v1/sessions/:sessionId/pin`

#### Session command

- `POST /api/v1/sessions/:sessionId/commands/prompt`
- `POST /api/v1/sessions/:sessionId/commands/steer`
- `POST /api/v1/sessions/:sessionId/commands/follow-up`
- `POST /api/v1/sessions/:sessionId/commands/abort`
- `POST /api/v1/sessions/:sessionId/commands/set-model`
- `POST /api/v1/sessions/:sessionId/commands/set-thinking-level`
- `POST /api/v1/sessions/:sessionId/commands/set-tools`
- `POST /api/v1/sessions/:sessionId/commands/compact`
- `POST /api/v1/sessions/:sessionId/commands/abort-compaction`
- `POST /api/v1/sessions/:sessionId/commands/navigate-tree`
- `POST /api/v1/sessions/:sessionId/commands/fork`
- `POST /api/v1/sessions/:sessionId/commands/clone`
- `POST /api/v1/sessions/:sessionId/commands/clear-queue`
- `POST /api/v1/sessions/:sessionId/commands/reload-resources`

命令被接受时返回 `202 Accepted`：

```json
{
  "commandId": "client-generated-uuid",
  "accepted": true,
  "sessionId": "..."
}
```

命令最终结果通过 event 返回。设置类的短命令也可返回同步结果，但仍必须发送状态变更 event。

#### Pi 原生资源

- `GET /api/v1/sessions/:sessionId/pi/tree`
- `GET /api/v1/sessions/:sessionId/pi/entries`
- `GET /api/v1/sessions/:sessionId/pi/commands`
- `GET /api/v1/sessions/:sessionId/pi/skills`
- `GET /api/v1/sessions/:sessionId/pi/prompts`
- `GET /api/v1/sessions/:sessionId/pi/extensions`
- `GET /api/v1/sessions/:sessionId/pi/tools`
- `GET /api/v1/sessions/:sessionId/pi/diagnostics`

#### Extension UI

- `GET /api/v1/sessions/:sessionId/extension-requests`
- `POST /api/v1/sessions/:sessionId/extension-requests/:requestId/respond`
- `POST /api/v1/sessions/:sessionId/extension-requests/:requestId/cancel`

#### 文件和搜索

- `GET /api/v1/workspaces/:encodedWorkspacePath/files?path=`
- `GET /api/v1/workspaces/:encodedWorkspacePath/file?path=`
- `PUT /api/v1/workspaces/:encodedWorkspacePath/file?path=`
- `GET /api/v1/workspaces/:encodedWorkspacePath/search/files?q=`
- `GET /api/v1/workspaces/:encodedWorkspacePath/search/text?q=`
- `GET /api/v1/workspaces/:encodedWorkspacePath/git/status`
- `GET /api/v1/workspaces/:encodedWorkspacePath/git/diff?scope=`
- `GET /api/v1/sessions/:sessionId/diff?scope=session|turn`

#### Model 和凭据

- `GET /api/v1/drivers/pi/models`
- `GET /api/v1/drivers/pi/providers`
- `GET /api/v1/drivers/pi/auth-status`
- `PUT /api/v1/drivers/pi/credentials/:providerId`
- `DELETE /api/v1/drivers/pi/credentials/:providerId`

API 永远不返回原始 key 或 OAuth token。

#### PTY

- `GET /api/v1/workspaces/:encodedWorkspacePath/terminals`
- `POST /api/v1/workspaces/:encodedWorkspacePath/terminals`
- `PATCH /api/v1/terminals/:terminalId`
- `DELETE /api/v1/terminals/:terminalId`
- `POST /api/v1/terminals/:terminalId/ticket`
- `WS /api/v1/terminals/:terminalId/connect?ticket=`

浏览器原生 WebSocket 不能设置自定义 header。不要把长期密码或 API token 放进 URL。先用认证 REST 请求签发 30 秒、单次使用的 WS ticket。

### 10.5 错误码

至少定义：

- `INVALID_REQUEST`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `WORKSPACE_NOT_FOUND`
- `PATH_OUTSIDE_WORKSPACE`
- `SYMLINK_ESCAPE`
- `FILE_TOO_LARGE`
- `STALE_REVISION`
- `SESSION_NOT_FOUND`
- `SESSION_BUSY`
- `SESSION_CONFLICT`
- `SESSION_RUNTIME_CRASHED`
- `DRIVER_UNAVAILABLE`
- `MODEL_NOT_AVAILABLE`
- `PROJECT_TRUST_REQUIRED`
- `EXTENSION_UI_UNSUPPORTED`
- `COMMAND_ALREADY_ACCEPTED`
- `RESYNC_REQUIRED`

错误响应包含稳定 code、用户可读 message、request ID 和可选 details，不能把绝对凭据路径、环境变量或 provider 响应中的密钥返回浏览器。

## 11. 命令并发与幂等

### 11.1 Session command mutex

每个 app session 有一个命令串行器。

- `prompt` 在 idle 时启动新 run
- streaming 时提交 prompt 必须显式选择 `steer` 或 `followUp`
- `abort` 幂等，可绕过普通队列尽快送到 worker
- tree navigation、fork、model 切换和 resource reload 默认只允许 idle
- compaction 按 Pi 原生行为先 abort 当前 operation
- worker replacement 全程持有 session registry 事务锁

### 11.2 Command ID

客户端对用户动作生成 UUID。后端记录 command ledger：

- `received`
- `accepted`
- `completed`
- `failed`
- `unknown_after_crash`

同一 `commandId` 重试时不能再次执行 prompt。worker 在 accepted 后崩溃但无法判断 provider 是否已处理时，标记 `unknown_after_crash`，不得自动重放 prompt。

## 12. 事件存储、回放与背压

### 12.1 Event buffer

每个活跃 session 维护内存 ring buffer，初始建议上限：

- 10,000 个事件，或
- 16 MiB 序列化数据

任一先达到即淘汰最旧事件。服务重启后不要求回放旧 transient event，客户端通过 snapshot 恢复。

### 12.2 Delta 合并

可以在一个 event-loop tick 内合并同一 assistant content block 的连续 text/thinking delta。以下事件不能丢弃或重排：

- command result
- entry appended
- tool start/end
- queue update
- retry state
- compaction state
- extension UI request
- runtime identity change

如果某个 WS 客户端持续跟不上，不允许无限堆积。发送 `resync_required` 后关闭该订阅，由客户端重新拉 snapshot。

## 13. 持久化设计

### 13.1 真相来源

| 数据                  | 真相来源                                                                         |
| --------------------- | -------------------------------------------------------------------------------- |
| Pi 历史和树           | Pi JSONL                                                                         |
| Pi 当前 leaf          | 活跃 runtime；app navigation checkpoint；无有效 checkpoint 时为 JSONL 最后 entry |
| Pi session name       | JSONL `session_info`                                                             |
| App session 映射      | SQLite                                                                           |
| workspace 元数据      | SQLite，以 canonical path 为键                                                   |
| pin、archive、UI 状态 | SQLite                                                                           |
| session/turn baseline | SQLite + app snapshot storage                                                    |
| PTY 活跃状态          | 内存，可选保存元数据                                                             |
| 流式临时消息          | worker 内存 + event buffer                                                       |

不要把 Pi 消息复制进 SQLite 再让 SQLite 成为主历史。可建立可删除的搜索索引或 projection cache，但必须能从 JSONL 重建。

### 13.2 SQLite 表草案

```sql
CREATE TABLE workspaces (
  canonical_root TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL REFERENCES workspaces(canonical_root),
  driver_id TEXT NOT NULL,
  driver_session_id TEXT NOT NULL,
  session_file TEXT,
  active_leaf_id TEXT,
  leaf_checkpoint_present INTEGER NOT NULL DEFAULT 0,
  leaf_checkpoint_fingerprint TEXT,
  cached_title TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(driver_id, driver_session_id)
);

CREATE TABLE session_pins (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ui_state (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, scope_id, key)
);

CREATE TABLE command_ledger (
  command_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  command_type TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE baselines (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_entry_id TEXT,
  kind TEXT NOT NULL,
  snapshot_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE mutation_journal (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_entry_id TEXT,
  tool_call_id TEXT,
  relative_path TEXT NOT NULL,
  before_ref TEXT,
  after_ref TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

SQLite 使用 WAL、foreign keys 和显式 migration。`session_file` 和 `canonical_root` 仅在后端使用，不进入浏览器 DTO。

`active_leaf_id = NULL` 既可能表示 root，也可能表示没有 checkpoint，因此用 `leaf_checkpoint_present` 区分。每次 tree navigation 和每次 authoritative entry append 后都更新 active leaf 与 fingerprint；正常 suspend 前必须完成一次最终 checkpoint。

### 13.3 删除 Session

Pi 官方删除方式是删除 JSONL 文件。应用中应采用可恢复策略：

1. 停止对应 worker
2. 释放 lock
3. 把 JSONL 移入 app trash 目录
4. SQLite 标记 deleted
5. 提供恢复和延迟清理

禁止 UI 直接传任意文件路径给删除接口。

## 14. Runtime supervisor

### 14.1 Runtime 状态

```text
detached -> starting -> idle -> running
                    |       |-> retrying
                    |       |-> compacting
                    |       |-> waiting_for_ui
                    |       |-> idle
                    |-> crashed
                    |-> conflict
idle -> suspending -> detached
```

### 14.2 启动

启动 runtime 时：

1. 校验 workspace 和 session 映射
2. 获取 app sidecar lock
3. 启动 worker，传入 session ref、leaf checkpoint、cwd 和最小环境变量
4. worker 记录 session 文件当前 inode、size、mtime 和内容尾部 hash
5. worker 验证 checkpoint，并在创建 AgentSession 前恢复 leaf
6. 等待 `worker.ready`
7. 获取完整 snapshot
8. 发布 `runtime.attached`

### 14.3 心跳和崩溃

- worker 每 5 秒发送 heartbeat
- 连续 3 次缺失判定失联
- worker exit 时发布 `runtime.crashed`
- 正在执行的 command 标记为 failed 或 unknown
- 保留 stderr 尾部用于诊断，但必须脱敏
- 不自动重放 prompt
- 用户可以重新 attach，从 JSONL 获取最后持久化状态

### 14.4 Idle suspension

初始建议空闲 10 分钟后 suspend，可配置。以下情况不得 suspend：

- agent 正在运行
- compaction 或 retry 正在运行
- 有未处理 extension UI dialog
- runtime replacement 进行中
- 有命令尚未完成

Suspend 时调用 `runtime.dispose()`，等待 extension `session_shutdown` 完成，再退出 worker。不能直接杀进程作为正常 suspend。

### 14.5 Session lock

Parent supervisor 持有以 canonical session file 或 driver session ID 为 key 的 sidecar lock，覆盖 worker 全生命周期。

还要监听 session 文件变化：

- 本 worker 预期 append：更新已知 fingerprint
- 出现非预期 truncate、rewrite 或 append：立即停止新命令
- 发布 `session.conflict`
- 要求用户选择重新加载或复制 session

因为外部 Pi CLI 不遵守 app sidecar lock，检测是必要的第二道保护。

## 15. Extension UI Web Bridge

### 15.1 Web 可完整支持的序列化 UI

根据 Pi `ExtensionUIContext`，首版支持：

- `select`
- `confirm`
- `input`
- `editor`
- `notify`
- `setStatus`
- `setWidget`，仅 `string[]`
- `setTitle`
- `setEditorText`
- `pasteToEditor`，按 setEditorText 语义处理
- `getEditorText`，由 host 中的同步 shadow state 返回

每个等待用户响应的方法生成 request ID、timeout 和 AbortSignal 绑定。请求通过 session event 发到前端，响应通过 REST 送回 worker。

### 15.2 不可直接支持的 TUI 能力

以下接口接收 TUI component factory，不能跨进程序列化到 React：

- `custom()`
- component factory 形式的 `setWidget()`
- `setFooter()`
- `setHeader()`
- `setEditorComponent()`
- `addAutocompleteProvider()`
- `onTerminalInput()`
- TUI theme 和 toolsExpanded 控制

首版处理：

- 在 extension capability 页面标记 `web-compatible`、`partial` 或 `tui-only`
- unsupported 调用返回取消值或明确错误，不能永久 pending
- 记录诊断并在 UI 中显示 extension 名称和不支持的方法
- 不尝试执行或序列化任意 TUI factory

长期可定义独立的 Web Extension API，但它应是新协议，不能假装 TUI component 能自动转成浏览器组件。

### 15.3 Host approval extension

Pi 没有 OpenCode 那套 permission API。需要批准策略时，应用注入一个命名 inline extension，通过 Pi `tool_call` hook 实现：

- read/search 可按 policy 自动允许
- edit/write 可请求确认
- bash 可显示完整命令和 cwd 后请求确认
- policy 可为 `read-only`、`ask`、`auto`
- 用户拒绝时返回 `{ block: true, reason }`

命令分类只能提升可用性，不能作为系统安全边界。真正限制仍由容器、VM、uid、mount 和 network policy 完成。

## 16. Project Trust

### 16.1 正确启动顺序

Trust 必须在加载项目本地 settings、extensions、skills、prompts、themes 和 packages 之前处理。

参考 Pi 自己的流程：

1. `SettingsManager` 先设置 `projectTrusted: false`
2. `DefaultResourceLoader.loadProjectTrustExtensions()` 只加载 global、user 和 inline extension
3. 调用 `resolveProjectTrusted()`
4. Web UI 显示 trust select/confirm
5. 更新 `SettingsManager.projectTrusted`
6. 重新加载最终资源集合

项目 trust 决定按 canonical cwd 保存，父目录最近决定可继承。必须显示“trust 允许执行项目 extension，但不是工具沙箱”。

### 16.2 AGENTS.md 提示

Pi 默认无论 trust 与否都会加载上下文文件，除非关闭 context loading。产品文案必须说明这一点，不能写成“不信任后不会读取项目内容”。

## 17. 文件系统 API 安全

### 17.1 路径规则

- 浏览器只提交 workspace-relative POSIX path
- 拒绝绝对路径、盘符、NUL 和无效 UTF-8
- 规范化 `.` 和 `..`
- 对已存在目标执行 `realpath`
- 对待创建目标执行最近存在父目录的 `realpath`
- 使用 `path.relative(root, target)` 做 containment 判断
- `relative === ".."` 或以 `../` 开头时拒绝
- Windows 需要额外做大小写、UNC 和 junction 处理

### 17.2 Symlink policy

首版建议：允许 symlink，但最终 realpath 必须仍在 workspace 内。指向 workspace 外部的 symlink 在文件树显示为受限节点，不能读取、搜索、预览或写入。

写入时还要防 TOCTOU：

- 打开文件时使用 no-follow 能力或打开后复核 fd 对应路径
- 写临时文件后原子 rename
- rename 前后复核父目录

### 17.3 文件限制

初始建议：

- 普通文本预览 2 MiB
- 二进制预览 10 MiB
- 图片 prompt 20 MiB，随后按 provider 要求缩放
- 搜索单次最多 500 条结果
- 目录单次最多 5,000 个节点，超出分页
- 写入需要 `If-Match` ETag，防止覆盖外部修改

ETag 使用内容 hash 或稳定 revision。收到过期 revision 返回 `STALE_REVISION`，不允许静默覆盖。

## 18. Git 与 Diff

### 18.1 Git 命令安全

- 使用 `spawn("git", args, { cwd })`
- 禁止拼 shell 命令字符串
- 加 `--no-optional-locks` 到只读命令
- 设置超时和输出上限
- 解析 `--porcelain=v2 -z`，不要按空格拆状态输出
- diff 使用 `--no-ext-diff` 和 `--textconv` 策略需明确

### 18.2 四种 diff

`working-tree` 和 `branch` 由 Git service 实时计算。

`session-baseline` 和 `turn-baseline` 采用两类数据：

1. Pi edit/write 工具的 `details.patch` 和 mutation journal
2. 时间点 filesystem baseline 与当前状态比较

对于 bash：

- 工具执行前记录 Git status 和 baseline revision
- 工具结束后重新扫描状态
- 对新出现的 changed path 保存 before/after 引用
- 如果无法取得 before 内容，标记 `beforeUnavailable: true`

首版 UI 必须显示 diff scope 名称。不能把 baseline diff 标成“Agent 修改”而不加限定。

### 18.3 严格归属模式

后续为 session 创建独立 Git worktree：

- session cwd 指向 worktree
- session baseline 为 worktree 创建点
- 所有 session 修改都局限在该目录
- 用户最后显式 merge、apply patch 或 cherry-pick

这是实现严格 session diff 的推荐方式。

## 19. PTY 服务

### 19.1 后端

- 使用 `node-pty`
- terminal 绑定 canonical workspace path 和相对 cwd
- shell 必须来自允许列表或经过服务器设置校验
- 保存 terminal owner、pid、rows、cols、状态和 output cursor
- 每个 terminal 维护有限 output replay buffer
- server shutdown 先发送 SIGHUP/TERM，再按策略清理

### 19.2 WebSocket frame

建议二进制 frame 传 PTY 字节，文本 JSON frame 传 control：

```json
{ "type": "hello", "cursor": 1234 }
{ "type": "resize", "cols": 120, "rows": 40 }
{ "type": "exit", "code": 0, "signal": null }
{ "type": "resync_required" }
```

输入字节通过 binary frame 发往 server。限制 frame 大小和输入速率。重连时提交 cursor，buffer 不足则提示终端历史不完整。

## 20. 前端状态设计

### 20.1 Store 划分

建议使用以下独立 store：

- `connectionStore`：一个全局 WS、重连和 cursor
- `sessionIndexStore`：session 摘要和分页
- `sessionProjectionStore`：每 session snapshot、timeline 和 reducer
- `sessionRuntimeStore`：streaming、retry、compaction、queue、model
- `extensionUIStore`：pending dialogs、widgets、status
- `workspaceStore`：workspace 和 trust
- `paneLayoutStore`：保留 OpenCodeUI 分屏思想
- `terminalStore`：PTY tab 和 cursor
- `uiDSHtore`：主题、折叠和可见性

不要再保留一个同时负责 API conversion、streaming merge、undo、session metadata 和缓存淘汰的超大 `messageStore`。

### 20.2 Snapshot reducer

- snapshot 替换某 session 的完整 projection
- event 只有 epoch、sequence 连续时才能 apply
- sequence 重复直接忽略
- sequence 跳号时停止 apply 并请求 resync
- reducer 必须纯函数，可用录制事件重放测试
- transient streaming content 以 content block ID 更新
- ordinary `message_end` 后延迟读取 entries，用 persisted entry 校正 transient item
- extension `entry_appended` 到达时合并对应 custom entry

### 20.3 多 pane

- 一个 session projection，多 pane selector
- pane 本地保存 scroll snapshot 和可见 entry
- 共享 session event 只 reducer 一次
- pane 不各自发 snapshot 请求
- fork 后只有发起 pane 跳转，其他 pane 保持 source session

## 21. OpenCodeUI 改造清单

下面按接受 GPL 路线、直接基于现有源码改造来写。若选择闭源路线，只能把“保留”理解为重新实现相同行为。

### 21.1 可优先保留

这些模块主要是视觉和通用交互，通常只需改 import 或 props：

- `src/index.css`
- `src/themes/`
- `src/components/ui/`
- `src/components/MarkdownRenderer.tsx`
- `src/components/CodeBlock.tsx`
- `src/components/CodeMirrorReadonly.tsx`
- `src/components/CodePreview.tsx`
- `src/components/DiffView.tsx`
- `src/components/DiffViewer.tsx`
- `src/components/FullscreenViewer.tsx`
- `src/components/PreviewTabsBar.tsx`
- `src/components/ToastContainer.tsx`
- `src/components/InternalDragLayer.tsx`
- `src/features/chat/SplitContainer.tsx`
- `src/features/chat/PaneDropOverlay.tsx`
- `src/features/chat/chatViewport/`
- `src/store/paneLayoutStore.ts`
- `src/store/layoutStore.ts` 中纯布局部分
- `src/store/themeStore.ts`
- Markdown、Shiki、Mermaid、KaTeX 和 diff workers

### 21.2 保留 UI，重写数据入口

#### `src/App.tsx`

保留：

- desktop/mobile 总体布局
- sidebar、right panel、bottom panel
- split pane 和移动 pager
- keybinding 和 viewport 逻辑

替换：

- OpenCode global SSE
- server switching
- OpenCode health
- OpenCode PTY create
- directory/session contexts

#### `src/features/chat/ChatPane.tsx`

保留：

- 单 pane 和 split pane 外壳
- drop zone、fullscreen、outline、input 高度
- deferred rendering 和 error boundary

替换：

- `useChatSession`
- `useModels` 和 `useModelSelection`
- OpenCode agent selector
- permission/question context
- OpenCode message restore、undo 和 fork 语义

#### `src/features/chat/ChatArea.tsx`

保留：

- TanStack Virtual
- measurement cache
- bottom anchoring
- visible item 回调
- process collapse 交互

改造：

- 输入从 `Message[]` 改为 `TimelineItemV1[]`
- virtual key 使用稳定 entry/timeline ID
- fork target 使用 Pi `entryId`
- history 不再按 OpenCode message limit 拉取，Pi snapshot 可先返回 active branch，再按需要加载完整 tree

#### `src/features/message/MessageRenderer.tsx`

保留：

- 用户消息、assistant 内容、thinking、工具步骤的视觉设计
- Markdown、复制、时间、折叠和 animation

重写：

- OpenCode `Part` 分派
- step-start、step-finish 等 OpenCode 专属 part
- undo/revert 逻辑
- Pi content blocks 和 native entry renderer

#### `src/features/message/parts/ToolPartView.tsx`

保留工具卡布局、duration、expand、diff 和输出展示。输入类型改为 `ToolPresentationV1`。

移除 OpenCode `permission`、`question` 和 child session 关联，改为统一的 `ApprovalRequest` 或 `ExtensionUIRequest` 关联。

#### `src/features/message/tools/registry.tsx`

保留 renderer registry 思路，但数据 extractor 按 Pi 重写：

- bash：`arguments.command`、cwd、tool result、exit details
- read：path、offset、limit 和 result content
- edit：path、`details.patch`、diff stats
- write：path、content summary 和 result
- grep/find/ls：对应参数和结果
- custom extension tool：generic JSON fallback

禁止继续猜 OpenCode 的 `metadata.filediff`、`oldString`、`newString` 字段。

#### `src/features/chat/InputBox.tsx`

保留编辑器、移动端收起、历史、mention、slash menu、图片 drop。改造：

- driver capability 控制附件类型
- slash command 来自 Pi extension command、prompt template 和 skill
- streaming 时明确选择 steer/follow-up
- 模型、thinking level、tools 使用 Pi state
- extension `setEditorText` 更新当前 pane 输入框

#### `src/components/FileExplorer.tsx`

保留树、preview、search、tabs、CodeMirror、Markdown 和 HTML sandbox。替换 `useFileExplorer` 与 API 类型，所有路径改为 workspace-relative。

#### `src/components/SessionChangesPanel.tsx`

保留 file tree、tabs、diff viewer 和 scope selector。scope 改成本文定义的四种语义，并显示 shared workspace 限制。

#### `src/components/Terminal.tsx`

保留 xterm、fit、serialize、web links、WebGL、移动按键和主题。替换 PTY URL、认证和 frame parser，改用一次性 WS ticket。

#### `src/features/chat/Sidebar.tsx`

保留 session 列表、搜索、pin、拖拽和 workspace 切换。替换 OpenCode session shape，增加 driver badge、runtime 状态和 Pi branch/session 标识。

### 21.3 必须完全替换

- `src/api/` 全部 OpenCode SDK API
- `src/types/api/`
- `src/api/types.ts`
- `src/types/message.ts`
- `src/utils/messageConversion.ts`
- `src/store/messageStore.ts`
- `src/store/messageStoreTypes.ts`
- `src/hooks/useGlobalEvents.ts`
- `src/hooks/useChatSession.ts`
- `src/hooks/useSessionManager.ts`
- `src/hooks/useSessions.ts`
- `src/hooks/useModels.ts`
- `src/hooks/useModelSelection.ts`
- `src/hooks/usePermissionHandler.ts`
- `src/hooks/usePermissions.ts`
- `src/contexts/SessionContext.tsx`
- `src/contexts/DirectoryContext.tsx`
- `src/store/serverStore.ts`
- `src/store/activeSessionStore.ts`
- `src/store/childSessionStore.ts`

替换后执行全仓搜索，确保生产代码不再 import：

```text
@opencode-ai/sdk
ApiSession
ApiMessage
ApiPart
EventTypes
getSDKClient
subscribeToEvents
```

### 21.4 首版删除或暂不展示

以下能力是 OpenCode 特有，Pi 首版没有同等后端语义：

- OpenCode servers 设置页
- OpenCode share session
- OpenCode MCP 管理面板
- OpenCode child/subtask session 模型
- OpenCode revert/unrevert API
- OpenCode worktree API
- OpenCode LSP/formatter status
- OpenCode todo API

Pi extension 自定义工具以后可以重新提供相应 UI，但不能保留按钮后返回假数据。

### 21.5 Undo、Tree 与 Fork 的新语义

OpenCodeUI 当前 Undo 是 `revertMessage/unrevertSession`。Pi 的原生模型是 tree navigation：

- “回到这里”调用 `navigateTree(targetId)`
- 可选生成 abandoned branch summary
- fork 调用 runtime fork，创建新 JSONL
- clone 复制到所选 leaf
- 历史分支始终保留在 tree 中

UI 应改名并显示树，不要继续呈现线性 undo/redo，避免用户误以为后续历史被删除。

## 22. 模型、thinking 和资源

### 22.1 Model

模型列表来自 `ModelRuntime.getAvailable()`。模型 DTO 至少包含：

- provider
- id
- display name
- reasoning 支持
- input modality
- context window
- max tokens
- auth status

设置模型使用 `session.setModel(model)`。切换成功后后端主动发 `session.state.changed` snapshot patch，不等待某个未必存在的 Pi session event。

### 22.2 Thinking level

Pi 支持的全集可包含：

```text
off, minimal, low, medium, high, xhigh, max
```

实际可选值必须使用 `session.getAvailableThinkingLevels()`，并由 Pi clamp 到模型能力。UI 不能静态假设只有固定五档。

### 22.3 Tools

使用：

- `session.getAllTools()` 展示所有工具及 schema/source
- `session.getActiveToolNames()` 展示当前启用项
- `session.setActiveToolsByName()` 修改下一轮工具集

未知工具名不能 silently 显示为已启用。

### 22.4 Skills、prompts 和 commands

命令面板合并：

- extension registered commands
- `session.promptTemplates`
- skills，显示为 `skill:<name>`

发送普通 prompt 时开启 Pi 的 template expansion。streaming 队列中的 steer/follow-up 可以展开文件 prompt template，但 extension command 不能排队，UI 应直接显示错误。

## 23. 认证与凭据

### 23.1 本地 Web server

- 默认只监听 `127.0.0.1`
- 启动时生成本地 session secret
- 使用 HttpOnly、SameSite cookie 或明确 bearer token
- 所有状态修改接口校验 Origin/CSRF
- WebSocket 校验 Origin 和短期 ticket
- 不允许 `Access-Control-Allow-Origin: *` 搭配凭据

### 23.2 Pi provider 凭据

Pi `ModelRuntime` 的优先级包括 runtime override、`auth.json`、环境变量和 custom resolver。首版应让 Pi 管理 provider auth 文件，后端只提供受控写入接口。

- auth 文件权限设为 `0600`
- 日志对 key、token、Authorization header 脱敏
- 浏览器只看到 configured/expired/missing 状态
- worker 环境只注入需要的变量
- remote sandbox 优先使用短期凭据或 inference proxy

### 23.3 多用户限制

同一个 `agentDir` 包含 auth、settings、trust、extensions 和 sessions。未完成 per-user agentDir、OS identity 和 workspace ACL 前，不得把首版本机架构直接暴露为多租户服务。

## 24. 可观测性

所有日志使用结构化 JSON，至少包含：

- requestId
- commandId
- appSessionId
- driverId
- workerId
- workspacePath
- event sequence
- durationMs
- result status

严禁记录：

- provider key/token
- 完整 prompt 和文件内容，除非用户显式开启 debug content logging
- extension dialog 中的秘密输入
- Authorization header

建议指标：

- active/idle/crashed worker 数
- prompt 到首 token 时间
- agent run 总时长
- event buffer 大小和 resync 次数
- WS reconnect 次数
- tool execution duration
- compaction/retry 次数
- snapshot 构建耗时
- PTY buffer 丢失次数

## 25. 测试计划

### 25.1 Unit

- Pi entry 到 timeline projection
- toolCall/toolResult 配对
- text/thinking delta reducer
- event sequence、重复和跳号
- queue、retry、compaction 状态机
- workspace path containment
- symlink escape
- ETag stale write
- Git porcelain parser
- protocol schema validation

### 25.2 Pi Driver integration

使用 Pi 仓库测试模式和 faux provider，不调用真实付费模型：

- 新建和恢复 JSONL
- 流式文本和 thinking
- 工具 start/update/end
- abort
- steer 和 follow-up
- auto retry
- manual/auto compaction
- tree navigation
- 无 summary 的 tree navigation 在 suspend/restart 后恢复 active leaf
- fork/clone runtime replacement
- extension UI select/confirm/input/editor
- project trust allow/deny
- worker dispose 和恢复

### 25.3 Server integration

- 多 pane 订阅同一 session，只启动一个 worker
- command ID 重试不会重复 prompt
- WS 断开后 replay
- replay buffer 过期后 resync
- worker crash 后 session 状态正确
- 外部修改 JSONL 后进入 conflict
- idle suspend 不丢历史
- message_end 与 JSONL append 的事件顺序不会造成 snapshot 缺 entry
- app leaf checkpoint 在外部文件未变化时正确恢复，外部变化时安全失效
- fork 时 source viewer 保持 source
- session lock 阻止双 worker

### 25.4 E2E

Playwright 至少覆盖 desktop 和 mobile：

1. 注册 workspace
2. 处理 project trust
3. 创建 session 并发送 prompt
4. 查看 streaming、thinking 和工具卡
5. 回答 extension confirm
6. steer 和 follow-up 各一次
7. abort 一次
8. 切换 model/thinking level
9. 查看 session tree 并 fork
10. 浏览文件和 diff
11. 打开 PTY、输入、resize、重连
12. 刷新页面后恢复 snapshot
13. 双 pane 查看同一 session

### 25.5 Failure injection

- provider 429/500/timeout
- worker SIGTERM/exit 1
- malformed worker IPC
- JSONL 尾部半行
- session 文件被 truncate
- extension 抛错
- extension dialog timeout
- SQLite busy/corruption backup recovery
- Git command timeout
- PTY 进程异常退出

## 26. 实施阶段

### Phase 0：许可证与产品决定

产物：

- GPL 或 clean implementation 决定
- Local/Container/Remote 模式决定
- session diff 语义决定
- ADR 文档

验收：工程师知道哪些 OpenCodeUI 文件可以复制，发布方式没有许可证歧义。

### Phase 1：仓库、协议和 workspace

实现：

- monorepo
- `protocol` schema
- Fastify server
- SQLite migration
- workspace register/list
- 安全文件 list/read/search
- 全局 WebSocket 和 replay envelope

验收：浏览器能注册 workspace、浏览文件，路径逃逸测试全部通过。

### Phase 2：Pi worker 最小纵向功能

实现：

- Pi child worker
- runtime supervisor
- session lock
- create/open/list session
- prompt、streaming text、tool events、abort
- snapshot 和 projection reducer
- worker crash handling

验收：页面刷新和 WS 重连后能恢复；同 session 两个 pane 只有一个 worker。

### Phase 3：Pi 原生完整能力

实现：

- model 和 thinking
- steer/follow-up queue
- retry
- compaction
- session tree
- navigate、fork、clone
- tools、skills、prompts、commands
- project trust
- extension UI serializable subset

验收：Pi SDK integration tests 和 tree/fork E2E 全部通过。

### Phase 4：OpenCodeUI 数据层替换

实现：

- 新 stores 和 hooks
- ChatPane/ChatArea/MessageRenderer 改造
- Pi tool registry
- InputBox capability
- session sidebar 和 tree UI
- 删除 OpenCode API/types/store

验收：生产代码不再依赖 `@opencode-ai/sdk`，没有 compatibility adapter。

### Phase 5：文件、Git、diff 和 PTY

实现：

- FileExplorer 新 API
- Git status 和四种 diff scope
- baseline/mutation journal
- node-pty
- ticket WebSocket
- Terminal 改造

验收：大文件、symlink、Git 非仓库、PTY 重连和移动端操作通过测试。

### Phase 6：安全和发布加固

实现：

- host approval extension
- auth、CSRF、Origin 和 rate limit
- log redaction
- worker resource limits
- backup、trash、migration recovery
- license artifacts
- desktop sidecar 或本地 installer

验收：安全测试、许可证检查、桌面和 mobile viewport E2E 通过。

### Phase 7：第二个 Driver 验证

选择一个能力模型明显不同的 Agent 接入，验证：

- core driver 接口没有 Pi 私有类型泄漏
- native namespace 能独立扩展
- UI capability gating 有效
- Pi tree 和 extension UI 没因抽象而退化

没有完成这一步前，不要宣称 Driver API 已稳定。

## 27. Pi 首版验收标准

以下条件全部满足才算 Pi MVP 完成：

- 可创建、列出、打开、归档和恢复 Pi session
- Pi JSONL 保持原格式且是历史真相来源
- 文本、thinking、tool call/result 可实时渲染
- abort、steer、follow-up 行为与 Pi SDK 一致
- model 和可用 thinking level 可切换并恢复
- queue、retry、compaction 状态可见
- 可手动 compact 和取消 compaction
- 完整 session tree 可查看
- navigate、fork、clone 不丢分支
- 无后续消息的 tree navigation 在正常 suspend 后仍恢复到所选 leaf
- 多 pane 同 session 不产生双 writer
- worker crash 不带走主 server
- reconnect 可 replay 或明确 resync
- skills、prompts、commands 可列出和使用
- project trust 在项目 extension 加载前完成
- serializable extension UI 可交互
- TUI-only extension 能明确显示不兼容，不会永久卡住
- 文件 API 不可逃逸 workspace
- Git diff scope 文案与实际语义一致
- PTY 支持 resize、退出和短时重连
- provider 凭据不进入日志和浏览器响应
- 生产依赖中没有 `@opencode-ai/sdk`
- 没有 ACP 或 OpenCode compatibility layer

## 28. 明确禁止的实现捷径

- 把 Pi JSONL 解析成 OpenCode `ApiMessage` 后继续沿用全部旧 store
- 为了复用 UI，伪造 OpenCode SSE event
- 每个 pane 启动一个 Pi RPC 进程
- 直接让浏览器传 session 文件绝对路径
- 允许两个 worker 打开同一个 session 文件
- 把 `projectTrusted=true` 写死
- 把 extension confirm 当成 OS sandbox
- 把 API key 放进 WebSocket URL
- 在 reconnect 时自动重发未确认 prompt
- 用字符串拼接执行 Git 或 shell 命令
- 把共享工作区的 baseline diff 标成确定的 Agent 修改
- 对 unsupported Pi TUI `custom()` 请求一直不返回
- 保留无后端实现的 OpenCode 按钮和设置页

## 29. 工程交接检查表

工程负责人开始开发前应确认：

- [ ] 选择 GPL fork 或 clean implementation
- [ ] 选择首发隔离模式
- [ ] 确认首版只支持本地单用户
- [ ] 确认四种 diff scope 文案
- [ ] 建立 ADR 目录
- [ ] 锁定 Node `>=22.19.0`
- [ ] 协议 schema 单一来源
- [ ] Pi worker 使用 SDK，不使用 CLI RPC 主路径
- [ ] session sidecar lock 和外部修改检测进入 Phase 2
- [ ] trust 在 resource final load 前处理
- [ ] extension UI unsupported 行为写入测试
- [ ] OpenCode API/type 删除设为 Phase 4 完成门槛
- [ ] 安全测试覆盖 symlink、CSRF、WS ticket 和日志脱敏

## 30. 关键源码索引

### OpenCodeUI

- `/workspace/OpenCodeUI/package.json`
- `/workspace/OpenCodeUI/LICENSE`
- `/workspace/OpenCodeUI/src/App.tsx`
- `/workspace/OpenCodeUI/src/api/`
- `/workspace/OpenCodeUI/src/types/api/`
- `/workspace/OpenCodeUI/src/types/message.ts`
- `/workspace/OpenCodeUI/src/store/messageStore.ts`
- `/workspace/OpenCodeUI/src/hooks/useGlobalEvents.ts`
- `/workspace/OpenCodeUI/src/hooks/useChatSession.ts`
- `/workspace/OpenCodeUI/src/hooks/useSessionManager.ts`
- `/workspace/OpenCodeUI/src/features/chat/ChatPane.tsx`
- `/workspace/OpenCodeUI/src/features/chat/ChatArea.tsx`
- `/workspace/OpenCodeUI/src/features/chat/InputBox.tsx`
- `/workspace/OpenCodeUI/src/features/message/MessageRenderer.tsx`
- `/workspace/OpenCodeUI/src/features/message/parts/ToolPartView.tsx`
- `/workspace/OpenCodeUI/src/features/message/tools/registry.tsx`
- `/workspace/OpenCodeUI/src/components/FileExplorer.tsx`
- `/workspace/OpenCodeUI/src/components/SessionChangesPanel.tsx`
- `/workspace/OpenCodeUI/src/components/Terminal.tsx`

### Pi

- `/workspace/pi-mono/LICENSE`
- `/workspace/pi-mono/packages/coding-agent/package.json`
- `/workspace/pi-mono/packages/coding-agent/docs/sdk.md`
- `/workspace/pi-mono/packages/coding-agent/docs/session-format.md`
- `/workspace/pi-mono/packages/coding-agent/docs/security.md`
- `/workspace/pi-mono/packages/coding-agent/docs/extensions.md`
- `/workspace/pi-mono/packages/coding-agent/docs/containerization.md`
- `/workspace/pi-mono/packages/coding-agent/src/core/sdk.ts`
- `/workspace/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `/workspace/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts`
- `/workspace/pi-mono/packages/coding-agent/src/core/agent-session-services.ts`
- `/workspace/pi-mono/packages/coding-agent/src/core/session-manager.ts`
- `/workspace/pi-mono/packages/coding-agent/src/core/resource-loader.ts`
- `/workspace/pi-mono/packages/coding-agent/src/core/project-trust.ts`
- `/workspace/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `/workspace/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `/workspace/pi-mono/packages/coding-agent/src/modes/rpc/rpc-types.ts`

## 31. 最终建议

工程上最重要的顺序是：先建立自有 protocol、Pi worker、session single-writer 和 snapshot/event 恢复，再改 UI。若先把 OpenCodeUI API 替换成一组外形相同的新函数，短期看起来省事，后面会被线性消息、revert、child session、permission 和 SSE 语义限制，最终仍需重写。

Pi 应作为第一个完整 Driver，而不是被包装成 OpenCode 的替代 server。只有保留 JSONL tree、runtime replacement、queue、compaction、resources 和 extension UI，后续的通用 Driver 层才有真实依据。
