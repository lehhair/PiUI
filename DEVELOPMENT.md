# PiUI 重构开发文档

> 目标：按 Pi 最自然的方式做多端 Coding Agent 客户端。  
> 首版：本地桌面。架构从第一天按「薄客户端 + Host 引擎」设计，后续手机远程只换传输层。  
> **本目录即产品仓库。** OpenCodeUI 基线已归档到 `_archive/opencodeui-baseline/`，只作 UI 参考。

## 0. 关键路径

| 用途 | 路径 |
|---|---|
| **本仓库（产品）** | `E:\dev\re_agent_UI\PiUI` |
| OpenCodeUI 归档（UI 壳参考） | `E:\dev\re_agent_UI\PiUI\_archive\opencodeui-baseline` |
| Pi monorepo（核心实现与文档） | `E:\dev\re_agent_UI\pi` |
| Pi 官方站点 | https://pi.dev |

### 当前仓库结构

```text
E:\dev\re_agent_UI\PiUI\
  packages\
    protocol\    # UI <-> Host 协议
    host\        # Node Host + pi-coding-agent SDK
    app\         # React UI（Phase1 先 Mock，再接 Host）
  _archive\opencodeui-baseline\   # 旧 OpenCodeUI 整包
  DEVELOPMENT.md
  README.md
```

### Pi monorepo 必读

| 内容 | 路径 |
|---|---|
| 项目总览 | `E:\dev\re_agent_UI\pi\README.md` |
| Coding Agent 说明 | `E:\dev\re_agent_UI\pi\packages\coding-agent\README.md` |
| **SDK 文档（首选接入）** | `E:\dev\re_agent_UI\pi\packages\coding-agent\docs\sdk.md` |
| RPC 文档（备选/隔离） | `E:\dev\re_agent_UI\pi\packages\coding-agent\docs\rpc.md` |
| Extension 文档 | `E:\dev\re_agent_UI\pi\packages\coding-agent\docs\extensions.md` |
| SDK 示例 | `E:\dev\re_agent_UI\pi\packages\coding-agent\examples\sdk\` |
| 导出入 | `E:\dev\re_agent_UI\pi\packages\coding-agent\src\index.ts` |
| AgentSession | `E:\dev\re_agent_UI\pi\packages\coding-agent\src\core\agent-session.ts` |
| AgentSessionRuntime | `E:\dev\re_agent_UI\pi\packages\coding-agent\src\core\agent-session-runtime.ts` |
| SessionManager | `E:\dev\re_agent_UI\pi\packages\coding-agent\src\core\session-manager.ts` |
| RPC Client 参考 | `E:\dev\re_agent_UI\pi\packages\coding-agent\src\modes\rpc\rpc-client.ts` |
| 模型层 | `E:\dev\re_agent_UI\pi\packages\ai\` |
| Agent 核心 | `E:\dev\re_agent_UI\pi\packages\agent\` |
| TUI（仅终端 UI，不是 Web） | `E:\dev\re_agent_UI\pi\packages\tui\` |

### 归档中可复用的 UI 资产

路径前缀：`_archive/opencodeui-baseline/`

只复用视觉与交互，不复用 OpenCode API 层：

- `src/components/FileExplorer.tsx`：文件树
- `src/components/RightPanel.tsx`：右侧面板
- `src/components/DiffViewer.tsx`：Diff
- `src/components/CodePreview.tsx`：代码预览
- `src/components/MarkdownRenderer.tsx`：Markdown
- 会话列表 / 聊天布局相关组件
- Tauri 窗口、主题、布局 store 可参考

不要复用：

- `src/api/sdk.ts` 及 `@opencode-ai/sdk`
- OpenCode REST/SSE/PTY 协议假设
- OpenCode Message Part 作为内部真相源
- 远程服务器列表作为一等架构（首版 UI 不展示多租户/云端实例列表）

### 仓库现状说明

- OpenCodeUI 已整包移入 `_archive/opencodeui-baseline/`。
- 根目录 `packages/` 为 Pi 客户端骨架，在此继续开发。
- 禁止在归档目录里接 Pi。

---

## 1. 产品目标

### 1.1 首版：本地桌面

类似 Codex Desktop 的本地体验：

- 复用用户本机 Pi 配置（凭据、模型、扩展、Skills、会话目录）
- 仅服务本机，不做云端多租户
- 聊天 + 工具执行可视化
- 左侧/侧栏工作区文件树
- 右侧文件预览
- Agent 改文件后的 Diff
- 会话列表、恢复、Fork
- 权限确认弹窗
- 可选终端输出
- 应用内可更新引擎（Pi），无需重装整个 App

### 1.2 中长期：多端

| 客户端 | 角色 | 连接 |
|---|---|---|
| 桌面 App | 完整 UI + 本地起 Host | 本机 IPC（默认） |
| 手机 App | 薄 UI | 连开发机上的 Host Gateway |
| 无头 Host | 常驻引擎（可选） | 供远程客户端接入 |

Pi **没有**内置网络远程服务。手机要连远程 Pi，必须由我们的 Host 提供 Gateway。

### 1.3 非目标（第一版不做）

- OpenCode API 兼容
- 云端/多租户
- 完整 MCP/LSP 管理面板
- 远程 Gateway 实装（协议层预留 Transport，首版只做本地 IPC）
- 把系统全局 `pi` CLI 当主引擎

---

## 2. 总体架构（最自然形态）

### 2.1 一句话

```text
Pi 跑在有代码、有凭据、能执行工具的机器上（Host）。
桌面/手机都是薄客户端，只认我们自己的 protocol。
配置复用 ~/.pi/agent；引擎用可替换 runtime 里的 SDK 包，不 import 用户全局 pi。
```

### 2.2 分层

```text
┌─────────────────────────────────────────────────────────┐
│  Clients（可多端）                                        │
│    Desktop (Tauri + React)  |  Mobile (后置)             │
│    只渲染 / 发命令 / 收事件 / 弹权限                        │
└───────────────────────────┬─────────────────────────────┘
                            │  protocol（版本化）
                            │  Transport: IPC | Remote(后置)
