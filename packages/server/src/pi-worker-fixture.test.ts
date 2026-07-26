import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureSource = readFileSync(path.join(here, "pi-worker-fixture.mjs"), "utf8")
const protocolSource = readFileSync(
  path.join(here, "..", "..", "pi-worker", "src", "worker-protocol.ts"),
  "utf8",
)

function protocolCommands(): string[] {
  const start = protocolSource.indexOf("export type WorkerCommand =")
  assert.notEqual(start, -1, "WorkerCommand union not found")
  const rest = protocolSource.slice(start + "export type WorkerCommand =".length)
  const end = rest.search(/\nexport (type|interface|const|function|declare) /)
  const union = end === -1 ? rest : rest.slice(0, end)
  return [...new Set([...union.matchAll(/type:\s*"([a-zA-Z]+)"/g)].map(match => match[1]))]
}

function fixtureCommands(): Set<string> {
  const handled = new Set(
    [...fixtureSource.matchAll(/command\.type === "([a-zA-Z]+)"/g)].map(match => match[1]),
  )
  for (const list of fixtureSource.matchAll(/\[([^\]]*)\]\.includes\(command\.type\)/g)) {
    for (const entry of list[1].matchAll(/"([a-zA-Z]+)"/g)) handled.add(entry[1])
  }
  return handled
}

describe("pi worker fixture fidelity", () => {
  it("implements every worker command explicitly", () => {
    const commands = protocolCommands()
    // Guards against a vacuous pass if the union ever stops being parseable.
    assert.ok(commands.length > 50, `expected the full command union, parsed ${commands.length}`)
    const handled = fixtureCommands()
    const missing = commands.filter(command => !handled.has(command))
    assert.deepEqual(
      missing,
      [],
      `fixture is missing branches for ${missing.join(", ")}; a silent fallback would let ` +
        "server tests pass while the real worker behaves differently",
    )
  })

  it("rejects unknown commands instead of faking a session result", () => {
    assert.match(fixtureSource, /WORKER_PROTOCOL_MISMATCH/)
  })
})
