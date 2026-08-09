# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

发布流程：`node scripts/prepare-release.mjs <version>` 校验 + 升版本号 → 打 tag（`vX.Y.Z`）→ GitHub Actions 自动构建并发布。

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
