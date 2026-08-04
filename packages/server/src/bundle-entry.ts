/**
 * 单文件可执行的统一入口：bun build --compile 把 server 和 pi-worker 打进
 * 同一个 exe，运行时靠参数分流——server 拉起 worker 时以 --pi-worker 再
 * 起一个自己（见 worker-client.ts 的 PIUI_WORKER_SELF 分支）。
 */
const { dirname, join } = await import("node:path")
// 原生/运行时模块（node-pty、jiti）从 exe 旁的 node_modules 按绝对路径加载
process.env.PIUI_NATIVE_MODULES ??= join(dirname(process.execPath), "node_modules")

if (process.argv.includes("--pi-worker")) {
  await import("@piui/pi-worker/entry")
} else {
  // 编译形态没有独立 node 可 fork，worker 统一走自启动
  process.env.PIUI_WORKER_SELF = "1"
  await import("./index.ts")
}