┌───────────────────────────▼─────────────────────────────┐
│  Host（真相源，可独立更新）                                 │
│    ├── Engine: @earendil-works/pi-coding-agent (SDK)     │
│    │     AgentSessionRuntime / SessionManager / tools    │
│    ├── Workspace Service（文件树/预览/git/watch）          │
│    ├── Permission Bridge                                 │
│    └── 可选 Remote Gateway（默认关）                       │
└───────────────────────────┬─────────────────────────────┘
                            │
              本机磁盘 / ~/.pi/agent / 项目 .pi/
```

### 2.3 职责边界

| 层 | 负责 | 不负责 |
|---|---|---|
| Client UI | 渲染、交互、本地状态投影 | 直接 spawn pi、直接读任意磁盘、持有 API Key |
| Host | 嵌入 Pi SDK、会话、权限桥接、工作区 IO | 画 UI |
| Workspace Service | 文件树/预览/搜索/监听 | 让 Agent 工具代替文件浏览器 |
| Pi Agent | 推理、工具调用、改代码、bash | 给用户点文件预览 |
| Transport | 把 protocol 送到对面 | 解释 Agent 语义 |

### 2.4 引擎模型：内嵌 SDK，不是连系统 pi

Pi 官方能力边界：

| 能力 | 形态 | 用途 |
|---|---|---|
| SDK | 进程内 `import` 包 | **主路径** |
| `pi --mode rpc` | stdin/stdout JSONL 子进程 | 隔离/非 Node/高级选项 |
| 网络远程服务 | **不存在** | 需我们做 Gateway |
| SSH/工具路由 | 工具执行可到远端 | 与 UI 远程是不同问题 |

关键区分：

| 复用什么 | 是否推荐 | 说明 |
|---|---|---|
| 用户 `~/.pi/agent` 配置 | **是** | auth、models、skills、extensions、sessions |
| 用户 PATH 上的 `pi` 二进制当 SDK `import` | **否** | 路径乱、形态是 CLI/binary、Node/原生模块对不齐 |
| 用户 `pi --mode rpc` 当引擎 | 可选副路径 | 版本漂移风险，首版不做 |
| App 旁路 runtime 里的 npm 包 | **是** | 可 import，可单独更新 |

`@earendil-works/pi-coding-agent` 同一包既是库也是 CLI（`bin: pi`）。  
内嵌的是 **SDK 用法**；同包也可 `node .../cli.js`，那是 App 自带引擎，不是系统全局 `pi`。

### 2.5 Host Runtime 与应用内更新 Pi

目标：**不发完整桌面 App 也能升级 Pi。**

```text
%APPDATA%/piui/   或   ~/.piui/
  runtime/
    current -> 0.81.1/          # 符号链接或指针文件
    0.81.1/
      package.json
      node_modules/@earendil-works/pi-coding-agent/
      host 入口
    0.82.0/                     # 下载完成后切换
