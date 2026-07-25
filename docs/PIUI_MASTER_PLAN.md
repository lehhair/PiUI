# PiUI 完整开发计划

> 状态基线：2026-07-25  
> 适用仓库：`E:\dev\re_agent_UI\PiUI`  
> Pi 源码参考：`E:\dev\re_agent_UI\pi`  
> UI 基线：`_archive/opencodeui-baseline`  
> 当前版本：`0.1.0`
> Pi parity 基线：`@earendil-works/pi-coding-agent@0.81.1`

> 2026-07-25 修订：项目目标已提升为 Pi SDK/headless 与内置工作流完整覆盖。能力状态以
> `docs/PI_UI_INTEGRATION.md` 为准，后续实施采用 R0-R12 路线。本文后半部分保留的旧阶段记录仅作历史参考，
> 其中“双 session ID”“没有 OCUI 界面就跳过”“单一 trust”及第二 driver 假设均不再适用。

## 1. 文档目的

本文档是 PiUI 后续开发的主计划，统一记录目标、边界、架构、阶段顺序、验收条件和发布标准。

后续开发以本文档为准。`DEVELOPMENT.md` 只保留常用命令和当前状态，`PI_UI_INTEGRATION.md` 只记录能力映射，技术细节可继续拆成 ADR 或单独设计文档。

每完成一个阶段，应同时更新：

1. 本文档的阶段状态
2. `DEVELOPMENT.md` 的当前状态
3. `docs/PI_UI_INTEGRATION.md` 的能力状态
4. 对应测试和验收记录

## 2. 产品目标

PiUI 是 Pi coding agent 的完整图形客户端。它保留 OpenCodeUI 中成熟的视觉结构和通用交互，但运行时、协议、数据、会话、事件、文件、Git 和终端都由 PiUI 自己实现。

最终产品应满足：

1. 用户可以打开本地项目，创建、恢复、切换和删除 Pi 会话
2. 用户可以稳定接收文本、思考、工具调用、工具输出、重试、压缩和错误状态
3. 用户可以选择模型和思考等级，并看到真实生效状态
4. 用户可以在流式生成时停止、steer 或发送 follow-up
5. 用户可以浏览、搜索、读取、编辑项目文件并查看完整 Git 变化
6. 用户可以使用真实 PTY 终端
7. 服务重启、页面刷新、WebSocket 断线后，会话和状态可以恢复
8. 本地文件和模型调用接口不能被任意网页访问
9. 自动测试不得调用付费模型
10. 生产代码中不再存在 OpenCode SDK、OpenCode SSE 或假成功 shim

### 2.1 Pi Native Parity 路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| R0 | 锁定 Pi 版本、能力矩阵、文档基线、真实性能基线 | 已完成 |
| R1 | Protocol v2、类型化 command/event/capability、worker handshake | 已完成 |
| R2 | worker supervisor、单写 lease、generation、崩溃恢复 | 已完成 |
| R3 | session tree、navigate、label、fork、clone、import、持久删除 | 已完成 |
| R4 | steer/follow-up control lane、queue、retry、compact、工具控制 | 未开始 |
| R5 | 多模态 prompt 与完整工具结果 | 未开始 |
| R6 | Pi user bash 与流式执行控制 | 未开始 |
| R7 | extension command、UI bridge、dynamic tools、custom entries | 未开始 |
| R8 | settings、resources、reload、diagnostics | 未开始 |
| R9 | packages 与三层 trust | 未开始 |
| R10 | provider auth、模型、scoped models、llama.cpp | 未开始 |
| R11 | stats、context usage、HTML/JSONL export、share | 未开始 |
| R12 | conformance、升级门禁、故障注入、发布 | 未开始 |

每项能力的实时状态、来源和完成条件见 `docs/PI_UI_INTEGRATION.md`

R2 已实现 worker IPC v3、全消息 generation 校验、5 秒心跳与连续 3 次缺失判定、由 OS socket
持有的跨进程 session lease、物理文件身份刷新、catalog worker 自动替换、崩溃命令
`unknown_after_crash`、排队命令取消、懒重新 attach、限时服务退出，以及真实 Pi SDK + faux provider
无网络验收。外部 Pi CLI 改写 JSONL 的 fingerprint 冲突检测和 idle suspension 不属于本轮完成范围，
分别随持久会话和发布故障注入继续实现。

R3 已实现类型化 Pi entries/tree/leaf、tree navigation 与编辑器文本恢复、entry label、session name、
fork/clone/import runtime replacement、target-before-source lease 转移、持久 JSONL 删除，以及右侧会话树 UI。
fork 后仅发起操作的 pane 切换到 target，其他 source viewer 保留原分支快照；lease commit 失败时关闭已替换
worker 并让 source 回到可重新 attach 状态。branch summary 的交互选择、外部 JSONL 冲突检测和 leaf checkpoint
持久恢复继续分别在 R4 和后续持久会话阶段完成。

## 3. 非目标

以下内容不作为第一版发布阻断项：

1. 完整复刻 OpenCode 后端 API
2. 保留 OpenCode server 兼容模式
3. 在 Pi 没有对应语义时强行复刻 OpenCode 功能
4. 第一版支持公网多租户服务
5. 第一版同步多台设备的会话
6. 像素级复刻 Pi TUI 的终端绘制、ANSI 布局和硬件光标
7. 在 React 中执行扩展提供的任意 TUI `Component`；此类能力提供稳定降级或原生 TUI 入口

