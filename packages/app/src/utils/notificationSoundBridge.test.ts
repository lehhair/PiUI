import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSoundSnapshotMock, getCustomAudioBlobMock, playSoundMock, autoApproveStoreMock } = vi.hoisted(() => ({
  getSoundSnapshotMock: vi.fn(),
  getCustomAudioBlobMock: vi.fn(),
  playSoundMock: vi.fn(),
  autoApproveStoreMock: {
    fullAutoMode: 'off' as 'off' | 'session' | 'global',
  },
}))

vi.mock('../store/autoApproveStore', () => ({
  autoApproveStore: autoApproveStoreMock,
}))

vi.mock('../store/notificationStore', () => ({
  notificationStore: {
    onPush: vi.fn(),
  },
}))

vi.mock('../store/soundStore', () => ({
  soundStore: {
    getSnapshot: () => getSoundSnapshotMock(),
    getCustomAudioBlob: (type: string) => getCustomAudioBlobMock(type),
  },
}))

vi.mock('./soundPlayer', () => ({
  playSound: playSoundMock,
}))

describe('notificationSoundBridge', () => {
  beforeEach(() => {
    getSoundSnapshotMock.mockReset()
    getCustomAudioBlobMock.mockReset()
    playSoundMock.mockReset()
    autoApproveStoreMock.fullAutoMode = 'off'
    getSoundSnapshotMock.mockReturnValue({
      enabled: true,
      volume: 50,
      events: {
        completed: { soundId: 'builtin:completed' },
        permission: { soundId: 'builtin:permission' },
        question: { soundId: 'builtin:question' },
        error: { soundId: 'builtin:error' },
      },
    })
  })

  it('does not play permission sound while global full auto is enabled', async () => {
    const { playNotificationSound } = await import('./notificationSoundBridge')
    autoApproveStoreMock.fullAutoMode = 'global'

    playNotificationSound('permission')

    expect(playSoundMock).not.toHaveBeenCalled()
  })

  it('still plays non-permission sounds while global full auto is enabled', async () => {
    const { playNotificationSound } = await import('./notificationSoundBridge')
    autoApproveStoreMock.fullAutoMode = 'global'

    playNotificationSound('question')

    expect(playSoundMock).toHaveBeenCalledWith({
      soundId: 'builtin:question',
      customAudioData: null,
      volume: 50,
    })
  })
})
