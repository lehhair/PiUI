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
| stats/context usage | 缺失 | R11 |
| HTML/JSONL export | 缺失 | R11 |
| share | 缺失 | R11 |

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
| Skills 元数据 | 部分 | R8：内容、来源与 reload |
| Prompt templates | 部分 | R7：改用真实 `getPrompts()` |
| Extension commands | 完整 | R12：升级 conformance |
| Dynamic tools/providers | 部分 | R7/R10 |
| select/confirm/input/editor | 部分 | R7：真实 SDK 对话框 E2E |
| notify/status/widget/title | 部分 | R7：真实 SDK 状态事件 E2E |
| custom entries/renderers | 部分 | R7：custom_message 已渲染，其余类型降级 |
| arbitrary TUI Component/header/footer | TUI-only | R7：稳定降级与原生入口 |
| AGENTS/CLAUDE context | 部分 | R8：来源与诊断 |
| resource reload/diagnostics | 缺失 | R8 |
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
| llama.cpp 下载/加载/取消 | TUI-only | Pi SDK 的 ModelRuntime 未暴露本地模型下载 API，Web 无法等价承载 |

## PiUI Host Capabilities

| 能力 | 当前状态 | 说明 |
|---|---|---|
| 文件读取、搜索、写入 API | 部分 | 写入 API 有实现，完整编辑工作流待验收 |
| Git status/diff | 部分 | 当前只有 Git/branch 范围 |
| PTY | 缺失 | Pi user bash 不能由 PTY 替代 |
| workspace access | 部分 | 需与 Pi project trust、执行批准分离 |
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
8. Pi 升级时重新运行 API diff、fixture replay 和本矩阵
