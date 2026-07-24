# PiUI

Pi coding agent 客户端：界面与 OpenCodeUI 同观感，引擎为 Pi 原生 runtime。

- 设计：`docs/universal-agent-pi-technical-design.md`
- 开发节奏：`DEVELOPMENT.md`
- 许可证：UI 基线 GPL-3.0；协议与 server 见各包

```bash
npm install
npm run test:phase0
npm run dev:server
npm run dev:app
```

**注意**：开发与 CI 默认不调用真实 LLM。需要对话时再在本机配置 Pi 凭据。
