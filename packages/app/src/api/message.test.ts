import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionMessages, sendMessage, sendMessageAsync } from './message'

const mocks = vi.hoisted(() => ({
  applySnapshotToUi: vi.fn(),
  fetchSnapshot: vi.fn(),
  promptSession: vi.fn(),
  snapshotToApiMessages: vi.fn(),
}))

vi.mock('../pi/applySnapshot', () => ({ applySnapshotToUi: mocks.applySnapshotToUi }))
vi.mock('../pi/sessionApi', () => ({ fetchSnapshot: mocks.fetchSnapshot, promptSession: mocks.promptSession }))
vi.mock('../pi/timelineToMessages', () => ({ snapshotToApiMessages: mocks.snapshotToApiMessages }))

const params = {
  sessionId: 'session-1',
  text: 'hello',
  attachments: [],
  model: { providerID: 'provider-1', modelID: 'model-1' },
}

describe('Pi message facade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchSnapshot.mockResolvedValue({ marker: 'loaded' })
    mocks.promptSession.mockResolvedValue({ marker: 'prompted' })
  })

  it('loads and limits messages projected from the Pi snapshot', async () => {
    mocks.snapshotToApiMessages.mockReturnValue([{ info: { id: 'one' } }, { info: { id: 'two' } }])

    await expect(getSessionMessages('session-1', 1)).resolves.toEqual([{ info: { id: 'two' } }])
    expect(mocks.fetchSnapshot).toHaveBeenCalledWith('session-1')
  })

  it('maps the final assistant message from a synchronous Pi prompt', async () => {
    const assistant = { info: { id: 'assistant', role: 'assistant' }, parts: [{ type: 'text', text: 'reply' }] }
    mocks.snapshotToApiMessages.mockReturnValue([{ info: { role: 'user' } }, assistant])

    await expect(sendMessage(params)).resolves.toEqual(assistant)
    expect(mocks.promptSession).toHaveBeenCalledWith('session-1', 'hello', { model: params.model })
    expect(mocks.applySnapshotToUi).toHaveBeenCalledWith({ marker: 'prompted' })
  })

  it('streams supported text prompts and rejects unsupported attachments', async () => {
    await expect(sendMessageAsync(params)).resolves.toBeUndefined()
    expect(mocks.promptSession).toHaveBeenCalledWith('session-1', 'hello', {
      stream: true,
      model: params.model,
    })

    await expect(
      sendMessage({ ...params, attachments: [{ id: 'file-1', type: 'file', displayName: 'file.txt' }] }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})
