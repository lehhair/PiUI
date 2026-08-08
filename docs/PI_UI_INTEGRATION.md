# Pi 0.84.0 Native Parity Matrix

本文是 PiUI 能力状态的权威清单，基线固定为 `@earendil-works/pi-coding-agent@0.84.0`

支持等级：

- `完整`：SDK 能力、服务端协议、Web UI 和无网络测试均已完成
- `部分`：主路径可用，但原生语义、控制项或数据仍有缺失
- `后端`：worker/server 已有能力，前端尚未提供完整入口
- `缺失`：尚无可靠协议或实现
- `TUI-only`：无法在 Web 中等价承载，必须稳定降级或转到原生 Pi TUI

只有同时具备协议测试、真实 Pi SDK + faux provider 测试和 UI 测试，才能标记为 `完整`

## Session

| Pi 能力 | 当前状态 | 下一阶段 |
|---|---|---|
| list/listAll/create/open/resume | 完整 | R12：升级 conformance |
| 持久删除 JSONL | 完整 | R12：故障注入扩展 |
| session name | 完整 | R12：升级 conformance |
| entries/tree/leaf 读取 | 完整 | R12：大型 tree fixture |
| navigateTree/label | 完整 | R12：大型 tree fixture |
| fork/clone/import | 完整 | R12：更多故障注入 |
| branch summary 与取消 | 完整 | R12：升级 conformance |
| stats/context usage | 完整 | R12：升级 conformance |
| HTML/JSONL export | 完整 | R12：升级 conformance |

> share 不属于 Pi 能力矩阵：Pi SDK 未暴露任何 share 语义（命令表与 AgentSession 均无），PiUI 不消费也不展示入口。

## Agent Control

| Pi 能力 | 当前状态 | 下一阶段 |
|---|---|---|
| text prompt/stream/abort | 完整 | R12：故障注入扩展 |
| steer/followUp | 完整 | R12：升级 conformance |
| queue 内容与模式 | 完整 | R12：升级 conformance |
| clear queue | 完整 | R12：升级 conformance |
| model select | 完整 | R12：升级 conformance |
| thinking level | 完整 | R12：升级 conformance |
| compact | 完整 | R12：大型会话 fixture |
| auto compaction/retry | 完整 | R12：故障注入扩展 |
| abort retry | 完整 | R12：故障注入扩展 |
| user bash `!`/`!!` | 完整 | R12：升级 conformance |
| active tools 查询/切换 | 完整 | R7：dynamic tools 联动 |

## Multimodal And Tools

| Pi 能力 | 当前状态 | 下一阶段 |
|---|---|---|
| image prompt（图片附件） | 完整 | R5：file/PDF 附件明确不提取（路径交给 Pi） |
| file/PDF prompt | 缺失（明确不做提取） | — |
| text tool result | 完整 | R12：升级 conformance |
| tool execution updates | 完整 | R12：升级 conformance |
| image/details/patch/cwd/exitCode | 完整 | R12：升级 conformance |
| truncated/fullOutputPath | 完整 | R12：升级 conformance |
| built-in read/bash/edit/write/grep/find/ls | 完整 | R12：升级 conformance |

## Extensions And Resources

| Pi 能力 | 当前状态 | 下一阶段 |
|---|---|---|
| Skills 元数据 | 完整 | R12：升级 conformance |
| Prompt templates | 完整 | R12：升级 conformance |
| Extension commands | 完整 | R12：升级 conformance |
| Dynamic tools/providers | 完整 | R12：升级 conformance |
| select/confirm/input/editor | 完整 | R12：升级 conformance（真实 SDK 对话框 E2E 已加入） |
| notify/status/widget/title | 完整 | R12：升级 conformance（真实 SDK 状态事件 E2E 已加入） |
| custom entries/renderers | 部分 | R7：custom_message 已渲染，其余类型降级 |
| arbitrary TUI Component/header/footer | TUI-only | R7：稳定降级与原生入口 |
| AGENTS/CLAUDE context | 完整 | R12：升级 conformance |
| resource reload/diagnostics | 完整 | R12：升级 conformance（reload 命令 + PiResourceManagement + 测试） |
| global/project settings | 完整 | R12：升级 conformance |
| packages install/update/remove | 完整 | R12：升级 conformance |
| Pi project trust | 完整 | R12：升级 conformance |

## Providers And Auth

| Pi 能力 | 当前状态 | 下一阶段 |
|---|---|---|
| `~/.pi/agent` 模型与认证读取 | 部分 | R10 |
| provider auth status | 完整 | R12：升级 conformance |
| API key/OAuth login/logout | 完整 | R12：升级 conformance |
| catalog refresh | 完整 | R12：升级 conformance |
| extension provider models | 完整 | R12：升级 conformance |
| scoped models | 完整 | R12：升级 conformance |

> llama.cpp 本地模型下载/加载/取消不属于 Pi 能力矩阵：Pi 官方仍在规划
> （[#3107 `/local` 命令](https://github.com/earendil-works/pi/issues/3107)、[#3567 llama.cpp provider](https://github.com/earendil-works/pi/issues/3567)、
> [#3357 本地 LLM 扩展](https://github.com/earendil-works/pi/issues/3357)），SDK 未暴露任何 API，PiUI 不消费也不展示入口。

## PiUI Host Capabilities

| 能力 | 当前状态 | 说明 |
|---|---|---|
| 文件读取、搜索、写入 API | 完整 | R12：升级 conformance |
| Git status/diff | 完整 | R12：升级 conformance（git/staged/unstaged/branch 四种 mode） |
| PTY（宿主终端） | 完整 | R12：升级 conformance（terminals.* 命令 + ws e2e） |
| workspace access | 完整 | R12：升级 conformance |
| WebSocket replay/resync | 完整 | R12：完整故障注入矩阵 |

## Completion Gate

每个能力完成时必须同时满足：

1. Pi 0.81.1 来源 API 和语义已记录
2. Protocol 使用判别联合，不以 `unknown` 掩盖已知数据
3. worker 保持 session 单写并处理 replacement generation
4. server 返回明确 capability、错误和 command 状态
5. UI 没有假成功、静默空数组或点了才报错的入口
6. 默认测试不调用真实模型
7. 至少有一条真实 Pi SDK + faux provider 的无网络测试
8. Pi 升级时重新运行 API diff、fixture replay 和本矩阵 —— 由 `npm run conformance:sdk`（scripts/sdk-conformance.mjs）自动校验协议/依赖/安装三处版本一致并重跑协议与 worker 测试
9. worker 心跳看门狗、崩溃与协议不匹配路径由 worker-client 故障注入矩阵覆盖（packages/server/src/pi/worker-client.test.ts）