PiUI 可以复用 UI 结构，但不能继续以 OpenCode API 作为内部架构。

## 4. 基本原则

### 4.1 单一运行时

生产环境只能有一套后端：PiUI server。HTTP、WebSocket、health、session、workspace、file、Git 和 PTY 必须使用同一个服务地址和身份验证。

### 4.2 显式能力

后端必须返回 capability 列表。前端只能展示已实现能力。

未实现功能必须满足以下之一：

- 不展示入口
- 展示为禁用，并说明原因
- 调用后返回明确的 `NOT_SUPPORTED`

禁止用 `{}`、`[]`、`true` 模拟成功。

### 4.3 Pi 原生数据优先

会话 ID、entry ID、parent ID、模型、思考等级、工具状态、JSONL 文件和树结构尽量保留 Pi 原生含义。UI 展示需要转换时，只在适配边界转换。

### 4.4 Snapshot 和事件分工

- Snapshot：首次加载、页面刷新、断线恢复、显式 resync
- Delta event：流式文本、thinking、工具更新、运行状态、队列和元数据变化

不能在每个 token 上广播完整历史。

### 4.5 单会话单写

同一个 Pi session 的所有命令必须串行进入同一个执行器。不能有两个请求同时直接操作同一个 `AgentSessionRuntime`。

### 4.6 开发测试不调用真实模型

所有单元、协议、服务、集成和端到端测试使用 mock runtime、fixture 或 faux provider。真实模型只用于人工验收，且必须由开发者显式启动 `PIUI_DRIVER=pi`。

### 4.7 先稳定核心，再增加功能

开发顺序固定为：

1. 单一后端和安全
2. 会话执行与事件一致性
3. 持久化和恢复
4. 去除 OpenCode 数据层
5. 完善 Pi 能力
6. 文件、Git、PTY 和桌面端

## 5. 当前状态

### 5.1 已具备的基础

- monorepo 已拆为 `app`、`protocol`、`server`、`pi-worker`
- mock driver 默认启用，不调用模型
- real Pi driver 可以创建 runtime 并发送真实 prompt
- Pi 模型列表和模型切换已有基础接口
- 文本、thinking 和基础工具事件可以投影到现有 Chat UI
- session snapshot、runtime state 和 timeline 已有 v1 类型
- WebSocket 可以广播 session snapshot
- 文件 list/read/search/write + ETag 已有服务端实现
- Git status/info/diff 摘要已有服务端实现
- abort、compact、thinking level、skills/commands、steer/follow-up 有部分实现
- mock 测试当前通过

### 5.2 当前阻断问题

#### P0：必须立即处理

1. Legacy OpenCode SSE 源码仍在，但 PiUI 运行时已禁用该 transport，待阶段 6 删除
2. SDK shim 对未实现操作返回假成功
3. 本地 server CORS 为 `*`，接口没有认证，WebSocket 不校验 Origin
4. 同一 session 可以并发 prompt，runtime 订阅会互相覆盖
5. workspace 和 session 仅保存在内存，server 重启后全部失效
6. PTY UI 可见，但没有 Pi PTY 后端

#### P1：核心稳定性问题

1. 前端 projection store 只能保存一个 session
2. 前端不校验 snapshot 的 `epoch/sequence`
3. WebSocket 没有 session 订阅、cursor、replay 和 resync
4. set-model、thinking、compact、abort 等命令没有统一递增 sequence
5. runtime state 变化没有稳定发布到前端
6. 深链接可能在 Pi session index 初始化前落到旧 SDK 路径
7. Pi JSONL 已落盘，但 PiUI 不保存 `sessionFile`，也不会恢复
8. 真实 provider/model、entry ID、error/aborted 状态存在错误投影

#### P2：功能完整性问题

1. 工具输出缺少增量 bash、图片、patch、cwd、exitCode
2. command/skill/extension 映射不完整
3. attachments 没有进入真实 prompt
4. Git diff 内容不足，Git 状态解析有边界错误
5. 文件写入未完整接入编辑器
6. undo/redo 快捷操作尚未映射为 Pi tree navigation；会话树和显式 navigate 已接入
7. PTY、Tauri 桌面壳未完成

### 5.3 当前测试结论

- `npm test`：通过，包含 protocol、server、pi-worker、app Vitest 和 live mock server 测试
- `npm run build`：通过，完整构建 protocol、pi-worker、server 和 app
- server 与 app TypeScript 检查通过
- 真实 Pi SDK + faux provider 无网络集成测试通过
- worker crash、心跳超时、generation 隔离、跨进程 lease 和服务退出故障测试通过

当前结果覆盖 R0-R3 完成条件，但 R4-R12 尚未完成，产品仍未达到发布标准。

## 6. 目标架构

