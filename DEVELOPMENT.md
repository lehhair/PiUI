# PiUI 开发文档

## 目标

**看上去和 OpenCodeUI 完全一样，底下是 Pi。**

- 视觉壳：fork `_archive/opencodeui-baseline`（GPL-3.0）
- 运行时：自有 protocol + server + pi-worker，**不**接 OpenCode SDK / 兼容层
- 不调用真实模型做开发验收（用 mock / 无网络 unit 测试）

基线设计：`docs/universal-agent-pi-technical-design.md`

## 原则

1. 壳（布局、主题、ChatArea、侧栏、文件、终端）尽量原样
2. 血（api / types / store / hooks / events）整段替换
3. 禁止假 OpenCode SSE / 空 Proxy 当架构
4. 每个 Phase 自测通过后再 commit
5. **禁止**在开发流程里调用 Pi 付费模型对话

## 仓库

```text
docs/                         设计文档
packages/app/                 OCUI 视觉壳（GPL）
packages/protocol/            版本化协议
packages/server/              Orchestrator（127.0.0.1）
packages/pi-worker/           投影 + mock runtime（无真实模型）
_archive/opencodeui-baseline  只读参考
_archive/wip-phase0-*         清理前半成品
```

## 阶段

| Phase | 内容 | 验收 |
|------|------|------|
| 0 | 清理、文档、baseline 恢复、骨架 | `npm run test:phase0` |
| 1 | protocol + server workspace/文件安全路径 | server 单测 |
| 2 | pi-worker 生命周期（无真实 prompt） | worker 单测 |
| 3 | app 去 SDK 依赖，壳可 dev | 无 `@opencode-ai/sdk` 生产 import |
| 4 | Chat 接 mock/host timeline | 投影/reducer 测试 |
| 5+ | 文件/Git/PTY/桌面 | 见设计文档 |

## 本地跑

```bash
npm install
npm run test:phase0
npm run dev:server   # 127.0.0.1:8787
npm run dev:app      # vite
```

## 当前

- [x] Phase 0 结构
- [x] Phase 1 health + workspace + 安全文件 list/read
- [x] Phase 2 pi-worker 投影 + mock turn（无真实模型）
- [x] Phase 3 去掉 npm `@opencode-ai/sdk`，本地 shim + `vite build` 通过
- [ ] Phase 4 Chat 接 mock/host timeline
