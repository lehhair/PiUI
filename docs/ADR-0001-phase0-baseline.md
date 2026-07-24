# ADR-0001 Phase 0 基线决定

## 状态

已接受（2026-07-24）

## 决定

1. **许可证**：接受 GPL-3.0，fork OpenCodeUI 视觉壳（`packages/app` 保留 LICENSE）
2. **隔离**：首版 Local trusted，本机单用户，监听 `127.0.0.1`
3. **运行时**：不兼容 OpenCode SDK；自有 protocol + server + 后续 pi-worker
4. **开发**：阶段测试默认不调用真实 LLM
5. **清理**：半成品迁入 `_archive/wip-phase0-*`，app 从 `_archive/opencodeui-baseline` 干净恢复

## 后果

- 分发桌面/前端源码需遵守 GPL
- Phase 3 起删除 `@opencode-ai/sdk` 生产依赖
- 不做 OpenCode API 兼容层