```text
┌─────────────────────────────────────────────────────┐
│ packages/app                                        │
│ React UI                                            │
│                                                     │
│ BackendClient                                       │
│ ├─ health / capabilities                            │
│ ├─ sessions / commands                              │
│ ├─ workspaces / files / git                         │
│ ├─ pty                                              │
│ └─ EventClient (WS + cursor + resync)               │
└──────────────────────┬──────────────────────────────┘
                       │ authenticated HTTP / WS
┌──────────────────────▼──────────────────────────────┐
│ packages/server                                     │
│                                                     │
│ API validation                                      │
│ Authentication / Origin / Trust                     │
│ SessionCatalog                                      │
│ SessionExecutor (one writer per session)            │
│ EventLog / EventHub                                  │
│ Workspace / Files / Git / PTY                       │
└──────────────────────┬──────────────────────────────┘
                       │ typed worker protocol
┌──────────────────────▼──────────────────────────────┐
│ packages/pi-worker                                  │
│                                                     │
│ Pi runtime adapter                                  │
│ Pi event normalization                              │
│ Projection                                          │
│ Session open / resume / fork / dispose              │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│ @earendil-works/pi-coding-agent                     │
│ ~/.pi/agent / Pi JSONL / models / tools             │
└─────────────────────────────────────────────────────┘
```

### 6.1 包职责

#### `packages/protocol`

- HTTP request/response 类型
- WebSocket command/event 类型
- runtime 与 presentation 类型
- schema 和运行时校验
-错误码、protocol version、capabilities
- 不依赖 React、Node server 或 Pi SDK

#### `packages/server`

- 监听 loopback
- 认证和 Origin 校验
- 请求体校验和大小限制
- workspace catalog
- session catalog 和 command executor
- event replay
- 文件、Git、PTY
- worker 生命周期
- 不含 UI 类型转换

#### `packages/pi-worker`

- Pi SDK 的唯一直接调用方
- 打开新 session 或已有 JSONL
- 将 Pi event 转成 PiUI protocol event
- 维护 session runtime 和 projection
- 处理 prompt、abort、compact、model、thinking、queue、fork、tree
- 最终应支持独立进程运行

#### `packages/app`

- 只通过 PiUI protocol 与 server 交互
- 不直接 import Pi SDK
- 不包含 OpenCode SDK shim
- 按 capability 展示功能
- 按 sessionId 保存 snapshot 和 runtime state
- 负责展示，不推断服务端状态

## 7. 核心数据设计

### 7.1 WorkspaceRecord

至少包含：

```ts
interface WorkspaceRecord {
  id: string
  canonicalRoot: string
  displayName: string
  trusted: boolean
  createdAt: string
  lastOpenedAt: string
}
```

要求：

- `id` 重启后稳定
- Windows 路径按规范化形式比较，处理盘符大小写
- 不把绝对路径放进浏览器 hash
- 删除 workspace 不删除项目文件
- 未 trust 的 workspace 不能执行模型工具和终端命令

### 7.2 SessionRecord

至少包含：

```ts
interface SessionRecord {
  id: string
  workspaceId: string
  driverId: "pi"
  driverSessionId: string
  sessionFile: string | null
  title: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  archivedAt: string | null
  epoch: string
  sequence: number
  runtimeState: "detached" | "idle" | "running" | "retrying" | "compacting" | "crashed"
}
```

要求：

- PiUI session ID 与 Pi driver session ID 分开
- 保存 `sessionFile`，重启后可以恢复
- session metadata 写入使用原子更新
- server 启动时不必打开所有 runtime，可按需 attach
- runtime 崩溃不删除 session record

### 7.3 EventRecord

至少包含：

```ts
interface EventRecord<T> {
  protocolVersion: 1
  epoch: string
  sequence: number
  eventId: string
  sessionId?: string
  workspaceId?: string
  timestamp: string
  type: string
  payload: T
}
```

要求：

- 同一 session 内 sequence 单调递增
- 所有状态变化都产生 event
- command HTTP response 和 WS event 使用同一 sequence
- 客户端忽略旧 sequence
- 发现跳号后请求 resync

### 7.4 CommandRecord

至少包含：

```ts
interface CommandRecord {
  commandId: string
  sessionId: string
  kind: string
  status: "accepted" | "running" | "completed" | "failed" | "cancelled"
  submittedAt: string
  completedAt?: string
  error?: ProblemV1
}
```

要求：

- `commandId` 由客户端生成
- 重复提交同一个 `commandId` 不能重复执行
- prompt、compact、set-model 等都进入同一 session executor
- HTTP 返回 `202 Accepted`，结果通过事件或 command 查询获得

## 8. 安全设计

PiUI server 能读取文件、写文件、启动终端和调用模型，安全属于发布阻断项。

### 8.1 网络边界

- 默认只监听 `127.0.0.1`
- 不提供 `0.0.0.0` 默认配置
- HTTP 检查允许的 Origin
- WebSocket upgrade 检查 Origin
- 禁止 `Access-Control-Allow-Origin: *`
- 请求体设置明确上限
- WS frame 设置大小上限

### 8.2 本地认证

浏览器开发模式和桌面模式都使用随机 token：

- server 启动时生成或读取 token
- HTTP 使用 `Authorization: Bearer <token>`
- WebSocket 使用一次性 ticket 或安全 query token
- token 不写进日志
- token 不放进 session URL/hash

开发阶段可由 Vite dev server 注入，桌面阶段由 Tauri 进程传递。

### 8.3 Workspace trust

未信任项目允许：

- 查看项目路径和基础文件列表
- 手动确认 trust

未信任项目禁止：

- 运行 Pi prompt 中的工具
- 写文件
- 启动 PTY
- 执行 Git 写操作

### 8.4 文件安全

- 所有文件接口只接收 workspace-relative path
- 拒绝绝对路径和 `..` 逃逸
- 拒绝 symlink/junction 逃逸
- Windows 增加 junction、UNC、大小写测试
- 读取和写入都限制文件大小
- 二进制文件不能误按 UTF-8 写回
- 写入继续使用 ETag 或 revision

