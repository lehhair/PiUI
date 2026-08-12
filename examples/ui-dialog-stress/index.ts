/**
 * ui-dialog-stress — extension dialog 压力/边界测试扩展（PiUI）
 *
 * 专为验证 PiUI 扩展 dialog（select/confirm/input/editor）的通用性而写：
 * 生成各种极端内容——超长选项、超长标题、超长 message、数百行 prefill、
 * 混合类型排队等，覆盖截断/展开/滚动/队列分页等所有路径。
 *
 * 加载方式（任选其一）：
 *   - 复制本目录到 ~/.pi/agent/extensions/ui-dialog-stress
 *   - 或 `pi -e ./examples/ui-dialog-stress`
 *
 * 用法：
 *   /ui-dialog-stress            全部场景按顺序弹出（不等待，直接排队）
 *   /ui-dialog-stress select     超长选项单选（30+ 混合类型选项）
 *   /ui-dialog-stress huge       少量但超大的选项（每个 4KB+）
 *   /ui-dialog-stress confirm    超长 message + 超长 title 确认框
 *   /ui-dialog-stress input      长 placeholder / prefill 输入框
 *   /ui-dialog-stress editor     数百行 prefill 编辑器
 *   /ui-dialog-stress queue      5 个混合类型弹窗同时排队
 *
 * @module ui-dialog-stress
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

// ============================================
// 极端内容生成
// ============================================

const SHORT_OPTIONS = ["plan", "build", "review", "fix", "docs", "test", "refactor", "debug"]

/** 超长中文（带标点、换行） */
const LONG_CHINESE = [
  "这是一个用来验证扩展弹窗对超长中文文本处理能力的选项。",
  "它包含多个完整句子，并且在自然断句的位置换行，模拟真实用户写入的长描述。",
  "重点要检查的是：两行摘要截断后是否提供了展开入口，展开后的完整内容是否可以滚动阅读，以及展开状态下选择该选项是否仍然正常工作。",
  "同时还要验证：当选项文本里混入英文、数字、代码片段和标点符号时，换行与折行是否都正确，长单词（URL、路径）是否会溢出卡片边界。",
  "最后，这条文本的长度应当足够触发 line-clamp 的截断逻辑，否则展开按钮不会出现，测试就失去了意义。",
  "所以这里再补充几句没有实际含义的填充文字，让总长度稳定超过摘要区域能显示的两行。",
  "填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充。",
].join("\n")

/** 代码块选项 */
const CODE_OPTION = `export function resolvePreset(runtime: PermissionRuntime): string {
  const sandbox = effectiveMode(runtime)
  const approval = effectiveApproval(runtime)
  const matches = (spec: PresetSpec): boolean =>
    spec.sandbox === sandbox && spec.approval === approval
  const selected = runtime.state.preset
  if (selected !== undefined && selected !== CUSTOM_PRESET) {
    const spec = runtime.config.presets[selected]
    if (spec !== undefined && matches(spec)) return selected
  }
  for (const [name, spec] of Object.entries(runtime.config.presets)) {
    if (matches(spec)) return name
  }
  return CUSTOM_PRESET
}

// 上面这段代码故意包含长函数、注释和空行，
// 用来验证代码型选项在摘要截断与展开视图下的可读性。
export const DANGER = "danger-full-access"`

/** 格式化 JSON 选项（约 90 行） */
function jsonOption(): string {
  const nodes: Record<string, unknown> = {}
  for (let i = 0; i < 60; i++) {
    nodes[`node-${i}`] = {
      id: `019f${i.toString(16).padStart(24, "0")}`,
      name: `component-${i}`,
      enabled: i % 3 !== 0,
      timeout: 30_000 + i * 1_000,
      tags: ["a", "b", "c"].map(tag => `${tag}-${i}`),
      nested: { level: i, path: `/workspace/packages/pkg-${i}/src/index.ts` },
    }
  }
  return JSON.stringify({ schemaVersion: 1, updatedAt: "2026-08-12T11:30:00.000Z", nodes }, null, 2)
}

/** 超长单行（无空格，测试强制折行） */
const NO_SPACE_LINE =
  "https://example.com/api/v2/projects/very-long-name/artifacts/" +
  "release-candidate-2026.08.12-rc4/digests/sha256:" +
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

