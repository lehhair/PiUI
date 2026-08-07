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

  pi.registerCommand("ui-test-select-long", {
    description: "Test a long extension select dialog",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("Choose a deployment target", [
        "Production · North America · blue cluster",
        "Production · Europe · green cluster",
        "Staging · Integration · shared services",
        "Preview · Feature branch · temporary environment",
        "Local · Windows development workspace",
      ])
      ctx.ui.setStatus("test:select", choice ?? "cancelled")
    },
  })

  pi.registerCommand("ui-test-confirm-long", {
    description: "Test a long extension confirm dialog",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        "Apply workspace changes?",
        "This will update the generated files, remove stale artifacts, and restart the local service. The current session history will remain unchanged.",
      )
      ctx.ui.setStatus("test:confirm", confirmed ? "confirmed" : "cancelled")
    },
  })

  pi.registerCommand("ui-test-input", {
    description: "Test an extension single-line input",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input("Name this environment", "e.g. preview-windows-node22")
      ctx.ui.setStatus("test:input", value ?? "cancelled")
    },
  })

  pi.registerCommand("ui-test-editor", {
    description: "Test an extension multi-line editor",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.editor(
        "Edit release notes",
        "## Changes\n\n- Review the generated files\n- Confirm the deployment target\n- Add any rollback notes",
      )
      ctx.ui.setStatus("test:editor", value === undefined ? "cancelled" : `lines=${value.split("\n").length}`)
    },
  })

  pi.registerCommand("ui-test-dialog-queue", {
    description: "Queue several extension dialogs",
    handler: async (_args, ctx) => {
      await Promise.all([
        ctx.ui.confirm("First confirmation", "The first dialog in the queue."),
        ctx.ui.input("Second input", "The second dialog in the queue"),
        ctx.ui.select("Third selection", ["One", "Two", "Three"]),
      ])
      ctx.ui.setStatus("test:queue", "completed")
    },
  })
}