## 9. Capability 设计

health response 增加：

```json
{
  "ok": true,
  "service": "piui-server",
  "protocolVersion": 1,
  "driver": "pi",
  "capabilities": {
    "sessions": {
      "rename": true,
      "archive": true,
      "fork": false,
      "undo": false,
      "share": false
    },
    "files": {
      "read": true,
      "write": true,
      "search": true
    },
    "git": {
      "diff": true,
      "stage": false,
      "commit": false
    },
    "pty": false
  }
}
```

前端不得通过“请求一下看看是否 404”判断功能是否存在。

## 10. 阶段总览

| 阶段 | 名称 | 结果 | 状态 |
|---|---|---|---|
| 0 | 基线冻结与真实门禁 | 当前状态可重复验证 | 已完成 |
| 1 | 单一 Pi 后端 | OpenCode SSE 和双 server 状态停止运行 | 已完成 |
| 2 | 安全与能力控制 | 本地接口有认证、Origin 和 trust | 进行中 |
| 3 | 会话执行内核 | 单 session 单写，命令可追踪 | 进行中 |
| 4 | 事件协议与多会话状态 | delta、sequence、replay、resync 可用 | 待开始 |
| 5 | 持久化与 Pi JSONL 恢复 | 重启不丢 workspace/session | 待开始 |
| 6 | 去除 OpenCode 数据层 | SDK shim、SSE、旧类型全部删除 | 进行中 |
| 7 | Pi 会话能力完善 | 模型、thinking、queue、compact、tree 完整 | 待开始 |
| 8 | 文件与 Git 完善 | 编辑、完整 diff 和常用 Git 操作可用 | 待开始 |
| 9 | PTY 与桌面端 | Pi 原生 PTY，可选 Tauri 壳 | 待开始 |
| 10 | 发布准备 | CI、安装、升级、文档和验收完成 | 待开始 |

## 11. 阶段 0：基线冻结与真实门禁

### 目标

让测试结果真实反映项目状态，避免在不健康的基础上继续开发。

### 任务

1. 修复根 `typecheck`
2. 修复 app `typecheck`
3. 将 app Vitest 加入根 `npm test`
4. 根 `build` 构建 protocol、pi-worker、server、app
5. server 增加正式 build 输出，不再依赖 tsx 才能运行
6. 解决 server `.ts` import 与 tsconfig 不一致
7. 避免 server 通过 pi-worker 旧 `dist` 运行
8. 删除或重建 `packages/app/package-lock.json`
9. 修正根 lockfile 的旧 workspace 记录
10. 明确所有测试固定 `PIUI_DRIVER=mock`
11. 保存当前 OpenCode 残留清单，作为递减门禁
12. 新增禁止真实模型调用的测试保护

### 必须新增的命令

```bash
npm run clean
npm run build
npm run typecheck
npm test
npm run test:app
npm run test:e2e:mock
```

### 验收

```bash
PIUI_DRIVER=mock npm test
npm run typecheck
npm run build
git status --short
```

全部成功，构建后工作树没有非预期生成文件。

### 退出条件

- 根命令覆盖四个 package
- 测试环境无法因外部环境变量切换到 real Pi
- CI 与本机运行同一套命令

## 12. 阶段 1：单一 Pi 后端

### 目标

浏览器启动后只连接 PiUI server，不再初始化 OpenCode SDK、SSE、health 或 server store。

### 任务

1. 新建统一 `BackendConfig` 和 `BackendClient`
2. 在 React render 前完成一次 health/bootstrap
3. 验证 health 的 `service` 和 `protocolVersion`
4. HTTP、WS、模型、session、workspace、file、Git 共用 base URL
5. 删除 `VITE_PIUI_MOCK=0` 阻止 Pi 探测的行为
6. mock seed 只作为开发选项，不参与后端模式判断
7. 启动时不自动创建真实 session，不覆盖深链接
8. 将默认 server 从 4096 改为同源或 8787
9. 停止读取 `opencode-servers` 和 `opencode-active-server`
10. 停止请求 `/global/health`
11. 停止请求 `/global/event`
12. Pi WS 独立维护连接状态、online 和 visibility
13. 移除 `events.ts` 中浏览器 `require()`
14. 给启动流程和“server 不可用”页面增加测试

### 验收

- 浏览器 Network 中没有 4096 请求
- 没有 `/global/health`
- 没有 `/global/event`
- 页面前后台切换不会启动 SSE
- server 未启动时显示明确状态，不落到 OpenCode 路径
- 打开已有 session hash 不会自动新建会话

### 退出条件

生产运行时只存在 PiUI HTTP/WS 连接。

## 13. 阶段 2：安全与能力控制

### 目标

本机文件、终端和模型接口不允许被任意网页调用；未实现入口不再假成功。

### 任务

1. 实现本地 bearer token
2. 收紧 CORS
3. HTTP 校验 Origin
4. WS 校验 Origin 和 token
5. 增加 HTTP body 与 WS frame 限制
6. health 增加 capabilities
7. 前端增加 capability store
8. 隐藏当前无后端的 PTY
9. 隐藏 share/unshare
10. 隐藏 fork/undo/redo，直到 Pi tree 完成
11. 隐藏或禁用 MCP/LSP/worktree/config 等旧接口
12. SDK shim 改为明确抛 `NOT_SUPPORTED`，不再返回假成功
13. 增加 workspace trust
14. 工具执行、写文件和 PTY 检查 trust
15. 日志清理 token、auth 和敏感路径内容

