# Pi ↔ UI 接入矩阵

原则：**有 OCUI 界面就接 Pi；没有 UI 的 Pi 能力暂不适配。**

| Pi 能力 | UI | 状态 | 备注 |
|---------|-----|------|------|
| prompt | InputBox | 已接 | |
| abort | 停止按钮 | 已接 | |
| 模型列表/选择 | ModelSelector | 已接 | setModel 命令 |
| 流式 timeline | ChatArea | 半接→完善中 | |
| thinking 内容 | Reasoning 展示 | 已接 | |
| thinking level | variant 菜单复用 | 接入中 | 无独立控件时用 variant |
| steer/followUp | 忙时再发 | 接入中 | 映射队列设置 |
| compact | `/compact` | 接入中 | |
| skills/commands | Slash/Skill 面板 | 接入中 | list only + prompt |
| session CRUD | 侧栏 | 已接 | 内存；持久化后补 |
| 文件/Git | FileExplorer | 已接 | |
| queue 展示 | 协议有 | 半接 | snapshot.queue |
| compaction/retry 状态 | 壳有 | 接入中 | snapshot.runtime |
| fork/undo | 有按钮 | 未接 | 下一批 |
| 会话树导航 | 无树 UI | **跳过** | |
| PTY 终端 | 有 | **暂跳过** | 下一批 |
| permission 同 OC | 有 | **跳过** | Pi 模型不同 |
| OAuth/配 key UI | 无 | **跳过** | 用 ~/.pi/agent |
| export html/jsonl | Share 壳 | **跳过** | |
| tools 白名单管理 | 无 | **跳过** | |
| extension TUI custom | 无 | **跳过** | |
