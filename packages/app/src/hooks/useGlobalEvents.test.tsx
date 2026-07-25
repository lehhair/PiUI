import { describe, expect, it } from 'vitest'
import {
  hasOtherConsumerForSession,
  registerSessionConsumer,
  updateConsumerSessionId,
} from './useGlobalEvents'

describe('Pi pane event consumers', () => {
  it('tracks consumers by their active Pi session', () => {
    const disposeA = registerSessionConsumer('pane-a', 'session-a', {})
    const disposeB = registerSessionConsumer('pane-b', 'session-a', {})

    expect(hasOtherConsumerForSession('session-a', 'pane-a')).toBe(true)

    updateConsumerSessionId('pane-b', 'session-b')
    expect(hasOtherConsumerForSession('session-a', 'pane-a')).toBe(false)

    disposeA()
    disposeB()
  })

  it('removes consumers when panes unmount', () => {
    const dispose = registerSessionConsumer('pane-a', 'session-a', {})
    dispose()

    expect(hasOtherConsumerForSession('session-a', 'pane-b')).toBe(false)
  })
})