### 验收

- 非允许 Origin 的 HTTP/WS 请求被拒绝
- 无 token 请求被拒绝
- 未 trust workspace 不能执行工具或写文件
- 所有可见按钮都存在真实后端实现
- 搜索生产代码，不存在通用 Proxy 假成功

## 14. 阶段 3：会话执行内核

### 目标

每个 session 的命令按确定顺序执行，并具有可查询的生命周期。

### 任务

当前已完成：`SessionExecutor`、session 级串行队列、独立 abort 控制队列、客户端 `commandId`、重复提交幂等、命令状态查询、`command.updated` 生命周期事件，以及 prompt/compact/abort 接入。其余命令、真正的 `202 Accepted` 异步响应、取消与 shutdown 语义仍待实现。

1. 新建 `SessionExecutor`
2. 每 session 一个队列和一个活动命令
3. commandId 由客户端生成
4. 重复 commandId 幂等
5. prompt HTTP 改为 `202 Accepted`
6. compact、set-model、set-thinking、fork 等统一进入 executor
7. 定义 busy 行为
8. 定义 streaming 时 steer 和 follow-up 的入队规则
9. abort 可以取消活动命令
10. abort 后清理或保留队列的规则明确化
11. runtime dispose 和 server shutdown 有超时控制
12. worker 错误转为稳定 Problem JSON
13. 所有状态变化递增 sequence
14. 禁止 `RealPiSession.prompt()` 使用会互相覆盖的共享临时订阅

### 状态机

```text
detached -> attaching -> idle
idle -> running -> idle
running -> retrying -> running
running -> compacting -> idle
running -> aborting -> idle
any -> crashed
crashed -> attaching -> idle
```

非法状态转换必须有测试。

### 验收

- 两个并发 prompt 不会破坏消息
- 重复 commandId 只执行一次
- abort 后 runtime 回到确定状态
- compact 与 prompt 不会同时操作 runtime
- server shutdown 会 dispose runtime

## 15. 阶段 4：事件协议与多会话状态

### 目标

流式更新、断线重连和多 pane 状态稳定，不串 session，不回退到旧状态。

### 任务

1. 将 `EventEnvelopeV1.type` 改为判别联合
2. 为每个 event 定义 payload schema
3. 增加运行时 schema 校验
4. 定义 session delta 事件：
   - `session.state.changed`
   - `session.metadata.updated`
   - `message.started`
   - `message.text.delta`
   - `message.thinking.delta`
   - `message.completed`
   - `tool.started`
   - `tool.updated`
   - `tool.completed`
   - `queue.updated`
   - `model.changed`
   - `thinking.changed`
   - `command.updated`
5. snapshot 只用于初始加载和 resync
6. WS 支持 subscribe/unsubscribe session
7. WS 支持 cursor
8. server 保存有限 event replay buffer
9. cursor 过期时返回 `RESYNC_REQUIRED`
10. 客户端按 `(epoch, sequence)` 丢弃旧事件
11. 发现 sequence 跳号后 fetch snapshot
12. projection store 改成按 sessionId 保存
13. 每个 pane 只订阅自己的 session runtime
14. WS 重连后恢复订阅和 cursor
15. 慢客户端增加 backpressure 或断开规则

### 验收

- 两个 session 同时流式不会串状态
- 乱序事件不会覆盖新状态
- 断开 WS 后恢复，不丢最终消息
- cursor 过期会自动 resync
- 单个 token 不广播完整 timeline

## 16. 阶段 5：持久化与 Pi JSONL 恢复

### 目标

server 重启和页面刷新后，workspace、session、消息和 Pi runtime 可以恢复。

### 存储选择

SQLite 只保存 Pi 不负责的 UI 元数据。Pi session 由 `SessionManager.list/listAll` 发现，Pi JSONL 继续作为 Pi 原生会话内容来源。

SQLite 保存：

- 常用 workspace 与 trust
- UI 归档、布局和草稿
- 必要的 command metadata
- schema version

不复制保存完整 Pi 消息正文，避免双数据源冲突。UI snapshot 可按需从 JSONL 重建并做短期缓存。

### 任务

1. 选择数据目录
2. 引入 SQLite 和 migration
3. 持久化 UI workspace 与 trust
4. 通过 `SessionManager.list/listAll` 发现 Pi session
5. 使用 Pi session ID 作为 PiUI session ID
6. server 不接受浏览器提供的任意 `sessionFile`
7. session 首次访问时按服务端发现的路径 attach runtime
8. 从 Pi JSONL entries 重建 projection
9. 保存并恢复 leafId/tree
10. 支持扫描 Pi 已有 session
11. 处理 JSONL 文件缺失、损坏和外部修改
12. server 重启后 epoch 更新，sequence 重新建立
13. 客户端 workspace cache 遇到 404 自动刷新
14. 深链接直接加载持久 session
15. 增加 schema migration 和备份测试

### 验收

1. 创建 workspace 和 session
2. 使用 mock/faux provider产生历史
3. 停止 server
4. 重启 server
5. 原 session ID 仍可打开
6. timeline、模型、thinking、workspace 绑定正确
7. 可以继续发送下一条消息

整个测试不得访问网络模型。

## 17. 阶段 6：去除 OpenCode 数据层

