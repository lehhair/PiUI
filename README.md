# PiUI

PiUI 是 Pi 原生 coding agent 的 Web/桌面客户端。界面、session 浏览和扩展 UI 由 PiUI 提供，agent 执行由 Pi SDK 提供。

## 要求

- Node.js `>= 22.19.0`
- npm
- 已安装并可访问的 Pi SDK，或使用 PiUI 随附的 SDK
- 对话需要配置 Pi 的 provider 凭据；测试和类型检查默认不会调用真实 LLM

## 快速开始

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动：

- PiUI server：`http://127.0.0.1:8787`
- Vite app：通常是 `http://127.0.0.1:5173`

如果 `5173` 已被占用，Vite 会自动使用下一个端口。开发时应该打开终端中 Vite 打印的地址，这样才能使用 HMR；`8787` 是后端服务和静态 fallback 地址。

只启动后端或前端：

```bash
npm run dev:server:pi
npm run dev:app
```

## 纯终端运行

只启动 PiUI server，不启动浏览器前端：

```bash
npm run dev:server:pi
```

开发 server 使用 `tsx --watch`，适合修改 server/worker 代码时使用。生产构建：

```bash
npm run build
npm start -w @piui/server
```

也可以直接使用 server CLI：

```bash
npm run pi-worker -- web --host 127.0.0.1 --port 8787
npm run pi-worker -- web --host 127.0.0.1 --port 8787 --api-only
```

`--api-only` 不托管前端静态文件，只提供 API 和 WebSocket 服务。

查看 CLI 参数：

```bash
npm run pi-worker -- web --help
```

## 监听地址和远程访问

默认只监听本机：

```text
PIUI_HOST=127.0.0.1
PIUI_PORT=8787
```

局域网访问可以绑定所有 IPv4 网卡：

```bash
PIUI_HOST=0.0.0.0 PIUI_PORT=8787 npm run pi-worker -- web
```

PowerShell：

```powershell
$env:PIUI_HOST = "0.0.0.0"
$env:PIUI_PORT = "8787"
npm run pi-worker -- web
```

启动后 server 会打印局域网访问地址。也可以在 PiUI 的“设置 → 服务 → 网络监听”中修改监听地址和端口，重启服务后生效。

监听地址选项：

- `127.0.0.1`：仅本机，默认且最安全
- `0.0.0.0`：所有 IPv4 网卡，适合局域网访问
- `::`：IPv6 所有接口，具体双栈行为取决于操作系统

绑定到 `0.0.0.0` 或 `::` 不等于自动拥有公网访问能力。公网访问还需要路由器端口转发、防火墙规则和公网地址。不要把 PiUI 直接裸露到公网，建议使用 VPN、SSH 隧道或带 TLS 和访问控制的反向代理。

PiUI API 使用本地 auth token。token 默认位于：

```text
~/.piui/auth-token
```

远程访问时必须保护这个 token，并确认访问者可信。拿到 token 的客户端可以调用 API、创建终端和操作 agent。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PIUI_HOST` | `127.0.0.1` | server 监听地址 |
| `PIUI_PORT` | `8787` | server 监听端口 |
| `PIUI_AUTH_TOKEN` | 自动生成 | 显式指定 API token |
| `PIUI_DATA_DIR` | `~/.piui` | PiUI 数据目录 |
| `PIUI_WEB_ROOT` | 自动查找 | 指定前端静态文件目录 |
| `PIUI_DRIVER` | `pi` | 使用 `mock` 可运行无 LLM 的测试 server |
| `PIUI_SDK_PATH` | 空 | 指定 Pi SDK 路径 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent 配置目录 |
| `PI_CODING_AGENT_SESSION_DIR` | 自动 | Pi session 文件目录 |

设置示例：

```bash
PIUI_HOST=0.0.0.0 \
PIUI_PORT=9000 \
PIUI_DATA_DIR=/var/lib/piui \
npm run pi-worker -- web --api-only
```

## 服务设置

桌面端可以在“设置 → 服务”中管理：

- 网络监听地址
- 网络监听端口
- 自动启动
- Pi SDK 来源
- 终端 Shell
- 额外环境变量
- 服务启动、停止和重启

监听配置和环境变量保存到本地服务设置中。修改监听地址或端口后需要重启 server；已运行的外部 server 不会被浏览器强行修改。

## 架构概览

PiUI 将 session 浏览和 agent 执行分开：

```text
session.preview
  -> Pi SDK SessionManager.open()
  -> 读取 session header/branch/entries
  -> 不创建 Agent runtime

发送消息或执行命令
  -> sessionId
  -> server ensureAttached(sessionId)
  -> AgentSessionRuntime
  -> Pi SDK prompt/steer/followUp
```

因此切换历史 session 不需要启动新的 Pi runtime。只有真正执行消息、工具或扩展命令时，server 才会为对应 session 准备 runtime。

## 开发和验证

```bash
npm run typecheck
npm test
npm run build
```

只运行 app 测试：

```bash
npm run test:run -w @piui/app
```

只运行 server 测试：

```bash
npm test -w @piui/server
```

安装测试扩展：

```bash
npm run install:test-extension
```

## 相关目录

- `packages/app`：React Web/桌面客户端
- `packages/server`：HTTP、WebSocket、session host、PTY 和静态托管
- `packages/pi-worker`：Pi SDK worker 和 runtime adapter
- `packages/protocol`：前后端协议与命令定义
- `scripts`：开发、构建和测试辅助脚本
- `docs`：设计和开发文档

## 许可证

UI 基线为 GPL-3.0。协议、server 和其他包的许可证以对应目录声明为准。