```

更新流程：

1. 检查版本源（npm registry 或自建 release 列表）
2. 下载到新目录（`npm install --prefix` / `npm pack` + 解压）
3. 校验完整性
4. 切换 `current`
5. **重启 Host 进程**，UI 重连
6. 失败则保持旧目录（可回滚）

规则：

- 引擎装在**用户数据目录**，不改 Program Files / 安装包内部
- **整目录切换 + 重启**，禁止原地覆盖正在运行的 `node_modules`
- 发布测过的 `host + pi` 组合（或白名单版本），不是任意 latest 无脑跟
- 更新的是 App 自带引擎，**不动**用户全局 `pi` CLI
- UI ↔ Host 协议版本化；协议 breaking 才逼用户升 App
- 默认始终用 npm 包版本；runtime 目录放的也是发布包，不是自编译 monorepo

### 2.6 多端与远程（预留）

Pi 默认不监听端口。远程形态：

```text
手机 / 异地桌面
    │  安全通道（Tailscale / WireGuard / mTLS 配对）
    ▼
Host Gateway（显式开启，默认关）
    │
    ▼
同一 Host + SDK + ~/.pi/agent
```

原则：

- 首版只实现 `LocalIpcTransport`
- protocol 从第一天抽象 `HostTransport`，远程只换实现
- 默认不公网裸开端口；个人场景优先 Tailscale 类组网
- 凭据与工具执行永不下发到手机
- 危险操作可要求本机桌面二次确认（后置策略）

```ts
interface HostTransport {
  request(cmd: HostCommand): Promise<HostResponse>
  events(): AsyncIterable<HostEvent>
}
// LocalIpcTransport | RemoteWsTransport（后置）
```

### 2.7 会话模型用 Pi 原生语义

真相源：

- `AgentSession`：当前活动 Agent
- `AgentSessionRuntime`：new / switch / fork / resume
- `SessionManager`：JSONL 会话树

不要做成 OpenCode 的 `GET/POST /session` 兼容层。

### 2.8 事件驱动

Host 订阅：

```ts
runtime.session.subscribe((event) => {
  // 经 Transport 推给 UI
})
```

关键事件：

- `message_start` / `message_update` / `message_end`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `agent_start` / `agent_end`
- `compaction_*`
- `auto_retry_*`

UI 消息模型从 Pi 的 `AgentMessage` / `AgentSessionEvent` 投影，不要先转成 OpenCode parts。

### 2.9 多窗口 / 多会话

```text
窗口 A -> Host Runtime A -> cwd=项目A
窗口 B -> Host Runtime B -> cwd=项目B
```

同项目多聊天：

```text
同一 Runtime
  -> SessionManager 多个会话文件
  -> runtime.switchSession / fork
```

禁止：

```text
所有窗口共享一个全局 pi --mode rpc
```

### 2.10 权限

Pi 无内置 OpenCode permission API。用：

- `beforeToolCall`
- 或 Extension 的 `tool_call` 拦截 + `ctx.ui.confirm/select/input`

Host 把确认请求转成 React 弹窗，再回传结果。

---

## 3. 仓库结构（已落地）

```text
E:\dev\re_agent_UI\PiUI\
  packages\
    app\                 # React UI（Tauri 后置）
    host\                # Node Host，嵌入 pi-coding-agent
    protocol\            # UI <-> Host 共享类型 + Transport 接口
  _archive\opencodeui-baseline\
  package.json           # npm workspaces
  README.md
  DEVELOPMENT.md
