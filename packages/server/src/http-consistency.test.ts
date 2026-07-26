import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const here = path.dirname(fileURLToPath(import.meta.url))
const httpSource = readFileSync(path.join(here, "http.ts"), "utf8")
// Checkouts on Windows carry CRLF, and `.` never matches `\r`, so normalise
// before matching or every guard below silently stops seeing those lines.
const lines = httpSource.split(/\r?\n/)

/**
 * Command routes used to each roll their own body parsing and commandId
 * lookup, which made behaviour differ per endpoint: some accepted a body
 * commandId, some only a header, and a few swallowed malformed JSON and
 * silently dropped the payload. These guards keep new routes on the shared
 * helpers instead of reintroducing that drift.
 */
describe("http command route consistency", () => {
  it("derives every executor commandId from resolveCommandId", () => {
    const submits = lines.filter(line => line.includes("sessionExecutor.submit("))
    assert.ok(submits.length > 20, `expected the full set of command routes, found ${submits.length}`)

    const bindings = lines.flatMap((line, index) => {
      const match = line.match(/const commandId = (.+)$/)
      return match ? [{ line: index + 1, value: match[1].trim() }] : []
    })
    // One binding per command route; a new route that hand-rolls its own
    // lookup would show up here instead of silently diverging.
    assert.ok(bindings.length > 20, `expected a commandId binding per route, found ${bindings.length}`)

    const offenders = bindings
      .filter(binding => binding.value !== "resolveCommandId(req, body)")
      .map(binding => `line ${binding.line}: ${binding.value}`)
    assert.deepEqual(
      offenders,
      [],
      "these routes bypass resolveCommandId, so clients cannot retry them idempotently " +
        `the same way everywhere:\n${offenders.join("\n")}`,
    )
  })

  it("reads the x-command-id header only inside resolveCommandId", () => {
    const readers = lines.flatMap((line, index) =>
      line.includes('req.headers["x-command-id"]') ? [index + 1] : [],
    )
    assert.deepEqual(
      readers,
      [lines.findIndex(line => line.includes('const headerValue = req.headers["x-command-id"]')) + 1],
      "the header must be parsed in one place so validation cannot be skipped",
    )
  })

  it("never swallows malformed json", () => {
    // `catch { /* empty ok */ }` around JSON.parse used to turn a broken body
    // into an empty object, dropping fields like compact instructions.
    const swallowed = lines.flatMap((line, index) =>
      /catch\s*\{\s*\/\*\s*empty ok/.test(line) ? [index + 1] : [],
    )
    assert.deepEqual(swallowed, [], `malformed json must be rejected, not defaulted (lines ${swallowed.join(", ")})`)
  })

  it("answers method mismatches with 405 and an Allow header", () => {
    assert.match(httpSource, /res\.setHeader\("allow", allowed\)/)
    assert.match(httpSource, /sendProblem\(res, 405, "METHOD_NOT_ALLOWED"/)
    const untypedFiveOhFive = lines.filter(line => /405, "INVALID_REQUEST"/.test(line))
    assert.deepEqual(untypedFiveOhFive, [], "405 responses must use METHOD_NOT_ALLOWED")
  })

  it("uses auth-specific codes for 401 and 403", () => {
    assert.match(httpSource, /sendProblem\(res, 401, "UNAUTHORIZED"/)
    assert.match(httpSource, /sendProblem\(res, 403, "FORBIDDEN"/)
  })

  it("advertises the headers and methods the client actually sends", () => {
    const allowedMethods = httpSource.match(/"access-control-allow-methods": "([^"]+)"/)?.[1] ?? ""
    const allowedHeaders = httpSource.match(/"access-control-allow-headers": "([^"]+)"/)?.[1] ?? ""
    // PATCH is used by pi-settings and x-command-id by every command retry;
    // omitting either makes the browser preflight fail before the request.
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      assert.ok(allowedMethods.includes(method), `CORS is missing ${method}`)
    }
    for (const header of ["content-type", "authorization", "x-command-id", "if-match"]) {
      assert.ok(allowedHeaders.includes(header), `CORS is missing ${header}`)
    }
  })
})