### 目标

生产代码完全不依赖 OpenCode SDK、SSE、server store 和派生类型。

### 迁移顺序

#### 第一批：会话核心

- list/get/create/delete
- rename/archive
- prompt/abort
- model/thinking
- compact
- command/skills
- diff

#### 第二批：UI 全局状态

- server health
- global events
- session status
- project/path
- provider/model 类型

#### 第三批：附属功能

- file/vcs
- permission/question
- PTY
- worktree
- MCP/LSP/config/tool/agent

### 自有 UI 类型

建立并逐步替换：

- `UiSession`
- `UiMessage`
- `UiPart`
- `UiModelRef`
- `UiToolState`
- `UiPermissionRequest`
- `UiQuestionRequest`
- `UiPty`

保留 `timelineToMessages` 一类纯展示适配器可以接受，但它们不能 import OpenCode SDK 类型。

### 删除项

- `src/shims/opencode-sdk`
- Vite SDK alias
- tsconfig SDK paths
- `api/sdk.ts`
- `api/events.ts` 中 OpenCode SSE transport
- `api/sse.ts`
- `/global/event`
- `/global/health`
- 4096 默认常量
- OpenCode server storage keys
- 旧 SDK 单元测试
- 旧 app lockfile 中 SDK 记录

### 静态门禁

生产源码必须满足：

```bash
git grep "@opencode-ai/sdk" -- packages/app/src
git grep "/global/event" -- packages/app/src
git grep "/global/health" -- packages/app/src
git grep "127.0.0.1:4096" -- packages/app/src
git grep "createOpencodeClient" -- packages/app/src
```

全部无结果。

### 验收

- 删除 shim 后 app 可以 typecheck、test、build
- 所有可见操作走 PiUI protocol
- 未实现操作由 capability 控制

## 18. 阶段 7：Pi 会话能力完善

### 18.1 消息和工具

- 使用 Pi 原生稳定 entry ID
- 保留 parent entry ID
- 正确记录 provider/model
- 正确处理 stopReason
- error、aborted、completed 状态准确
- thinking 与 text 增量可独立更新
- tool execution update 可增量展示
- bash 输出支持增量和截断提示
- 图片工具结果可展示
- 标准化 cwd、exitCode、patch
- context usage 进入 snapshot/UI

### 18.2 模型与思考等级

- 模型列表来自 Pi ModelRuntime
- 正确读取 supportsThinking
- thinking level 选项按模型变化
- session 恢复时恢复模型和 thinking level
- set-model 失败不修改前端已选状态
- provider 凭据错误显示明确说明

### 18.3 队列、steer、follow-up

- UI 明确区分 steer 和 follow-up
- 展示当前 queue
- 支持删除队列项
- abort 后队列行为可配置或明确固定
- queue update 使用事件推送

### 18.4 compact 和 retry

- compact 作为异步 command
- compact instructions 正确传入
- compact 中可 abort
- 会话太短时显示非错误提示
- auto compact 状态可见
- retry 次数、等待时间和错误原因可见
- 可手动停止 retry

### 18.5 commands、skills、extensions

- 内置命令、skills、prompt templates、extension commands 分类正确
- 命令面板只展示可执行命令
- 参数和 autocomplete 正确
- extension command 没有通用 UI 时显示文本结果
- 不支持的 TUI-only extension 明确标记

### 18.6 tree、fork、undo、redo

- 从 Pi JSONL 构建 entries/tree
- snapshot `native.entries/tree` 不再为空
- fork 使用 Pi 原生分支语义
- undo/redo 与 Pi leaf 切换一致
- UI 多 pane 可以打开不同分支
- 外部 JSONL 修改时检测冲突

### 18.7 attachments

- 图片、文本文件和 PDF 按 Pi 支持能力发送
- 上传前显示大小和类型限制
- 不支持类型不能静默丢弃
- 附件错误不影响纯文本草稿

### 验收

为每项建立 faux provider 集成测试和 mock E2E，不调用真实模型。

## 19. 阶段 8：文件与 Git 完善

### 19.1 文件

- 文件树只使用 workspace-relative path
- 目录缓存按 workspaceId 隔离
- 文件读取支持文本、图片和二进制提示
- 编辑器接入 PUT + ETag
- stale revision 提供 reload、compare、overwrite 选择
- 文件正文搜索
- 符号搜索
- 大仓库搜索取消和超时
- ignore 规则明确
- 文件变化事件更新树和编辑器

### 19.2 Git

- 使用可靠的 porcelain v2 `-z` 解析
- 修正 rename、copy、空格、Unicode 路径
- 区分 tracked modified、added、deleted、untracked
- 完整 diff 提供 patch、before、after
- 支持 staged/unstaged 切换
- 增加 stage/unstage
- 增加 discard，必须二次确认
- 增加 commit，遵守显式用户操作
- branch create/switch 作为后续能力
- 所有 Git 写操作检查 capability 和 trust

### Windows 测试

- 盘符大小写
- junction
- UNC 路径
- 空格目录
- 中文文件名
- CRLF
- 超长路径

### 验收

- 文件树、编辑器和 Git 面板使用同一个 workspace
- diff 内容与 `git diff` 一致
- rename 和 Unicode 路径不会解析错
- stale write 不覆盖用户文件

## 20. 阶段 9：PTY 与桌面端

PTY 和 Tauri 分开实现。先做 server PTY，再决定桌面壳。

