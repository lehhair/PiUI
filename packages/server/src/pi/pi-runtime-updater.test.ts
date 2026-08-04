import assert from "node:assert/strict"
import test from "node:test"
import { gzipSync, gunzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractNpmTarball, untar, verifyIntegrity } from "./untar.ts"
import { resolveInstallPlan, type RegistryMetadata } from "./pi-runtime-updater.ts"

function tarHeader(name: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, "utf8")
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1")
  header.write("0000644\0", 100, "latin1")
  header.write(type, 156, "latin1")
  header.write("ustar\0", 257, "latin1")
  header.write("00", 263, "latin1")
  // checksum：先填空格再算
  header.write("        ", 148, "latin1")
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1")
  return header
}

function npmTarball(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8")
    parts.push(tarHeader(`package/${name}`, data.length))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

test("untar reads regular files and skips non-file entries", () => {
  const entries = untar(gunzipSync(npmTarball({ "index.js": "export const x = 1", "dist/a.js": "aaa" })))
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.name, "package/index.js")
  assert.equal(entries[0]!.data.toString("utf8"), "export const x = 1")
})

test("extractNpmTarball strips the package/ prefix and writes files", () => {
  const dir = mkdtempSync(join(tmpdir(), "piui-untar-"))
  try {
    const count = extractNpmTarball(npmTarball({ "dist/index.js": "hello" }), dir)
    assert.equal(count, 1)
    assert.equal(readFileSync(join(dir, "dist", "index.js"), "utf8"), "hello")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("verifyIntegrity checks sha512 digests from the registry", () => {
  const tgz = npmTarball({ "index.js": "x" })
  const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`
  assert.equal(verifyIntegrity(tgz, integrity), true)
  assert.equal(verifyIntegrity(tgz, "sha512-wrong"), false)
  assert.equal(verifyIntegrity(tgz, undefined), false)
})

function meta(versions: Record<string, Record<string, string>>): RegistryMetadata {
  return {
    "dist-tags": { latest: Object.keys(versions).at(-1) },
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, deps]) => [
        version,
        { version, dependencies: deps, dist: { tarball: `https://r/${version}.tgz`, integrity: "sha512-x" } },
      ]),
    ),
  }
}

test("resolveInstallPlan walks the closure and picks the highest joint version", async () => {
  const registry: Record<string, RegistryMetadata> = {
    seed: meta({ "1.0.0": { a: "^1.0.0" }, "1.1.0": { a: "^1.1.0" } }),
    a: meta({ "1.0.0": {}, "1.1.0": { b: "^2.0.0" }, "1.2.0": { b: "^2.1.0" } }),
    b: meta({ "2.0.0": {}, "2.1.0": {} }),
  }
  const plan = await resolveInstallPlan({ name: "seed", range: "1.1.0" }, async name => registry[name]!)
  const byName = Object.fromEntries(plan.map(entry => [entry.name, entry.version]))
  assert.deepEqual(byName, { seed: "1.1.0", a: "1.2.0", b: "2.1.0" })
})

test("resolveInstallPlan converges when a later range tightens an earlier pick", async () => {
  const registry: Record<string, RegistryMetadata> = {
    seed: meta({ "1.0.0": { a: "^1.0.0", c: "^1.0.0" } }),
    a: meta({ "1.0.0": {}, "1.1.0": { c: "<1.1.0" } }),
    c: meta({ "1.0.0": {}, "1.1.0": {} }),
  }
  const plan = await resolveInstallPlan({ name: "seed", range: "1.0.0" }, async name => registry[name]!)
  const byName = Object.fromEntries(plan.map(entry => [entry.name, entry.version]))
  // c 必须回落到 1.0.0（a@1.1.0 要求 <1.1.0）
  assert.deepEqual(byName, { seed: "1.0.0", a: "1.1.0", c: "1.0.0" })
})

test("resolveInstallPlan fails clearly on unsatisfiable ranges", async () => {
  const registry: Record<string, RegistryMetadata> = {
    seed: meta({ "1.0.0": { a: ">=2.0.0" } }),
    a: meta({ "1.0.0": {} }),
  }
  await assert.rejects(
    resolveInstallPlan({ name: "seed", range: "1.0.0" }, async name => registry[name]!),
    /no version of a satisfies/,
  )
})
