import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { RUNTIME_TARGETS } from "@piui/protocol"
import { assertRuntimeTargetBindings } from "./runtime-contract.ts"
import { verifySdkSessionContract } from "./runtime/real-session.ts"

describe("runtime contract binding gate", () => {
  it("binds every session command to a method both drivers implement", () => {
    // 用真实原型校验：缺实现会在这里直接炸（worker 启动时也会跑一次）。
    assert.doesNotThrow(() => assertRuntimeTargetBindings())
  })

  it("fails loud when a driver misses a targeted method", () => {
    const mock = Object.fromEntries(
      Object.values(RUNTIME_TARGETS).map(method => [method, () => undefined]),
    )
    assert.throws(
      () => assertRuntimeTargetBindings({ real: {}, mock }),
      /RealPiSession\.prompt/,
    )
  })
})

describe("SDK session contract gate", () => {
  function completeFakeRuntime(): Record<string, unknown> {
    const fn = () => undefined
    return {
      newSession: fn,
      switchSession: fn,
      fork: fn,
      importFromJsonl: fn,
      dispose: fn,
      setBeforeSessionInvalidate: fn,
      setRebindSession: fn,
      session: {
        subscribe: fn,
        bindExtensions: fn,
        waitForIdle: fn,
        prompt: fn,
        steer: fn,
        followUp: fn,
        sendUserMessage: fn,
        clearQueue: fn,
        abort: fn,
        setSessionName: fn,
        cycleModel: fn,
        setScopedModels: fn,
        setThinkingLevel: fn,
        cycleThinkingLevel: fn,
        setSteeringMode: fn,
        setFollowUpMode: fn,
        compact: fn,
        abortBranchSummary: fn,
        abortRetry: fn,
        setAutoCompactionEnabled: fn,
        setAutoRetryEnabled: fn,
        recordBashResult: fn,
        executeBash: fn,
        abortBash: fn,
        getAllTools: fn,
        setActiveToolsByName: fn,
        navigateTree: fn,
        sendCustomMessage: fn,
        exportToHtml: fn,
        exportToJsonl: fn,
        reload: fn,
        sessionManager: {
          getSessionId: fn, getSessionFile: fn, getCwd: fn, getEntries: fn, getTree: fn,
          getEntry: fn, getSessionName: fn, getSessionDir: fn, appendLabelChange: fn,
          appendCustomEntry: fn, getLeafId: fn,
        },
        resourceLoader: { getThemes: fn, getSkills: fn, getExtensions: fn },
      },
    }
  }

  it("accepts a complete SDK session surface", () => {
    assert.doesNotThrow(() => verifySdkSessionContract(completeFakeRuntime() as never, "test-complete"))
  })

  it("reports every missing session method with details", () => {
    const runtime = completeFakeRuntime() as { session: Record<string, unknown> }
    delete runtime.session.prompt
    delete runtime.session.navigateTree
    delete (runtime.session.sessionManager as Record<string, unknown>).getTree
    assert.throws(
      () => verifySdkSessionContract(runtime as never, "test-missing"),
      error => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes("session.prompt")
          && message.includes("session.navigateTree")
          && message.includes("sessionManager.getTree")
          && message.includes("test-missing")
      },
    )
  })
})
