# Pi 0.81.1 Native Parity Matrix

本文是 PiUI 能力状态的权威清单，基线固定为 `@earendil-works/pi-coding-agent@0.81.1`

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
| list/listAll/create/open/resume | 部分 | R2：真实 SDK 恢复与崩溃测试 |
| 持久删除 JSONL | 缺失 | R3 |
| session name | 缺失 | R3 |
| entries/tree/leaf 读取 | 后端 | R3：类型化并进入 UI |
| navigateTree/label | 缺失 | R3 |
| fork/clone/import | 缺失 | R3 |
| branch summary 与取消 | 缺失 | R3/R4 |
| stats/context usage | 缺失 | R11 |
| HTML/JSONL export | 缺失 | R11 |
| share | 缺失 | R11 |

## Agent Control

| Pi 能力 | 当前状态 | 下一阶段 |
|---|---|---|
| text prompt/stream/abort | 部分 | R4：faux provider 与稳定 delta |
| steer/followUp | 部分 | R4：独立 control lane |
| queue 内容与模式 | 后端 | R4 |
| clear queue | 缺失 | R4 |
| model select | 部分 | R10：失败回滚与认证状态 |
| thinking level | 部分 | R10：cycle/scoped model |
| compact | 部分 | R4：instructions/result/abort |
| auto compaction/retry | 部分 | R4：配置与完整状态 |
| abort retry | 缺失 | R4 |
| user bash `!`/`!!` | 缺失 | R6 |
| active tools 查询/切换 | 缺失 | R4 |

## Multimodal And Tools

| Pi 能力 | 当前状态 | 下一阶段 |
|---|---|---|
| image/file/PDF prompt | 缺失 | R5 |
| text tool result | 部分 | R5 |
| tool execution updates | 缺失 | R5 |
| image/details/patch/cwd/exitCode | 缺失 | R5 |
| truncated/fullOutputPath | 缺失 | R5 |
| built-in read/bash/edit/write/grep/find/ls | 部分 | R5：逐工具 conformance |

## Extensions And Resources

| Pi 能力 | 当前状态 | 下一阶段 |
|---|---|---|
| Skills 元数据 | 部分 | R8：内容、来源与 reload |
| Prompt templates | 部分 | R7：改用真实 `getPrompts()` |
| Extension commands | 缺失 | R7 |
| Dynamic tools/providers | 部分 | R7/R10 |
| select/confirm/input/editor | 缺失 | R7 |
| notify/status/widget/title | 缺失 | R7 |
| custom entries/renderers | 缺失 | R7 |
| arbitrary TUI Component/header/footer | TUI-only | R7：稳定降级与原生入口 |
| AGENTS/CLAUDE context | 部分 | R8：来源与诊断 |
| resource reload/diagnostics | 缺失 | R8 |
| global/project settings | 缺失 | R8 |
| packages install/update/remove | 缺失 | R9 |
| Pi project trust | 缺失 | R9 |

## Providers And Auth

| Pi 能力 | 当前状态 | 下一阶段 |
|---|---|---|
| `~/.pi/agent` 模型与认证读取 | 部分 | R10 |
| provider auth status | 缺失 | R10 |
| API key/OAuth login/logout | 缺失 | R10 |
| catalog refresh | 缺失 | R10 |
| extension provider models | 缺失 | R10 |
| scoped models | 缺失 | R10 |
| llama.cpp 下载/加载/取消 | 缺失 | R10 |

## PiUI Host Capabilities

| 能力 | 当前状态 | 说明 |
|---|---|---|
| 文件读取、搜索、写入 API | 部分 | 写入 API 有实现，完整编辑工作流待验收 |
| Git status/diff | 部分 | 当前只有 Git/branch 范围 |
| PTY | 缺失 | Pi user bash 不能由 PTY 替代 |
| workspace access | 部分 | 需与 Pi project trust、执行批准分离 |
| WebSocket replay/resync | 部分 | v2 子协议、分作用域 cursor、局部 resync 已接；R2 补故障恢复与 faux-provider 验收 |

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
