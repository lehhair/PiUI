import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSoundSnapshotMock, getCustomAudioBlobMock, playSoundMock } = vi.hoisted(() => ({
  getSoundSnapshotMock: vi.fn(),
  getCustomAudioBlobMock: vi.fn(),
  playSoundMock: vi.fn(),
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

  it('plays the configured sound for a notification type', async () => {
    const { playNotificationSound } = await import('./notificationSoundBridge')

    playNotificationSound('question')

    expect(playSoundMock).toHaveBeenCalledWith({
      soundId: 'builtin:question',
      customAudioData: null,
      volume: 50,
    })
  })

  it('respects the master switch and volume', async () => {
    const { playNotificationSound } = await import('./notificationSoundBridge')
    getSoundSnapshotMock.mockReturnValue({
      enabled: false,
      volume: 50,
      events: { completed: { soundId: 'builtin:completed' } },
    })

    playNotificationSound('completed')

    expect(playSoundMock).not.toHaveBeenCalled()
  })
})