```

Host 依赖 **npm 已发布的** `@earendil-works/pi-coding-agent`，开发和发行默认都这样，**不必**编译本地 pi monorepo：

```json
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.81.1"
  }
}
```

- 升引擎：bump 版本号 / 应用内更新 runtime 到新版本  
- 本地 monorepo（`E:\dev\re_agent_UI\pi`）仅作读源码、查文档、对照行为；只有你要改 Pi 本身并测未发布改动时，才临时 `file:` 链接  
- 正式用户：Host 从 `%APPDATA%/piui/runtime/current` 加载引擎包（内容仍是 npm 形态的包，不是自编译 monorepo）

---

## 4. Host 核心 API（自建协议）

只做自有协议，不做 OpenCode 兼容。协议带 `protocolVersion`。

### 4.1 Workspace

```ts
workspace.open(cwd: string)
workspace.list(path?: string): FileNode[]
workspace.read(path: string): FileContent
workspace.search(query: string): SearchHit[]
workspace.watch(): AsyncIterable<FsEvent>
workspace.gitStatus(): GitStatusItem[]
workspace.diff(path?: string): DiffItem[]
```

规则：

- 所有路径相对 cwd，并做沙箱校验
- 文件预览不走 Agent `read` 工具
- 忽略 `.git` / `node_modules` 等大目录（可配置）

### 4.2 Agent

```ts
agent.prompt(text: string, options?: { images?: Image[] })
agent.steer(text: string)
agent.followUp(text: string)
agent.abort()
agent.setModel(provider: string, modelId: string)
agent.setThinkingLevel(level: ThinkingLevel)
agent.getState(): AgentState
```

### 4.3 Session

```ts
session.list(): SessionSummary[]
session.new(name?: string)
session.open(path: string)
session.fork(entryId: string)
session.rename(name: string)
session.tree(): SessionTree
```

### 4.4 Events

```ts
// Host -> UI stream
event.agent: AgentSessionEvent | UiProjectedEvent
event.workspace: FsEvent | GitEvent
event.permission: PermissionRequest
event.engine: EngineStatusEvent   // 版本、更新进度（后置可用）
```

### 4.5 Permission

```ts
permission.respond(requestId: string, decision: "allow" | "deny" | "always" | "never")
```

### 4.6 Engine（应用内更新）

```ts
engine.getVersion(): { pi: string; host: string; protocolVersion: number }
engine.checkUpdate(): { available: boolean; latest?: string; notes?: string }
engine.applyUpdate(version?: string): Promise<void>  // 下载后请求重启 Host
engine.rollback(): Promise<void>
```

---

## 5. Host 实现要点（Pi SDK）

### 5.1 最小启动

参考：`E:\dev\re_agent_UI\pi\packages\coding-agent\examples\sdk\01-minimal.ts`

```ts
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  cwd: workspacePath,
  modelRuntime,
  sessionManager: SessionManager.create(workspacePath),
});

session.subscribe((event) => broadcast(event));
await session.prompt("检查当前项目");
```

### 5.2 可切换会话 Runtime

参考：

- `docs/sdk.md` 中 `createAgentSessionRuntime`
- `examples/sdk/13-session-runtime.ts`
- `src/core/agent-session-runtime.ts`

会话替换后：

- `runtime.session` 变成新对象
- 必须重新绑定 `subscribe`
- 旧订阅要清理

### 5.3 复用用户 Pi 配置

默认使用用户本机 Pi 配置目录与发现逻辑：

- `~/.pi/agent/` 或 Pi 默认 agentDir（`getAgentDir()`）
- `auth.json` / `models.json`
- 全局 extensions / skills
- 项目 `.pi/` 与 `AGENTS.md`

不要发明第二套凭据体系，除非产品明确要求隔离。

### 5.4 工具策略

第一版建议：

```ts
// 默认完整 coding tools
// 只读模式可切换：
tools: ["read", "grep", "find", "ls"]
```

编辑后从 `edit` 工具结果取 patch/diff 给右侧 Diff 面板。

### 5.5 何时用 RPC

仅当：

- Host 不用 Node/TS
- 需要强进程隔离实验
- 兼容外部语言客户端
- 高级选项：用户强制「使用系统 pi」（后置，需版本协商）

RPC 注意：

- 严格 JSONL，只按 `\n` 分包
- 不要用会把 `U+2028/U+2029` 当换行的 readline
- 参考 `rpc-client.ts` / `docs/rpc.md`
- **禁止**把 `pi --mode rpc` 直接暴露到 TCP

第一版默认 **不要** 以 RPC 为主路径。

### 5.6 引擎加载

```text
启动器
  1. 读 runtime/current
  2. 用该目录的 Node 入口启动 Host
  3. Host import 同目录下的 pi-coding-agent
  4. agentDir 仍指向用户 ~/.pi/agent
