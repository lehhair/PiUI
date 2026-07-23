# PiUI

Pi 桌面客户端骨架：薄 UI + Node Host + 自有 protocol。

OpenCodeUI 基线已归档到 `_archive/opencodeui-baseline/`（UI 壳/美术从那里搬）。

## 结构

```text
packages/
  protocol/   # UI <-> Host 类型与 protocolVersion
  host/       # Node Host，嵌入 pi-coding-agent SDK
  app/        # React UI（当前 Mock Host，可独立 dev）
DEVELOPMENT.md
_archive/opencodeui-baseline/
```

## 开发

Host 用 npm 上的 `@earendil-works/pi-coding-agent`，**不用**编译本地 pi monorepo。

```bash
# 代理（非大陆网络，按需）
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890

cd E:/dev/re_agent_UI/PiUI
npm install

# 终端 1：真 Host（默认 ws://127.0.0.1:8787）
npm run dev:host

# 终端 2：浏览器 UI
npm run dev:app
```

浏览器顶部选「真 Host (WS)」，填本机项目路径后打开即可。  
Mock 模式可不启 Host。stdio：`npm run start -w @piui/host -- --stdio`

## 阶段

见 `DEVELOPMENT.md`。Phase 1：Host SDK 闭环 + 桌面接真 Host + 文件树/预览。