/** 终端输出风格选项 */
const TERMINAL_OUTPUT = [
  "$ npm run build --workspace @piui/app",
  "",
  "> @piui/app@0.6.34 build",
  "> vite build",
  "",
  "vite v7.1.0 building for production...",
  "transforming...",
  "✓ 1,284 modules transformed.",
  "dist/index.html                   0.46 kB │ gzip:  0.30 kB",
  "dist/assets/index-9f3c2d1e.js  1,024.12 kB │ gzip: 324.15 kB",
  "dist/assets/vendor-7a1b2c3d.js  512.44 kB │ gzip: 152.08 kB",
  "✓ built in 3.42s",
  "",
  "Done in 3.42s.",
  "",
  "warning: 2 legacy chunks remain — run 'vite build --force' to verify",
].join("\n")

/** 日志片段选项 */
const LOG_OPTION = Array.from({ length: 40 }, (_, i) => {
  const level = i % 5 === 0 ? "ERROR" : i % 3 === 0 ? "WARN " : "INFO "
  return `${String(2026 - 8).padStart(4, "0")}-08-12T11:${String(30 + (i % 20)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i * 37 % 1000).padStart(3, "0")}Z ${level} [worker:${i % 4}] handler=extension-ui-bridge event=state patch=status key=pi-permission\n  ${level === "ERROR" ? "at ExtensionUiBridge.applyStatePatch (extension-ui-bridge.ts:187)" : `message=mirror replay ${i} frames=${i % 3 === 0 ? "3" : "1"}`}`
}).join("\n")

/** Markdown 表格选项 */
const MARKDOWN_OPTION = [
  "| 预设 | 沙箱模式 | 审批策略 | 说明 |",
  "| --- | --- | --- | --- |",
  "| read-only | 只读 | ask | 禁止一切写入，适合审查代码 |",
  "| workspace-write | 工作区可写 | ask | 允许修改当前工作区文件，写前询问 |",
  "| danger-full-access | 完全访问 | auto | 无限制执行，谨慎使用 |",
  "",
  "> 切换预设会影响当前会话的所有工具调用权限。",
  "> 详细策略见 ~/.pi/agent/extensions/permission/DESIGN.md",
].join("\n")

/** 4KB+ 的巨型选项（重复拼接） */
function hugeOption(seed: string, lines: number): string {
  return Array.from({ length: lines }, (_, i) => `${seed} #${i} ${LONG_CHINESE.split("\n")[0]}`).join("\n")
}

/** 超长标题（模拟工具输出塞进 title 的场景） */
function hugeTitle(): string {
  return [
    "bash execution result (truncated to fit the title line)",
    "$ git status --porcelain --branch",
    "## dev...origin/dev",
    " M packages/app/src/features/chat/InputBox.tsx",
    " M packages/app/src/features/chat/ExtensionUiDialogCard.tsx",
    "?? examples/ui-dialog-stress/index.ts",
    "",
    "exit code 0 · 8ms",
  ].join("\n").repeat(12)
}

/** confirm 的超长 message（模拟一次工具调用的完整输出） */
function longConfirmMessage(): string {
  return [
    "即将执行以下操作，请确认：",
    "",
    "1. 删除 dist/ 目录下的 3 个旧构建产物（总计 128.4 MB）",
    "2. 用新的构建产物替换（总计 96.2 MB，gzip 后 32.1 MB）",
    "3. 更新 manifest.json 中的版本号 0.6.34 → 0.6.35",
    "",
    "本次操作的完整清单：",
    ...Array.from({ length: 25 }, (_, i) => `   - ${["dist/assets/index.js", "dist/assets/vendor.js", "dist/manifest.json", "dist/service-worker.js", "dist/index.html"][i % 5]} (${(i * 37) % 1024 + 128} KB)`),
    "",
    "如果选择取消，本次变更不会写入磁盘；",
    "如果确认，将在 3 秒内开始执行，且不可撤销。",
  ].join("\n")
}

/** editor 的数百行 prefill */
function editorPrefill(): string {
  const header = [
    "/**",
    " * generated release notes — do not edit by hand",
    " * source: scripts/generate-release-notes.ts",
    " */",
    "",
    "## 0.6.35 (2026-08-12)",
    "",
  ]
  const body = Array.from({ length: 220 }, (_, i) => {
    if (i % 17 === 0) return ""
    if (i % 11 === 0) return `### ${["修复", "特性", "性能", "重构"][i % 4]}`
    return `- ${["修复扩展弹窗在超长内容下的滚动", "优化参数补全的 IME 兼容", "移除重复的 Invoking 通知", "补充 dialog 压力测试用例"][i % 4]}（#${100 + i}）`
  })
  return [...header, ...body].join("\n")
}

