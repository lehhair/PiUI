# ui-dialog-stress — 扩展弹窗压力测试

专为验证 PiUI 扩展 dialog（select / confirm / input / editor）的通用性而写。
生成各种极端内容：超长选项、超长标题、超长 message、数百行 prefill、混合类型排队，
覆盖截断、展开详情、内部滚动、队列分页等所有路径。

## 加载

```bash
# 方式一：复制到用户扩展目录
cp -r examples/ui-dialog-stress ~/.pi/agent/extensions/

# 方式二：直接加载（重启后失效）
pi -e ./examples/ui-dialog-stress
```

## 用法

| 命令 | 场景 |
| --- | --- |
| `/ui-dialog-stress` | 全部 6 个场景顺序弹出（上一个处理完才弹下一个） |
| `/ui-dialog-stress select` | 30+ 混合类型选项（超长中文 / 代码 / JSON / 无空格长串 / 终端输出 / 日志 / Markdown / emoji / 空白 / 多行） |
| `/ui-dialog-stress huge` | 3 个巨型选项（每个 4KB+） |
| `/ui-dialog-stress confirm` | 超长 title（2KB 工具输出）+ 超长 message 确认框 |
| `/ui-dialog-stress input` | 超长 placeholder 输入框 |
| `/ui-dialog-stress editor` | 220+ 行 prefill 编辑器 |
| `/ui-dialog-stress queue` | 5 个混合类型弹窗同时排队（验证分页器） |

## 验证要点

- 长选项摘要 2 行截断后出现展开按钮（chevron），展开显示完整内容、可滚动、可收起
- 展开状态下点击选项仍正常选中
- 超长标题内嵌 CodePreview（固定高度内部滚动）
- 卡片总高受限时内容区内部滚动，操作区（取消/提交/分页）始终可见
- 队列分页（上一/下一个）切换不丢失请求，处理完当前自动前移
