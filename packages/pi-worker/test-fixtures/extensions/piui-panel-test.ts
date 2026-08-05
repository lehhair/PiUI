import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setTitle("PiUI panel test")
    ctx.ui.setStatus("test:status", "extension loaded")
    ctx.ui.setStatus("test:time", new Date().toLocaleTimeString())
    ctx.ui.setWidget("demo-widget", [
      "static line",
      "todo item A",
      "completed item B",
    ])
    ctx.ui.setWorkingMessage("test extension working")
    setTimeout(() => ctx.ui.setWorkingMessage(undefined), 5000)
  })

  pi.registerCommand("ui-test-dialog", {
    description: "Test extension select, confirm, and input dialogs",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("Choose one", ["A", "B", "C"])
      if (!choice) return
      const ok = await ctx.ui.confirm("Confirm", `You chose ${choice}. Continue?`)
      if (!ok) return
      const text = await ctx.ui.input("Enter text", "placeholder")
      ctx.ui.setStatus("test:dialog", `choice=${choice} text=${text ?? "(empty)"}`)
      ctx.ui.setWidget("demo-widget", [`dialog result: ${choice} / ${text ?? "(empty)"}`])
    },
  })
}
