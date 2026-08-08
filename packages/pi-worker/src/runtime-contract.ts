import { RUNTIME_TARGETS, assertSessionCommandsTargeted } from "@piui/protocol"
import { RealPiSession } from "./runtime/real-session.js"
import { MockPiSession } from "./runtime/mock-session.js"

export interface RuntimeTargetImplementations {
  real: object
  mock: object
}

/**
 * 会话命令 → 驱动方法的绑定门禁：PI_COMMAND_SPECS 里每条 session 命令都必须
 * 有 runtime target（assertSessionCommandsTargeted），且该 target 指向的方法
 * 必须被 RealPiSession 与 MockPiSession 都实现。任何一边缺失都启动即炸——
 * 这是"命令镜像不允许静默漂移"的机器保证，Pi SDK 或 PiUI 驱动改接口时
 * 在这里失败，而不是在用户会话里失败。
 */
export function assertRuntimeTargetBindings(impls: RuntimeTargetImplementations = {
  real: RealPiSession.prototype,
  mock: MockPiSession.prototype,
}): void {
  const missingTargets = assertSessionCommandsTargeted()
  if (missingTargets.length > 0) {
    throw Object.assign(
      new Error(`session commands without a runtime target:\n- ${missingTargets.join("\n- ")}`),
      { code: "PI_SDK_INCOMPATIBLE" },
    )
  }
  const missing: string[] = []
  for (const [command, method] of Object.entries(RUNTIME_TARGETS)) {
    if (typeof (impls.real as Record<string, unknown>)[method] !== "function") {
      missing.push(`${command} -> RealPiSession.${method}`)
    }
    if (typeof (impls.mock as Record<string, unknown>)[method] !== "function") {
      missing.push(`${command} -> MockPiSession.${method}`)
    }
  }
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`session runtime targets are not implemented by a driver:\n- ${missing.join("\n- ")}`),
      { code: "PI_SDK_INCOMPATIBLE" },
    )
  }
}