### 20.1 Pi 原生 PTY

协议至少包括：

- create
- list
- get
- input
- resize
- kill
- remove
- output event
- exit event
- cursor replay

服务端要求：

- Windows 使用 ConPTY 兼容库
- PTY cwd 必须属于 trusted workspace
- shell 参数经过明确校验
- 输出有 buffer 上限
- WS 断线后按 cursor replay
- server 退出时清理子进程
- 浏览器不能自行构造任意进程启动参数

前端要求：

- 只有 capability 为 true 才显示终端
- tab 恢复使用真实 PTY ID
- input、resize、kill 状态准确
- 断线重连不重复输出
- 进程退出后不无限重连

### 20.2 Tauri 桌面端

如果决定发布桌面端：

1. 新建 PiUI 自己的 `src-tauri`
2. 不复制旧 OpenCode service manager
3. Tauri 负责启动和停止 PiUI server
4. token 通过进程间安全方式传递
5. 实现窗口、文件选择、通知和升级
6. HTTP/WS 可继续走 loopback，也可增加受控 bridge
7. 打包时包含正确 Node/runtime 或编译后的 server
8. Windows 安装、升级、卸载都有测试

如果暂不做桌面端：

- 删除失效 Tauri scripts
- 删除旧 native service 设置页
- 浏览器版本文档写清启动方式

### 验收

- 浏览器 PTY 先独立通过
- 桌面壳不依赖 OpenCode 二进制
- 关闭应用后不残留 server 或 shell 进程

## 21. 阶段 10：发布准备

### 21.1 CI

每个 PR 运行：

```bash
npm ci
PIUI_DRIVER=mock npm test
npm run typecheck
npm run build
npm run test:e2e:mock
```

增加：

- Windows runner
- Linux runner
- lockfile 检查
- 生产源码禁用 OpenCode 关键字门禁
- 测试不得访问真实 provider 的保护
- 依赖漏洞检查
- 构建产物 smoke test

### 21.2 可观察性

- 结构化 server 日志
- requestId、commandId、sessionId
- 不记录 token 和完整 prompt
- worker crash 日志
- WS 重连和 resync 计数
- debug bundle 可由用户显式导出

### 21.3 文档

- 安装
- 本地开发
- mock 与 real Pi 启动区别
- provider 凭据位置
- 安全说明
- 数据目录和备份
- session 恢复
- 故障诊断
- 升级和 migration
- 许可证和 OpenCodeUI 来源说明

### 21.4 发布验收

- 新安装可启动
- 已有配置可升级
- server 重启可恢复会话
- WS 断线可恢复
- 长会话可 compact
- 工具运行与 abort 正常
- 文件编辑不会越界或静默覆盖
- PTY 能退出并清理进程
- 不配置真实 provider 时也可运行 mock/demo

## 22. 测试完整规划

### 22.1 Protocol 测试

- schema 正例和反例
- protocol version 不匹配
- event 判别联合
- Problem JSON
- command request/response
- 未知字段处理

### 22.2 Pi worker 单元测试

- Pi event 到 delta event 映射
- text/thinking/tool 流
- tool error
- abort/error/stopReason
- provider/model
- stable entry ID
- tree projection
- JSONL replay

### 22.3 Faux provider 集成测试

- runtime create/open/resume/dispose
- prompt
- abort
- steer/follow-up
- compact
- retry
- model/thinking
- skills/commands
- attachments
- 不允许任何公网请求

### 22.4 Server 测试

- auth/Origin/CORS
- body size
- workspace trust
- command 幂等和并发
- session persistence
- worker crash/restart
- WS subscribe/cursor/replay/resync
- file path safety
- Git parser
- PTY 生命周期

### 22.5 App 单元测试

- BackendClient
- bootstrap
- capability store
- session-scoped projection store
- epoch/sequence reducer
- event resync
- sessionApi error mapping
- 各可见操作不调用旧 shim

### 22.6 E2E mock

桌面尺寸和移动尺寸至少覆盖：

1. 启动并连接 server
2. 打开 workspace
3. 创建 session
4. 流式 text/thinking/tool
5. abort
6. 模型与 thinking level
7. 双 pane 双 session
8. 页面刷新恢复
9. server 重启恢复
10. WS 断线恢复
11. 文件读取和编辑
12. Git diff
13. PTY

## 23. OpenCode 残留处理表

| 残留 | 当前处理 | 最终处理 |
|---|---|---|
| SDK shim | 临时阻止编译崩溃 | 阶段 6 删除 |
| `api/events.ts` SSE | 当前仍可能运行 | 阶段 1 停止，阶段 6 删除 transport |
| `serverStore` | 当前仍以 4096 健康检查 | 阶段 1 替换 |
| `types/api/*` SDK 类型 | 当前大量引用 | 阶段 6 替换为自有类型 |
| `api/session.ts` | 多个可见操作仍调用 | 阶段 6 迁移 |
| `api/pty.ts` | 当前是假功能 | 阶段 2 隐藏，阶段 9 重写 |
| OpenCode Tauri service | 当前代码残留 | 阶段 1/9 删除 |
| `src-router` | 当前无主入口 | 确认外部无引用后删除 |
| app 独立 lockfile | 含旧 SDK | 阶段 0 删除或重建 |
| manifest/README 文案 | 仍有旧名称 | 阶段 10 清理 |
| `_archive` | 只读参考 | 保留，不参与构建 |

