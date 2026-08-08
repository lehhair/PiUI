# 运行时生命周期（预热 / 回收 / 切换）

PiUI server 为每个 Pi session 维护一个独立 worker 进程（fork 的编译产物）。
worker 冷启动耗时（spawn + SDK 加载 + 握手）是首次开会话的主要延迟来源，
本文说明预热、空闲回收、切换与新建的机制和调优参数。

## 机制总览

### 预热（Prewarm）

- **触发点**：
  1. server 启动时对默认工作目录预热（`http.ts`）
  2. 打开工作目录时预热该目录（`workspaces.open` → `sessions.prewarm`）
  3. 每次 warm runtime 被消费后立即补一个（`session-host.ts` openSession）
  4. 空闲回收后给原目录补一个（`session-host.ts` reapIdleRuntimes）
- **实现**：每工作目录一个 warm slot（`RuntimeSupervisor.warmSlots`），
  提前 open 一个空 Pi runtime，用户开会话时 `takeWarmRuntime` 直接领取，
  跳过冷启动。
- **TTL**：warm runtime 空置超过 `PIUI_WARM_RUNTIME_TTL_MS`（默认 5 分钟）
  自动 dispose，避免长时间占内存。

### 空闲回收（Idle Reap）

- `SessionHost` 每 30 秒扫描已 attach 的运行时，回收满足以下全部条件的：
  - 最后访问超过 `PIUI_SESSION_IDLE_TTL_MS`（默认 2 分钟）
  - 无进行中的 activity（无流式/重试）
  - 无排队中的命令
  - 非关闭中
- 回收后给该目录补 warm，用户切回时仍热启动。

### 切换（Session Switch）

- 同一工作目录内、source 空闲时：`switchSession` 复用当前 worker 换 identity
  （`switchAttachedSession`），无冷启动。
- 跨目录或 source 忙时：走 `openSession`（优先 warm，其次冷启动）。
- lease（`SessionLeaseManager`）保证同一 session 文件同一时刻只有一个
  worker 持有，避免双写。

### 新建（Create）

- `fork` / `clone` / `newSession` / `importSession` 由 SDK 在现有 worker 内
  完成 replacement，supervisor 在 `extensionReplacement.commit` 时转移 lease，
  无需新进程。
- 全新目录的第一个会话：优先取该目录 warm，其次冷启动。

## 调优参数

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PIUI_WARM_RUNTIME_TTL_MS` | 300000 | warm runtime 空置自动回收时间（最小 30s） |
| `PIUI_SESSION_IDLE_TTL_MS` | 120000 | 已 attach 会话空闲回收时间（最小 30s） |
| `PIUI_STANDBY_SIZE` | 0 | 常驻 standby worker 池大小（默认不预占；内存充裕时可设 1-2 换更快首开会话） |
| `PIUI_CATALOG_REQUEST_TIMEOUT_MS` | 30000 | catalog worker 请求超时（最小 5s） |
| `PIUI_WORKER_HANDSHAKE_TIMEOUT_MS` | 30000 | worker 握手超时（测试并行开多个 worker 时可调大） |

## 设计取舍

- **standbySize 默认 0**：每个 standby worker 是编译产物的一份完整副本，
  内存代价高；warm（按需 + TTL）在绝大多数场景已足够，且不常驻。
- **每目录单 warm slot**：一个 worker 持一个 session，同目录第二个会话
  无法复用第一个的 worker；warm 的定位是"用户回来时第一个会话秒开"。
- **消费即补**：warm 被领走（无论成败）立即补一个，形成自续链，
  高频开会话场景下每个会话都热启动。