```

首装：安装器或首次启动把初始 runtime 解压到用户数据目录。

---

## 6. UI 状态模型

```ts
type PiUiState = {
  workspace: {
    cwd: string
    tree: FileNode[]
    openFile?: {
      path: string
      mimeType: string
      encoding: "utf8" | "base64"
      content: string
    }
    diffs: DiffItem[]
  }
  agent: {
    sessionId: string
    sessionPath?: string
    messages: UiMessage[]
    streaming: boolean
    model?: { provider: string; id: string; name: string }
    thinkingLevel: string
  }
  permission?: {
    id: string
    toolName: string
    summary: string
    detail?: unknown
  }
  engine?: {
    piVersion: string
    hostVersion: string
    protocolVersion: number
    updateAvailable?: string
  }
}
```

投影规则：

- `text_delta` -> 追加 assistant 文本
- `thinking` -> thinking 面板
- `tool_execution_*` -> 工具卡片
- `agent_end` -> streaming=false
- `tool_execution_end` + edit/write -> 刷新文件树/Diff/打开文件

---

## 7. 分阶段实施

### Phase 0：准备（已完成骨架）

1. ~~新建独立仓库~~ → 在本目录归档 OpenCodeUI 后直接开工
2. monorepo：`packages/app` / `host` / `protocol`
3. `protocol`：命令/事件 + `HostTransport` + `protocolVersion`
4. Host 依赖 npm `@earendil-works/pi-coding-agent`（默认，不编译 monorepo）
5. App 先用 Mock Host 可 dev；下一步接真实 Host

### Phase 1：最小闭环（进行中）

验收标准：

1. 启动 UI（先 Vite，后 Tauri）
2. 选择本地目录
3. Host 用该 cwd 创建 `AgentSessionRuntime`
4. 发送 prompt
5. 流式显示 assistant 文本
6. Abort 可用
7. 文件树可展开
8. 点击文件右侧预览
9. 复用 `~/.pi/agent` 凭据（若已有）

当前进度：
- Host WS + 真引擎闭环可用
- App 已接入归档 **主题/CSS/Icons**（eucalyptus 变量）
- 主界面 `ShellApp`：Pi 原生 state（`usePiSession` / `UiMessage`），**无 OpenCode 桥**
- 验收台保留在 `packages/app/src/dev/AcceptanceApp.tsx`

下一步：继续 cp 归档聊天布局/Markdown/文件树外观，仍只换 Pi 数据口。

不做：会话树、MCP、PTY、远程、引擎热更新 UI。

### Phase 2：Coding 体验

1. 工具调用卡片
2. bash 输出流
3. edit Diff
4. 模型列表与切换
5. thinking level
6. 会话 list / new / open / rename
7. 权限确认弹窗

### Phase 3：桌面增强 + 引擎可更新

1. 多窗口，每窗口独立 Runtime
2. 文件监听自动刷新
3. Git status / diff
4. 快捷键
5. 图片附件
6. 主题与布局持久化
7. **Runtime 目录布局 + 应用内检查/应用引擎更新 + 回滚**
8. 设置页展示 pi / host / protocol 版本

### Phase 4：扩展能力

1. Extension UI 桥接（confirm/select/input）
2. Skills / Slash commands
3. 上下文压缩可视化
4. 会话树可视化
5. 可选后端：OMP ACP（后置，不阻塞 Pi SDK 主线）

### Phase 5：远程与手机（后置）

1. `RemoteWsTransport` 或等价安全通道
2. Host 显式开启 Remote Access（配对 token / 设备密钥）
3. 推荐与 Tailscale 等组网配合
4. 手机薄客户端只实现 protocol
5. 权限与危险操作策略

完成 Phase 1 前不进入 Phase 5。

---

## 8. 明确禁止

1. 不要伪造 OpenCode REST/SSE 兼容层
2. 不要把 `@opencode-ai/sdk` 当内部依赖
3. 不要用 Agent `read` 工具实现文件树点击预览
4. 不要全局单例 Pi 进程服务所有窗口
5. 不要先做 MCP/LSP/PTY 导致主线延误
6. 不要在本参考仓库继续堆实验代码；实验在新仓库做
7. 不要把用户全局 `pi` 当 SDK 直接 `import`
8. 不要把 `pi --mode rpc` 裸暴露到 TCP
9. 不要默认开启远程 Gateway
10. 不要原地覆盖正在运行的引擎目录；必须旁路下载 + 切换 + 重启

---

## 9. 开发命令备忘

### Pi monorepo

```bash
cd E:/dev/re_agent_UI/pi
npm install --ignore-scripts
npm run build
npm run check
./test.sh
./pi-test.sh
```

### 查 SDK 示例

```bash
cd E:/dev/re_agent_UI/pi/packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
npx tsx examples/sdk/11-sessions.ts
npx tsx examples/sdk/13-session-runtime.ts
```

### 本仓库（PiUI）

```bash
cd E:/dev/re_agent_UI/PiUI
npm install
npm run dev:app    # React + Mock Host
npm run dev:host   # 真实 Host stdio
```

### Windows 注意

- 终端为 git bash
- 非大陆网络可优先代理：`http://127.0.0.1:7890`
- Python 若用到：`PYTHONIOENCODING=utf-8`

