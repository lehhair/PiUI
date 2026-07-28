import { beforeEach, describe, expect, it, vi } from 'vitest'
const fetchMock = vi.fn()

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Pi session command transport', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('sends the native navigation summary option under the server field name', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ snapshot: {}, cancelled: false, aborted: false }))
    const { navigatePiSessionTree } = await import('./sessionApi')
    await navigatePiSessionTree('session', 'entry', true, {}, 'command')

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({
      entryId: 'entry',
      summarize: true,
      commandId: 'command',
    })
    expect(JSON.parse(String(init.body))).not.toHaveProperty('summarizeAbandonedBranch')
  })

  it('passes prompt template expansion to AgentSession.prompt', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ commandId: 'command', accepted: true, reused: false }))
    const { promptSession } = await import('./sessionApi')
    await promptSession('session', '/review changes', {
      commandId: 'command',
      stream: true,
      expandPromptTemplates: false,
    })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: '/review changes',
      stream: true,
      expandPromptTemplates: false,
    })
  })

  it('wraps bare custom-message, custom-entry, and wait snapshots for UI consumers', async () => {
    const snapshots = [{ session: { id: 'message' } }, { session: { id: 'entry' } }, { session: { id: 'idle' } }]
    fetchMock
      .mockResolvedValueOnce(jsonResponse(snapshots[0]))
      .mockResolvedValueOnce(jsonResponse(snapshots[1]))
      .mockResolvedValueOnce(jsonResponse(snapshots[2]))
    const { appendPiCustomEntry, sendPiCustomMessage, waitForPiSessionIdle } = await import('./sessionApi')

    await expect(sendPiCustomMessage('session', {
      customType: 'notice',
      content: [{ type: 'text', text: 'hello' }],
      display: true,
    })).resolves.toEqual({ snapshot: snapshots[0] })
    await expect(appendPiCustomEntry('session', 'metadata', { ok: true })).resolves.toEqual({ snapshot: snapshots[1] })
    await expect(waitForPiSessionIdle('session')).resolves.toEqual({ snapshot: snapshots[2] })
  })
})
