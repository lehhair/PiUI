# ADR-0002 Pi 原生客户端边界

状态：已接受

## 决定

PiUI 是 Pi coding agent 的原生客户端，不是通用 Agent 平台，也不实现 OpenCode API 兼容层。

- OpenCodeUI 只提供 React 视觉与交互资产
- 生产 runtime 直接使用 `@earendil-works/pi-coding-agent` SDK
- 每个活跃可写会话最终运行在独立 worker 子进程
- Pi `SessionManager` 的 session ID 是 PiUI 对外会话 ID
- Pi JSONL 是消息、tree、leaf、模型、thinking、compaction 和 session name 的唯一历史来源
- server 通过 `SessionManager.list/listAll` 发现会话，通过服务端解析出的路径打开 JSONL
- 浏览器 API 不接受任意 `sessionFile` 绝对路径
- SQLite 只保存 workspace trust、常用目录、布局、草稿和归档等 UI 元数据
- mock 是无模型测试替身，不是产品级 driver
- Pi CLI RPC 只作为命令、事件和 extension UI 行为参考，生产路径使用 SDK

## 影响

- 删除独立的 PiUI session ID 与 `driverSessionId` 双重身份
- 不把 timeline、projection 或消息正文写入 PiUI catalog
- 不为第二个 driver 扩展产品协议
- 前端状态按 Pi session ID 隔离
- OpenCode 数据调用逐步替换后删除，不维持兼容行为
