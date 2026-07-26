/**
 * Minimal complete loop (no LLM):
 * health → mock-chat → prompt → snapshot grows
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, it, after } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const PORT = 18787
// The server requires a local token, so pin one instead of reading whatever
// this machine happens to have persisted.
const TOKEN = "mvp-loop-test-token"
const authHeaders = { authorization: `Bearer ${TOKEN}` }

describe("mvp chat loop", () => {
  let child
  after(() => {
    if (child && !child.killed) child.kill("SIGTERM")
  })

  it("seed + prompt via live server process", async () => {
    child = spawn(
      process.execPath,
      ["--import", "tsx", "packages/server/src/index.ts"],
      {
        cwd: root,
        env: { ...process.env, PIUI_PORT: String(PORT), PIUI_AUTH_TOKEN: TOKEN },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    let ready = false
    for (let i = 0; i < 40; i++) {
      try {
        const h = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`, { headers: authHeaders })
        if (h.ok) {
          ready = true
          break
        }
      } catch {
        /* wait */
      }
      await sleep(100)
    }
    assert.ok(ready, "server did not start")

    const seed = await fetch(`http://127.0.0.1:${PORT}/api/v1/dev/mock-chat`, { method: "POST", headers: authHeaders })
    assert.equal(seed.status, 201)
    const seeded = await seed.json()
    const sessionId = seeded.snapshot.session.id
    const before = seeded.snapshot.timeline.length

    const prompt = await fetch(
      `http://127.0.0.1:${PORT}/api/v1/sessions/${sessionId}/commands/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ text: "mvp hello" }),
      },
    )
    assert.equal(prompt.status, 202)
    const accepted = await prompt.json()
    assert.equal(accepted.accepted, true)
    let body
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await fetch(`http://127.0.0.1:${PORT}/api/v1/sessions/${sessionId}/snapshot`, { headers: authHeaders })
      body = await snapshot.json()
      if (body.timeline.length > before) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(body.timeline.length > before)
    const texts = body.timeline
      .filter(t => t.type === "user")
      .map(t => t.text)
    assert.ok(texts.includes("mvp hello"))
  })
})