---

## 10. 新会话开工检查清单

在本仓库继续时，按顺序：

1. 读本文件 `DEVELOPMENT.md`
2. 读 `E:\dev\re_agent_UI\pi\packages\coding-agent\docs\sdk.md`
3. 扫一眼 `examples/sdk/01-minimal.ts` 与 `13-session-runtime.ts`
4. ~~新建仓库~~ 已在本目录
5. `packages/protocol` — 已有最小协议
6. `packages/host` — 已有 Runtime + workspace + stdio
7. `packages/app` — 已有 Mock 壳；接真 Host + 搬归档 UI
8. 验收 Phase 1 闭环
9. 再进入 Phase 2
10. Phase 3 再做引擎目录与应用内更新

完成 Phase 1 前，不要改 `_archive/`，不要引入 OMP/ACP，不要做远程 Gateway。

---

## 11. 决策摘要

| 问题 | 答案 |
|---|---|
| 用 OpenCode 兼容层吗？ | 否 |
| 用 `pi --mode rpc` 做主路径吗？ | 否（首版） |
| 主路径是什么？ | Node Host + `pi-coding-agent` SDK |
| 配置从哪来？ | 复用 `~/.pi/agent`，不自造凭据体系 |
| 用用户全局 `pi` 当 SDK 吗？ | 否（不能可靠 import） |
| 系统 pi RPC 呢？ | 后置可选，非主路径 |
| 应用内能更新 Pi 吗？ | 能：旁路 runtime 切换 + 重启 Host |
| 必须发完整 App 才能升 Pi 吗？ | 否；协议不变则只更 runtime |
| 文件树怎么做？ | Host 直接读文件系统 |
| 会话怎么做？ | `AgentSessionRuntime` + `SessionManager` |
| 多窗口怎么做？ | 每窗口独立 Runtime |
| 手机怎么连？ | 薄客户端 + Host Gateway（后置） |
| Pi 自带远程服务吗？ | 否 |
| 本目录角色？ | 产品仓库 |
| OpenCodeUI 在哪？ | `_archive/opencodeui-baseline/` |
| 代码写在哪？ | `packages/*` |

---

## 12. 客户端规划总览

```text
Phase 0–1  本地 Host + SDK + 桌面最小闭环
Phase 2    Coding 体验（工具/会话/权限/模型）
Phase 3    桌面打磨 + 引擎可独立更新
Phase 4    Extensions / Skills / 压缩与会话树
Phase 5    远程 Gateway + 手机薄客户端
```

原则优先级：

1. **安全**：默认本地；远程显式开；凭据不离 Host  
2. **自然**：跟 Pi SDK 语义走，不发明第二套 Agent 模型  
3. **可演进**：protocol + Transport 先行，远程只换壳  
4. **可维护**：UI 发版稀、引擎发版勤、协议谨慎 breaking  

---

## 13. 一句话

```text
Pi 管 Agent，Host 管引擎与工作区，Client 只管界面。
配置复用 ~/.pi/agent；引擎用可替换 runtime 里的 SDK，不 import 系统 pi。
协议版本化，本地 IPC 先做，远程/手机后置只换 Transport。
归档只参考 UI，产品在 packages/ 继续做。
```
