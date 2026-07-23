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

# UI（Mock Host）
npm run dev:app

# 真实 Host（stdio JSONL）
npm run dev:host
```

Host 试跑示例（另一终端）：

```bash
# 先启动 host，再往 stdin 打 JSON 行
echo '{"type":"ping"}' | npm run start -w @piui/host
```

## 阶段

见 `DEVELOPMENT.md`。Phase 1：Host SDK 闭环 + 桌面接真 Host + 文件树/预览。
