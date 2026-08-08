# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

发布流程：`node scripts/prepare-release.mjs <version>` 校验 + 升版本号 → 打 tag（`vX.Y.Z`）→ GitHub Actions 自动构建并发布。

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
