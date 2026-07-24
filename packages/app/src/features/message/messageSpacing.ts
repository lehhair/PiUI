/**
 * 消息折叠块纵向间距契约
 * - header: 可折叠 header 的垂直 padding
 * - item: 列表项之间只靠 top 间距（根节点不加 pb）
 * - body: header 下方展开内容
 * - stack: 消息内 parts 纵向 gap（0.5rem）
 * - finish: ToolGroup 内 tools → StepFinish（与 stack 等距，无 list gap 时用）
 * - processBody: 过程壳内多助手列表；gap 与 stack / 扁平连续助手 8px 同距
 * - toolBodyInset: compact/timeline 工具 body 左右缩进 + body 顶距
 * - inner: 工具 body 内权限/提问等子块
 *
 * 对齐关系：
 * - 扁平时间线连续助手：上下各 py-1 → 相邻合计 8px
 * - stack / processBody gap：gap-2 → 8px
 */
const STACK_GAP = 'gap-2'

export const MSG_SPACING = {
  header: 'py-1',
  item: 'pt-1',
  body: 'pt-1',
  stack: STACK_GAP,
  /** 与 stack 的 0.5rem 等距；ToolGroup 内无 list gap，用 top 补 */
  finish: 'pt-2',
  processBody: `flex flex-col ${STACK_GAP} pt-1`,
  toolBodyInset: 'pl-2 pr-2.5 pt-1',
  inner: 'pt-2',
} as const
