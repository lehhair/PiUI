# PiUI 开发文档

## 目标

**Pi coding agent 的原生 server：数据零修改透传，能力自省生成 API，UI 直接消费 Pi 原生结构。**

- 运行时：`@earendil-works/pi-coding-agent` SDK 内嵌于 worker 进程（官方对 Node 宿主的推荐方式）
- 协议：registry/命令/响应/事件四段式，对齐官方 runtime registry 语义；Pi 数据不定义中间类型，JsonValue 透传
- 扩展：tool/command 运行时枚举自动生成 API，装扩展零协议改动
- 不调用真实模型做开发验收（mock driver + faux provider）

## 架构

```text
浏览器/客户端
  │  HTTP(registry + 命令口) / WS(事件订阅)
  ▼
packages/server     分发层:不感知 Pi 语义,只转发
  │  IPC(统一命令消息 + 事件 + hostCall)
  ▼
packages/pi-worker  唯一懂 Pi 的进程:命令表 → AgentSession
  │
  ▼
@earendil-works/pi-coding-agent   SDK 内嵌,配置/凭据/扩展/会话全走 ~/.pi/agent 原生路径
```

### 核心原则

1. **零数据转换**:worker→server→客户端的会话数据只做 JSON 结构化复制，不可序列化直接报错
2. **零协议发明**:命令对齐 SDK 方法语义（prompt/steer/followUp/compact/fork/…)，事件就是 Pi 原生事件
3. **零能力白名单**:Pi 能力注册进 registry，HTTP 只按 capability name 分发；扩展 tools/commands 由 Pi runtime 枚举
4. **SDK 可替换**:worker 经 sdk-host 动态加载 SDK，默认 bundle 验证版（0.81.1),`PIUI_SDK_PATH` 可指外部版本
5. **mock 在 worker 内**:server 不感知 driver;mock 会话写独立 JSONL 目录（PIUI_MOCK_DIR)，格式与 Pi 相同

### HTTP 面

```text
GET    /api/v1/pi/registry                       当前 Pi capability registry
POST   /api/v1/pi/commands/:name                 global command,如 models.list/settings.get/session.open
POST   /api/v1/pi/sessions/:id/commands/:name    session command,如 prompt/branch.get/registry.get/invokeTool

GET    /api/v1/host/health                       server 健康检查
GET    /api/v1/host/capabilities                 server 自省(driver/事件流/版本)
GET    /api/v1/host/commands/:id                 命令生命周期查询
GET    /api/v1/host/workspaces ...               host 区:workspaces/files/git(自有能力)

WS     /api/v1/events                            stream 订阅 + cursor/replay/resync
```

### 事件通道（WS envelope.channel)

- `pi.event`:payload = `{event: <裸 Pi 事件>, meta: {epoch, sequence, liveMessage?}}`
- `session.head`:entries/tree 变化后的 head(leafId/entryCount/revision)
- `registry.updated`:runtime 能力变化，payload 含 `{revision, sessionId}`，客户端应重新拉 registry
- `command.updated`:命令生命周期（accepted/running/completed/failed/cancelled)
- `extension.ui` / `provider.auth` / `packages.progress` / `sessions.updated` / `resources.updated`
- `workspace.files` / `workspace.git`:host 区文件与 Git 变化

### 关键命令（capability name)

- global：`registry.describe, session.open, session.attached, session.list, session.listAll, session.delete, models.list, settings.get, settings.patch, trust.get, trust.set, providers.*, modelRuntime.*, packages.*`
- session：`prompt, steer, followUp, sendUserMessage, abort, newSession, switchSession, fork, clone, importSession, setSessionName, setModel, cycleModel, setScopedModels, setThinkingLevel, cycleThinkingLevel, setSteeringMode, setFollowUpMode, clearQueue, compact, abortCompaction, abortBranchSummary, setAutoCompaction, setAutoRetry, abortRetry, bash, abortBash, setActiveTools, invokeTool, invokeCommand, navigateTree, setLabel, sendCustomMessage, appendCustomEntry, exportHtml, exportJsonl, waitForIdle, reload, respondExtensionUi, setExtensionEditorState, state.get, entries.get, branch.get, tree.get, registry.get, attachment.get`

每个 capability 由 `registerPiCapability` 显式注册，registry 是唯一真相。返回字段包括：`name/scope/source/description/paramsSchema/resultSchema/queue/replacement/streaming/cancellable/idempotent/requiresRuntime/requiresTrust`。`paramsSchema` 是 JSON Schema 风格结构，供客户端生成表单和本地校验；result 保持 Pi 原生 JSON 透传，不重建中间模型。

扩展自省：
- `POST /api/v1/pi/sessions/:id/commands/registry.get` → tools(含 JSON Schema)/commands/extensions/eventHandlers，运行时枚举
- `POST /api/v1/pi/sessions/:id/commands/invokeTool` + `{name, arguments}` → 直接执行扩展 tool(ctx.ui 交互走 extension.ui 桥)
- `POST /api/v1/pi/sessions/:id/commands/invokeCommand` + `{name, args}` → 执行扩展 slash command

## 包职责

| 包 | 职责 |
|---|---|
| `packages/protocol` | 信封/命令名/宿主类型。**只有 type 没有 interface**(JsonValue 兼容需要）；不声明 Pi 数据结构 |
| `packages/pi-worker/src/runtime/` | real/mock runtime、catalog、pagination、extension UI、provider auth；唯一直接碰 Pi SDK runtime 的实现区 |
| `packages/pi-worker/src/` | worker 框架：sdk-host、IPC、命令表、参数校验、scheduler、entry |
| `packages/server/src/pi/` | Pi 面分发：worker-client、supervisor、session-host、executor、lease |
| `packages/server/src/host/` | host 面能力：workspace 注册/监听、files、file-search、git、auth/security/path-safety |
| `packages/server/src/` | HTTP/WS/event-hub/shutdown/index 组装层 |
| `packages/app` | OCUI 视觉壳（GPL)。**待适配新协议**，暂不参与根 build/typecheck |

## 本地跑

```bash
npm install
npm test                 # 三包 build + 全部测试(mock,不调模型)
npm run dev:server       # 127.0.0.1:8787,mock driver
npm run dev:server:pi    # 真 Pi(读 ~/.pi/agent 凭据,发消息消耗 token)
```

### 冒烟

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/v1/host/health
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"cwd":"/path/to/project"}' http://127.0.0.1:8787/api/v1/pi/commands/session.open
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"id":"c1","params":{"text":"hi"}}' \
  http://127.0.0.1:8787/api/v1/pi/sessions/$SID/commands/prompt
```

### 环境变量

- `PIUI_DRIVER`: `mock`(默认,不调模型)| `pi`
- `PIUI_MOCK_DIR`: mock 会话目录（默认 `<tmpdir>/piui-mock`)
- `PIUI_SDK_PATH`: 外部 SDK 路径（目录或入口文件；版本与验证版不同时警告放行）
- `PIUI_SDK_STRICT=1`: 外部 SDK 版本不匹配时拒绝启动
- `PIUI_AUTH_TOKEN`: 覆盖本地 token（默认生成并持久化在数据目录）

## 当前状态

- 后端三包（protocol/pi-worker/server)：重构完成，99 测试全绿，含真实 SDK + faux provider 无网络集成测试
- app：未适配新协议，待后续处理
- 待办：invokeTool 的 onUpdate 流式进度、PTY、app 适配、发布门禁（R12 conformance)
