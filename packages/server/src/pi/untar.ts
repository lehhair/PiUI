import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Minimal tar reader for npm tarballs (ustar + pax extended headers).
 * npm packs long paths as pax 'x' entries, so those must be understood;
 * everything that isn't a regular file or directory is skipped.
 */

export interface TarEntry {
  name: string
  data: Buffer
}

function parseOctal(field: Buffer): number {
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim()
  return text ? parseInt(text, 8) : 0
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {}
  let rest = data.toString("utf8")
  while (rest.length > 0) {
    const space = rest.indexOf(" ")
    if (space === -1) break
    const length = parseInt(rest.slice(0, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = rest.slice(space + 1, length - 1)
    const eq = record.indexOf("=")
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1)
    rest = rest.slice(length)
  }
  return records
}

export function untar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let paxPath: string | undefined
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "")
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "")
    const size = parseOctal(header.subarray(124, 136))
    const type = String.fromCharCode(header[156] ?? 48)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > archive.length) break
    offset = dataStart + Math.ceil(size / 512) * 512

    if (type === "x") {
      paxPath = parsePaxRecords(archive.subarray(dataStart, dataEnd)).path
      continue
    }
    const fullName = paxPath ?? (prefix ? `${prefix}/${name}` : name)
    paxPath = undefined
    if (type !== "0" && type !== "\0") continue
    entries.push({ name: fullName, data: Buffer.from(archive.subarray(dataStart, dataEnd)) })
  }
  return entries
}

/** npm tarballs wrap everything in `package/`; strip it while extracting. */
export function extractNpmTarball(tgz: Buffer, targetDir: string): number {
  const archive = gunzipSync(tgz)
  let count = 0
  for (const entry of untar(archive)) {
    const relative = entry.name.replace(/^package\//, "")
    if (!relative || relative.includes("..")) continue
    const target = join(targetDir, ...relative.split("/"))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    count += 1
  }
  return count
}

/** Verify an npm `dist.integrity` value ("sha512-<base64>") against a tarball. */
export function verifyIntegrity(tgz: Buffer, integrity: string | undefined): boolean {
  if (!integrity) return false
  const [algorithm, expected] = integrity.split("-", 2)
  if (algorithm !== "sha512" && algorithm !== "sha1") return false
  const actual = createHash(algorithm).update(tgz).digest("base64")
  return actual === expected
}
