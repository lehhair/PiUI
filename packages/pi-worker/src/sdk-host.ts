import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { existsSync, statSync } from "node:fs"
import { PI_PARITY_SDK_VERSION } from "@piui/protocol"
import type * as PiSdkModule from "@earendil-works/pi-coding-agent"

export type PiSdk = typeof PiSdkModule

export interface LoadedSdk {
  sdk: PiSdk
  version: string
  source: "bundled" | "external"
  verified: boolean
}

export interface LoadSdkOptions {
  sdkPath?: string
  strict?: boolean
}

let cached: LoadedSdk | undefined

function resolveSdkEntry(sdkPath: string): string {
  const absolute = isAbsolute(sdkPath) ? sdkPath : resolve(sdkPath)
  if (!existsSync(absolute)) {
    throw Object.assign(new Error(`Pi SDK path does not exist: ${absolute}`), { code: "DRIVER_UNAVAILABLE" })
  }
  if (statSync(absolute).isDirectory()) {
    const entry = join(absolute, "dist", "index.js")
    if (!existsSync(entry)) {
      throw Object.assign(new Error(`Pi SDK entry not found at ${entry}`), { code: "DRIVER_UNAVAILABLE" })
    }
    return entry
  }
  return absolute
}

export async function loadPiSdk(options: LoadSdkOptions = {}): Promise<LoadedSdk> {
  if (cached) return cached
  const external = options.sdkPath?.trim()
  const specifier = external
    ? pathToFileURL(resolveSdkEntry(external)).href
    : "@earendil-works/pi-coding-agent"
  const sdk = await import(specifier) as PiSdk
  const version = typeof sdk.VERSION === "string" ? sdk.VERSION : "unknown"
  const verified = version === PI_PARITY_SDK_VERSION
  if (!verified && !external) {
    throw Object.assign(
      new Error(`Bundled Pi SDK ${version} does not match the verified parity version ${PI_PARITY_SDK_VERSION}`),
      { code: "PI_SDK_VERSION_MISMATCH" },
    )
  }
  if (!verified && external) {
    const message = `External Pi SDK ${version} is not the verified parity version ${PI_PARITY_SDK_VERSION}`
    if (options.strict) {
      throw Object.assign(new Error(message), { code: "PI_SDK_VERSION_MISMATCH" })
    }
    console.warn(`[piui-worker] ${message}; continuing because external SDKs are opt-in`)
  }
  cached = { sdk, version, source: external ? "external" : "bundled", verified }
  return cached
}

export function getLoadedSdk(): LoadedSdk {
  if (!cached) throw Object.assign(new Error("Pi SDK is not loaded yet"), { code: "DRIVER_UNAVAILABLE" })
  return cached
}