// ============================================
// 场景实现
// ============================================

async function runSelect(ctx: ExtensionCommandContext): Promise<void> {
  const options = [
    ...SHORT_OPTIONS,
    LONG_CHINESE,
    CODE_OPTION,
    jsonOption(),
    NO_SPACE_LINE,
    TERMINAL_OUTPUT,
    LOG_OPTION,
    MARKDOWN_OPTION,
    "选项带前后空白：   前后都有多余空格，选中后应原样提交    ",
    "多行选项：\n第一行\n第二行\n第三行（缩进）\n  第四行带缩进",
    "emoji 混合：✅ 支持  🚀 火箭  📦 打包  🐛 修复  ⚡ 性能  🧹 清理",
    "空行选项：\n\n\n只有空行，选中后提交空字符串",
    ...Array.from({ length: 8 }, (_, i) => `mixed-${i}: 短前缀 + 一段 ${i % 2 === 0 ? "中文" : "english"} 描述文字，长度不一，用来测试列表在中等长度下的表现 ${"x".repeat(i * 20)}`),
  ]
  await ctx.ui.select("请选择一个处理方案（30+ 混合类型选项）", options, { timeout: 60_000 })
}

async function runHuge(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.select("巨型选项（每个 4KB+）", [
    hugeOption("workspace-write", 60),
    hugeOption("danger-full-access", 60),
    hugeOption("read-only 只读模式详细说明", 60),
  ], { timeout: 60_000 })
}

async function runConfirm(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.confirm(
    hugeTitle().slice(0, 2000),
    longConfirmMessage(),
    { timeout: 60_000 },
  )
}

async function runInput(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.input(
    "请输入环境名称（placeholder 也很长）",
    "production-eu-west-1 / staging-us-east-1 / preview-2026-08-12 —— 只能包含小写字母、数字和连字符，最长 32 个字符，且不能以连字符开头或结尾",
    { timeout: 60_000 },
  )
}

async function runEditor(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.editor("编辑发布说明（220+ 行 prefill）", editorPrefill())
}

async function runQueue(ctx: ExtensionCommandContext): Promise<void> {
  // 不 await：5 个弹窗同时挂起，验证前端排队/分页
  const ui = ctx.ui
  void ui.select("队列 1/5 —— 短选项选择", ["a", "b", "c"], { timeout: 120_000 })
  void ui.confirm("队列 2/5 —— 确认操作", "这是一个确认框，排在第二个。", { timeout: 120_000 })
  void ui.input("队列 3/5 —— 输入环境名", "staging", { timeout: 120_000 })
  void ui.select("队列 4/5 —— 长选项", [LONG_CHINESE, MARKDOWN_OPTION, TERMINAL_OUTPUT], { timeout: 120_000 })
  void ui.editor("队列 5/5 —— 编辑配置", "key = \"value\"\n# 修改后保存\n")
}

// ============================================
// 命令注册
// ============================================

const SCENARIOS = ["select", "huge", "confirm", "input", "editor", "queue"] as const
type Scenario = (typeof SCENARIOS)[number]

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("ui-dialog-stress", {
    description: "扩展弹窗压力/边界测试（超长选项/标题/队列等极端场景）",
    getArgumentCompletions: (prefix: string) => {
      const items = SCENARIOS.map(scenario => ({ value: scenario, label: scenario }))
      const filtered = items.filter(item => item.value.startsWith(prefix))
      return filtered.length > 0 ? filtered : null
    },
    handler: async (args, ctx) => {
      const name = (args.trim().split(/\s+/)[0] ?? "") as Scenario | ""
      const runners: Record<Scenario, () => Promise<void>> = {
        select: () => runSelect(ctx),
        huge: () => runHuge(ctx),
        confirm: () => runConfirm(ctx),
        input: () => runInput(ctx),
        editor: () => runEditor(ctx),
        queue: () => runQueue(ctx),
      }
      if (name && name in runners) {
        await runners[name as Scenario]()
        return
      }
      // 无参数：全部场景顺序弹出（上一个处理完才弹下一个，验证长队列）
      ctx.ui.notify(
        `ui-dialog-stress: 将依次弹出 ${SCENARIOS.length} 个极端场景弹窗\n可用子命令: ${SCENARIOS.join(" / ")}`,
        "info",
      )
      for (const scenario of SCENARIOS) {
        await runners[scenario]()
      }
    },
  })
}
