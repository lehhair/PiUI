import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

function restoreProperty(target: object, key: PropertyKey, descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor)
    return
  }
  Reflect.deleteProperty(target, key)
}

describe('copyTextToClipboard', () => {
  afterEach(() => {
    restoreProperty(navigator, 'clipboard', originalClipboard)
    restoreProperty(document, 'execCommand', originalExecCommand)
    vi.restoreAllMocks()
  })

  it('uses Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const execCommand = vi.fn().mockReturnValue(true)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    await copyTextToClipboard('hello world')

    expect(writeText).toHaveBeenCalledWith('hello world')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when Clipboard API fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const execCommand = vi.fn().mockReturnValue(true)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    await copyTextToClipboard('fallback text')

    expect(writeText).toHaveBeenCalledWith('fallback text')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })
})
