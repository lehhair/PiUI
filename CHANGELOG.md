# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

发布流程：`node packages/app/scripts/prepare-release.mjs <version>` 校验 + 升版本号（root/workspaces/tauri/Cargo + CHANGELOG 生成）→ 打 tag（`vX.Y.Z`）→ GitHub Actions 自动构建并发布。

## [v0.6.6] - 2026-08-17

- fix: reclaim stale service process and decouple health from worker spawn (bd6a07a1)

## [v0.6.5] - 2026-08-17

- fix: remove ! prefix bash shortcut; use /bash slash command instead (1457adc4)

## [v0.6.4] - 2026-08-17

- chore(deps): bump @earendil-works/pi-* sdk to 0.84.2 (b314ab60)
- fix(markdown): robust math parsing and converge renderer rules (449ba05f)
- test(markdown): tolerate first-frame timing in the touch-controls assertion (ad2267fd)

## [v0.6.3] - 2026-08-12

- feat(session-tree): next/previous match navigation for search (fixes #1) (2f25e8c2)
- docs: fix the release workflow path in CHANGELOG (packages/app/scripts) (6ae5a499)

## [v0.6.1] - 2026-08-12

- fix(chat): keep the load-history spinner inline in the message flow (f590a246)
- fix(chat): make the load-history indicator always visible with a minimum duration (c726a211)
- ci: relax test-mock command timeout and validate job budget (3e9a841b)
- fix(release): restore package-lock versions corrupted by the 0.6.0 bump (d906f084)

## [v0.6.0] - 2026-08-12

- fix(dialog): compact single-line options via truncate instead of line-clamp (79774031)
- refactor(dialog): single-line option rows, CodePreview for expanded details (546a3ac4)
- feat(dialog): expandable long select options + stress-test extension (2c17292f)
- fix(chat): keep the arg completion selection visible while keyboard-navigating (ec74406c)
- fix(chat): slash command UX — drop duplicate invoke notice, fix arg completion (ca705659)
- fix(chat): stop stale extension editor mirror from clobbering composer text (ae2d9bd7)

## [v0.5.1] - 2026-08-12

- fix(chat): prevent stale virtual row visuals during stream resize (984f28c8)

## [v0.5.0] - 2026-08-11

- fix(chat): restore 8px visual gap around the collapsed capsule (17ee0abf)

## [v0.4.9] - 2026-08-11

- fix(chat): force real-DOM re-measure on row content change; rAF-defer ResizeObserver (988e9fbe)

## [v0.4.8] - 2026-08-11

- feat(chat): command argument completions via native getArgumentCompletions (Tab + auto-popup + live filter) (d0072e79)

## [v0.4.7] - 2026-08-11

- fix(chat): show the send button whenever the input has content, even while compacting (1a34455c)
- fix(mobile): keep the input box usable after select-all-delete with an IME (1ab11e85)
- fix(sidebar): materialize only when the session file exists; broadcast deletes (cf1e5893)
- fix(chat): clear the extension editor state on send so the input box stays cleared (a8d7a063)

## [v0.4.6] - 2026-08-10

- refactor(worker): one shared worker process for all Pi runtimes (0f538454)

## [v0.4.5] - 2026-08-10

- fix(sidebar): refresh the session list as an active session advances (089e4e18)
- fix(chat): recover provider auth flows and extension TUI panels after refresh (3e76077a)
- fix(chat): recover extension UI state (status/widget) after refresh (eccbe7f7)
- fix(chat): recover extension dialogs after page refresh (11e44ef9)
- refactor: dispatch pi commands concurrently like the native SDK (2942a75b)

## [v0.4.4] - 2026-08-10

- style(chat): narrow collapsed dialog capsule to 240px (5869798b)
- fix(chat): send button returns when user types while session is active (cfcec447)
- feat(chat): rework extension dialog card UI (944bd779)

## [v0.4.3] - 2026-08-10

- fix(chat): register pane controller so global shortcuts work again (5538af23)
- fix(runtime): session management commands (rename/model) bypass the busy lane (ccc0ee91)
- feat(chat): input send button stays Stop while session is in active list (dbc89287)
- fix(chat): unify queue action icon sizes with user-message action bar (72de9cfe)
- fix(chat): clearPiQueue returns the cleared snapshot so queue-item ops can replay the rest (5f5389c5)
- fix(chat): queue action buttons below the bubble, matching user-message layout (80ca2616)
- feat(chat): queue bubbles use user-message action-bar layout with clear/move/edit (e615df83)
- feat(chat): queue messages support undo-to-input and switch steer/followUp mode (c93b6a90)
- fix(chat): useChatViewportSelect reads nearest provider, not shared global snapshot (1e862d2d)
- fix(chat): dialog header style unified across floating host and sidebar inline (3ad826bb)
- fix(chat): dialog header groups title+collapse in one block; select check uses accent-secondary (3662aab2)
- fix(chat): align extension dialog width with composer on compact layout (32290c77)
- feat(chat): extension dialogs collapse into pill above the composer (4d3c01cf)
- fix(outline): highlight section from scroll position + previous user message (8175a7a6)
- fix(chat): keep shouldRender state true after expand so collapse delays unmount (24e24cf4)
- fix(chat): ProcessCollapseBlock collapse should animate, matching expand feel (f938c3ab)
- feat(chat): stream with natural layout, drop SmoothHeight activation chain (9537d787)
- revert(chat): restore original SmoothHeight streaming height animation (d40ff618)
- fix(tools): show tool call substance in header instead of duplicating the name (94392163)
- feat(runtime): reuse idle workers on session switch, single warm slot, reap double-check (673cfa9c)
- fix(chat): cut transition lag once growth becomes continuous (9a566581)
- fix(chat): keep smooth transitions for block-level growth, instant for token-level (0393cdd2)
- fix(chat): stop SmoothHeight transition lag during streaming growth (1244629b)
- refactor(sidebar): move workspace filtering to display layer, shrink SessionContext (d1ad83a6)
- refactor(sidebar): active sessions resolve globally, drop workspace-scoped workarounds (0daa07c5)
- perf(sidebar): coalesce session-list refreshes to stop request storms (3448c660)
- fix(events): pull runtime state on subscribe/resync so active sessions survive refresh (b79ea773)
- fix(sidebar): active sessions from other workspaces stay clickable (c7055da3)
- fix(changes): kill diff refresh storm while agent is writing (bfe49607)
- chore(app): resolve all eslint errors and warnings (103 → 0) (4d28d130)

## [v0.4.2] - 2026-08-09

- feat(chat): restore streaming height-grow animation for the live row (d655203f)
- perf(chat): skip deep serialization in live-message persistence match (39c83148)
- perf(chat): drop streaming shimmer and render markdown directly (reference align) (5b45fb8c)
- perf(chat): selector-subscribe viewport so width changes skip React re-render (9ea25380)
- perf(chat): cache tool-merge results so history rows hold memo identity (31d1cf11)
- perf(chat): keep ChatArea and row props reference-stable during streaming (de057959)
- perf(chat): rebuild timeline selection with stable history and per-chunk live item (61097535)
- fix(dev): listen on IPv4+IPv6 so browser WS to localhost connects (fd5256e6)
- perf(chat): add ?piuiPerf=1 instrumentation for streaming render stages (94d9d580)

## [v0.4.1] - 2026-08-09

- fix(ui): drop the orphan dot in the input footer and honor hidden models in the selector (6842904b)

## [v0.4.0] - 2026-08-09

- fix(desktop): strip the system title bar on Windows without decorum button injection (76cb2129)
- fix(desktop): replace decorum-injected window controls with React buttons (20b3ff5f)
- fix(desktop): run open_new_window on the async runtime to stop the UI freeze (b6447b6b)
- style(ui): align the sidebar logo center with the nav button icons (982fbf69)
- chore(sdk): upgrade the bundled Pi SDK to 0.84.1 (a154628e)
- fix(icons): shrink the Android adaptive foreground so the mark survives circular masking (1d217f3b)
- style(ui): shrink the header Pi mark to match the glyph's visual weight (f21d384d)
- feat(ui): replace the header pi-glyph with the official Pi mark (85d496bf)
- chore(icons): use the official Pi logo as the app icon (c8c846ce)
- style(compact): compacting indicator matches the 'history compressed' divider (208893c1)
- fix(compact): drive the compacting row/button from the activity push, not state polling (534d1897)
- feat(compact): in-flow compacting row + send button turns into a stop button (1b686bbe)
- fix(compact): show compaction in the chat flow and mark the session working (104100cb)
- feat(compact): show a compacting banner with cancel, and stop the 30s false timeout (0160eef3)
- fix(commands): /tree jumps to the session tree tab instead of toggling the panel (f28ca0bd)
- feat(extension): auto-open extension panel on command + clear feedback log (e9c3beb1)
- fix(outline): keep highlight on the current section and make clicks work while streaming (0ff6c040)
- fix(branch): keep pagination cursors valid across worker restarts (992ecd20)
- fix(extension): surface ctx.ui.notify output in the command feedback log (e8de8b03)
- fix(commands): execute extension commands, log feedback, and filter the slash menu (90034b8b)
- feat(extension): mirror the Pi TUI into the sidebar extension panel (77cf60aa)
- fix(files): stop directory browsing from freezing the server (35265f2c)
- fix(markdown): keep single-tilde ranges literal and render \(...\)/\[...\] math (52a28e93)

## [v0.3.0] - 2026-08-08

- feat: pi TUI parity for slash commands and user bash execution (7bbd9df5)

## [Unreleased]

## [v0.2.0] - 2026-08-08

### Added

- Tauri 客户端壳对齐 OpenCodeUI：窗口状态保存/恢复、single-instance + CLI 目录打开、
  macOS 拖放/Opened 事件、WS 桥按窗口隔离与清理、`get_dropped_paths_info`/`get_cli_directory` 命令
- Android 工程（沉浸式系统栏、`__piui_android` 原生桥、震动反馈）
- SDK 升级门禁 `npm run conformance:sdk` 与 worker 故障注入矩阵
- 原生能力补齐：prompt 模板、AGENTS/CLAUDE 上下文、Skills 元数据、scoped models 全链路、
  对话框与状态事件真实 SDK E2E、HTML/JSONL export、stats/context usage
- GitHub Actions：iOS 构建、tauri-check 门禁、Rust/Gradle 缓存、tag 驱动的发布正文
- 运行时生命周期优化：打开目录即预热、warm 消费即补、空闲回收后补预热；
  调优参数文档（docs/RUNTIME_LIFECYCLE.md）与 standby 池 opt-in

### Changed

- 能力矩阵（docs/PI_UI_INTEGRATION.md）逐项对照真实代码修正
- npm 脚本完善：Tauri/移动端透传、format、check、test:pi 挂到根工作区

## [v0.1.0] - 2026-08-06

### Added

- 首个 PiUI 版本：Pi 原生客户端（protocol / pi-worker / server / app 四包 monorepo）
