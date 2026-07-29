# PiUI 开发文档

## 目标

**Pi coding agent 的原生 server：数据零修改透传，能力自省生成 API，UI 直接消费 Pi 原生结构。**

- 运行时：`@earendil-works/pi-coding-agent` SDK 内嵌于 worker 进程（官方对 Node 宿主的推荐方式）
- 协议：命令/响应/事件三段式，对齐官方 RPC 语义；Pi 数据不定义中间类型，JsonValue 透传
- 扩展：tool/command 运行时枚举自动生成 API，装扩展零协议改动
- 不调用真实模型做开发验收（mock driver + faux provider）

## 架构

```text
浏览器/客户端
  │  HTTP(命令口 + 只读查询) / WS(事件订阅)
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
3. **零能力白名单**:API 面 = 运行时枚举的注册表（getAllTools/getCommands/extensions),capabilities 动态生成
4. **SDK 可替换**:worker 经 sdk-host 动态加载 SDK，默认 bundle 验证版（0.81.1),`PIUI_SDK_PATH` 可指外部版本
5. **mock 在 worker 内**:server 不感知 driver;mock 会话写独立 JSONL 目录（PIUI_MOCK_DIR)，格式与 Pi 相同

### HTTP 面

```text
GET    /api/v1/health
GET    /api/v1/models                        models.list(catalog)
GET    /api/v1/providers                     providers.list(catalog)
POST   /api/v1/catalog/commands              catalog 统一命令口(settings/trust/packages/...)
GET    /api/v1/sessions?cwd=                 列表(Pi 原生条目)+ attached
POST   /api/v1/sessions                      {cwd, sessionFile?} → attach
GET    /api/v1/sessions/:id                  state
DELETE /api/v1/sessions/:id                  detach
GET    /api/v1/sessions/:id/{state,entries,branch,tree,registry}
GET    /api/v1/sessions/:id/entries/:entryId/attachments/:index
POST   /api/v1/sessions/:id/commands         {id?, type, params?} → 202(幂等,串行)
GET    /api/v1/commands/:id                  命令生命周期查询
GET    /api/v1/workspaces ...                host 区:workspaces/files/git(自有能力)
WS     /api/v1/events                        stream 订阅 + cursor/replay/resync
```

### 事件通道（WS envelope.channel)

- `pi.event`:payload = `{event: <裸 Pi 事件>, meta: {epoch, sequence, liveMessage?}}`
- `session.head`:entries/tree 变化后的 head(leafId/entryCount/revision)
- `command.updated`:命令生命周期（accepted/running/completed/failed/cancelled)
- `extension.ui` / `provider.auth` / `packages.progress` / `sessions.updated` / `resources.updated`
- `workspace.files` / `workspace.git`:host 区文件与 Git 变化

### 关键命令（POST sessions/:id/commands 的 type)

核心 40+：`prompt, steer, followUp, sendUserMessage, abort, newSession, switchSession, fork, clone, importSession, setSessionName, setModel, cycleModel, setScopedModels, setThinkingLevel, cycleThinkingLevel, setSteeringMode, setFollowUpMode, clearQueue, compact, abortCompaction, abortBranchSummary, setAutoCompaction, setAutoRetry, abortRetry, bash, abortBash, setActiveTools, invokeTool, invokeCommand, navigateTree, setLabel, sendCustomMessage, appendCustomEntry, exportHtml, exportJsonl, waitForIdle, reload, respondExtensionUi, setExtensionEditorState`

扩展自省：
- `GET .../registry` → tools(含 JSON Schema)/commands/extensions/eventHandlers，运行时枚举
- `invokeTool {name, arguments}` → 直接执行扩展 tool(ctx.ui 交互走 extension.ui 桥)
- `invokeCommand {name, args}` → 执行扩展 slash command

## 包职责

| 包 | 职责 |
|---|---|
| `packages/protocol` | 信封/命令名/宿主类型。**只有 type 没有 interface**(JsonValue 兼容需要）；不声明 Pi 数据结构 |
| `packages/pi-worker` | sdk-host(动态加载+版本握手）、命令表、real/mock runtime、catalog、IPC |
| `packages/server` | 分发：worker 池/lease/命令幂等串行/事件路由/HTTP/WS/host 区 |
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
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/v1/health
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"cwd":"/path/to/project"}' http://127.0.0.1:8787/api/v1/sessions
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"id":"c1","type":"prompt","params":{"text":"hi"}}' \
  http://127.0.0.1:8787/api/v1/sessions/$SID/commands
```

### 环境变量

- `PIUI_DRIVER`: `mock`(默认,不调模型)| `pi`
- `PIUI_MOCK_DIR`: mock 会话目录（默认 `<tmpdir>/piui-mock`)
- `PIUI_SDK_PATH`: 外部 SDK 路径（目录或入口文件；版本与验证版不同时警告放行）
- `PIUI_SDK_STRICT=1`: 外部 SDK 版本不匹配时拒绝启动
- `PIUI_AUTH_TOKEN`: 覆盖本地 token（默认生成并持久化在数据目录）

## 当前状态

- 后端三包（protocol/pi-worker/server)：重构完成，97 测试全绿，含真实 SDK + faux provider 无网络集成测试
- app：未适配新协议，待后续处理
- 待办：invokeTool 的 onUpdate 流式进度、PTY、app 适配、发布门禁（R12 conformance)