## 24. 功能完成定义

一个功能只有同时满足以下条件，才能在矩阵中标为“已完成”：

1. 有真实 server/worker 实现
2. 有 protocol 类型和运行时校验
3. UI 调用的是 PiUI API，不是 SDK shim
4. 状态刷新和错误显示正确
5. 页面刷新后行为正确
6. WS 断线后行为正确
7. 有 mock/faux provider 自动测试
8. 未调用真实模型完成自动验收
9. 文档和 capability 已更新

只完成 UI、只完成 API、只在本机手工点通，都只能标为“部分完成”。

## 25. 提交与分支约定

每个提交只处理一个清晰问题，例如：

- `fix(app): stop legacy SSE before render`
- `feat(protocol): add backend capabilities`
- `feat(server): serialize session commands`
- `feat(server): persist session catalog`
- `refactor(app): replace session SDK calls`
- `feat(pty): add cursor-based output replay`

每个阶段建议拆成多个可验证提交，不做一次性全仓改写。

提交前至少运行受影响 package 的：

```bash
npm run typecheck -w <workspace>
npm run test -w <workspace>
npm run build -w <workspace>
```

阶段结束再运行根验收命令。

## 26. 推荐执行批次

### 批次 A：项目止损

预计内容：阶段 0 + 阶段 1

- 修真实门禁
- render 前 bootstrap
- 统一 base URL
- 停止旧 SSE/health
- 不再自动创建 real session

完成标志：浏览器只连接 PiUI server，根测试、类型和构建可信。

### 批次 B：安全和显式能力

预计内容：阶段 2

- token、Origin、trust
- capability store
- 隐藏所有假功能
- shim 改为明确失败

完成标志：界面上能点的功能都真实有效。

### 批次 C：会话内核

预计内容：阶段 3 + 阶段 4

- SessionExecutor
- commandId
- delta event
- sequence/cursor/replay
- 多 session store

完成标志：双 session、并发、断线恢复稳定。

### 批次 D：重启恢复

预计内容：阶段 5

- SQLite catalog
- sessionFile
- JSONL replay
- lazy attach

完成标志：server 重启后继续原会话。

### 批次 E：清除旧数据层

预计内容：阶段 6

- 自有 UI 类型
- 迁移所有调用点
- 删除 SDK shim、SSE 和旧 server store

完成标志：静态门禁中所有 OpenCode 运行时关键字为零。

### 批次 F：Pi 完整能力

预计内容：阶段 7

- 工具、队列、compact、retry
- commands/skills/extensions
- attachments
- tree/fork/undo

完成标志：Pi 的核心 coding agent 能力在 UI 中稳定可用。

### 批次 G：IDE 能力和发布

预计内容：阶段 8 至 10

- 文件编辑和 Git
- PTY
- Tauri 可选
- CI、安装、文档和发布

## 27. 第一轮具体任务

下一轮开发从以下顺序开始：

1. 修复 server tsconfig/import，使根 typecheck 能继续执行
2. 移除 `events.ts` 中的 `require()`
3. 将 Pi health 探测移到 React render 前
4. 新建统一 backend config
5. 将旧 global event subscribers 临时接到 Pi event adapter 或禁用
6. 停止 OpenCode `/global/health` 检查
7. 停止读取 4096 默认 server
8. 取消 real Pi 启动时自动创建 session
9. capability 中将 PTY、share、fork、undo 标为 false
10. 隐藏对应 UI 入口
11. phase3 测试改为禁止生产 OpenCode SDK import，而不是要求 shim 存在
12. 把 app test、typecheck、pi-worker build 加入根命令

第一轮不同时重写消息类型、不做持久化、不做 PTY。先保证只有 Pi 后端在运行，并让门禁可信。

## 28. 决策记录

需要在实现前确认并写 ADR 的事项：

1. catalog 使用 SQLite 的具体库
2. worker 是否立即拆 child process，还是持久化后再拆
3. WebSocket replay buffer 使用内存还是持久存储
4. 浏览器开发 token 如何注入
5. Pi JSONL 外部修改的冲突规则
6. PTY 使用的跨平台库
7. 第一版是否包含 Tauri
8. OpenCode 视觉壳未来保留多少设置页面

推荐决定：

- SQLite catalog：采用
- child worker：会话内核稳定后拆，不在第一轮同时做
- event replay：先内存有限 buffer，snapshot resync 兜底
- PTY：server 能力先于 Tauri
- OpenCode 设置页：没有 Pi 对应能力的直接删除，不保留空页面

## 29. 最终完成标准

PiUI 第一版只有满足以下全部条件才算完成：

- 生产运行时不连接 OpenCode
- 生产源码不依赖 OpenCode SDK 或 shim
- server 重启后会话可恢复
- 双 session 同时运行不串状态
- WebSocket 断线可恢复
- prompt、abort、model、thinking、queue、compact、retry 正常
- text、thinking、tool、error、aborted 展示准确
- 文件和 Git 使用安全 workspace 边界
- PTY 有真实后端或在第一版明确不提供且完全隐藏
- 本地接口有认证、Origin 和 trust
- 根 test、typecheck、build 全部通过
- 自动测试不调用真实模型
- 安装、升级、备份和故障文档完整

完成这些以后，PiUI 才是独立、稳定、可继续维护的 Pi 图形客户端，而不是依赖旧 OpenCode 数据层的 UI 改造版。
