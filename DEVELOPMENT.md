# PiUI 开发文档

## 目标

**保留 OpenCodeUI 成熟视觉结构，实现 Pi 0.81.1 原生全功能客户端。**

- 视觉壳：fork `_archive/opencodeui-baseline`（GPL-3.0）
- 运行时：自有 protocol + server + pi-worker，**不**接 OpenCode SDK / 兼容层
- 不调用真实模型做开发验收（用 mock / 无网络 unit 测试）

主计划：`docs/PIUI_MASTER_PLAN.md`

能力矩阵：`docs/PI_UI_INTEGRATION.md`

基线设计：`docs/universal-agent-pi-technical-design.md`

产品边界：`docs/ADR-0002-pi-native-client.md`

## 原则

1. 壳（布局、主题、ChatArea、侧栏、文件、终端）尽量原样
2. 血（api / types / store / hooks / events）整段替换
3. 禁止假 OpenCode SSE / 空 Proxy 当架构
4. 每个 Phase 自测通过后再 commit
5. **禁止**在开发流程里调用 Pi 付费模型对话
6. Pi JSONL 和 `SessionManager` 是会话历史唯一来源，PiUI 不复制保存消息

## 仓库

```text
docs/                         设计文档
packages/app/                 OCUI 视觉壳（GPL）
packages/protocol/            版本化协议
packages/server/              Orchestrator（127.0.0.1）
packages/pi-worker/           Pi SDK worker + 投影 + mock runtime
_archive/opencodeui-baseline  只读参考
_archive/wip-phase0-*         清理前半成品
```

## 历史启动阶段

| Phase | 内容 | 验收 |
|------|------|------|
| 0 | 清理、文档、baseline 恢复、骨架 | `npm run test:phase0` |
| 1 | protocol + server workspace/文件安全路径 | server 单测 |
| 2 | pi-worker 生命周期（无真实 prompt） | worker 单测 |
| 3 | app 去 SDK 依赖，壳可 dev | 无 `@opencode-ai/sdk` 生产 import |
| 4 | Chat 接 mock/host timeline | 投影/reducer 测试 |
| 5+ | 文件/Git/PTY/桌面 | 已由 R0-R12 parity 路线取代 |

当前实施使用主计划中的 R0-R12；上表只记录仓库从 OpenCodeUI 迁出的启动历史

## 本地跑

```bash
npm install
npm run test:phase0
npm run dev:server   # 127.0.0.1:8787
npm run dev:app      # vite
```

## 当前

当前 Pi 原生会话、聊天、文件和 Git 主流程可用，尚未达到稳定产品标准。前端过渡 facade、UI 元数据持久化、fork/undo 和 PTY 后端仍需按主计划处理。下列勾选表示对应能力已有基础实现，不代表已经满足主计划中的完整完成标准。

- [x] Phase 0 结构
- [x] Phase 1 health + workspace + 安全文件 list/read
- [x] Phase 2 pi-worker 投影 + mock turn（无真实模型）
- [x] Phase 3 去掉 npm `@opencode-ai/sdk` 和网络 shim，过渡 facade 不发网络请求，`vite build` 通过
- [x] Phase 4 mock session snapshot API + `sessionProjectionStore`（无真实 prompt）
- [x] Phase 5 timeline→Message 桥接 + mock-chat 灌进 ChatArea（无真实 prompt）
- [x] **最小完成体**：seed 会话 → 输入发送 → mock 回复进 ChatArea（`npm run test:mvp`）
- [x] 侧栏会话列表 / 新建 / 删除 / 切换（Pi server）
- [x] **最小可用**：文件树 list/read 接 server + 会话绑 workspace + abort 占位
- [x] mock 流式：WS `/api/v1/events` + prompt stream 增量 snapshot
- [x] workspace git status / info / diff（文件树改动标记）
- [x] 文件名/正文搜索 + 写文件(ETag) + 侧栏连接态接 Pi WS
- [x] 真 Pi driver：`PIUI_DRIVER=pi` 启用（默认 `mock` 不调模型）
- [x] 真实 Pi runtime 与模型枚举运行在独立 worker 子进程，server 仅通过私有 IPC 调用
- [x] 前端 snapshot 按 Pi session ID 隔离，WS 支持 epoch/sequence 去重、有限重放和 resync
- [x] 会话加载、发送、abort、slash command 和侧栏 CRUD 只使用 Pi API，不再 fallback 到旧 SDK
- [x] Pi 基础能力：模型/thinking level/compact/skills·commands/runtime 状态
- [x] R0：Pi 0.81.1 精确版本、完整 parity matrix、真实 session 性能基线
- [x] R1：Protocol v2 command/capability、分作用域事件 replay、worker handshake 与 generation
- [x] R2：worker supervisor、IPC v3 心跳、跨进程单写 lease、generation 隔离与崩溃恢复
- [x] 阶段 0/1：完整 mock 根测试、全 workspace typecheck/build、render 前 Pi health、旧 SSE 删除、真实 Pi 不再启动即建会话
- [~] 阶段 6：OpenCode SDK 包、shim、alias、类型 import 和网络 client 已删除；旧 facade 函数继续迁往 Pi API
- [ ] fork/undo 映射 Pi tree；终端 PTY
- 矩阵：`docs/PI_UI_INTEGRATION.md`

### 真 Pi 怎么开

```bash
# 需本机已配置 ~/.pi/agent 凭据（auth.json）
npm run dev:server:pi   # Windows / bash 通用
npm run dev:app
# 控制台应有 driver=pi；模型选择器从 /api/v1/drivers/pi/models 拉列表
# 发消息会走真实模型，消耗 token
```

### 发不了消息时先查

1. server 是否在跑，health 是否 200  
2. 模型选择器是否有项（mock 至少有 Mock；pi 看凭据）  
3. 浏览器控制台是否有 promptSession failed  
4. 是否开了会话 hash `#/session/...`  

### 最小可用怎么跑

```bash
npm run dev:server   # 127.0.0.1:8787
npm run dev:app      # 5173，/api 代理到 server
# 打开浏览器 → mock 会话 → 侧栏列表 → 发消息 mock 回复 → 右侧文件树可浏览
# VITE_PIUI_MOCK=0 关闭自动 seed
```
