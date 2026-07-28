import { beforeEach, describe, expect, it } from 'vitest'
import {
  getManagementEventSnapshot,
  getTrackedManagementProviders,
  receivePackageProgress,
  receiveProviderAuthEvent,
  receiveResourceRevision,
  registerProviderAuthFlow,
  resetManagementEvents,
  trackManagementProviders,
} from './managementEventStore'

describe('managementEventStore', () => {
  beforeEach(() => resetManagementEvents())

  it('tracks provider streams and preserves an early auth prompt when the flow is registered', () => {
    trackManagementProviders(['anthropic', 'anthropic', 'openai'])
    expect(getTrackedManagementProviders()).toEqual(['anthropic', 'openai'])

    receiveProviderAuthEvent({
      type: 'prompt',
      flowId: 'flow-1',
      promptId: 'prompt-1',
      providerId: 'anthropic',
      prompt: { type: 'secret', message: 'API key' },
    })
    registerProviderAuthFlow('flow-1', 'anthropic')
    expect(getManagementEventSnapshot().flows['flow-1'].event).toMatchObject({ type: 'prompt', promptId: 'prompt-1' })
  })

  it('stores package progress and resource revisions independently', () => {
    receivePackageProgress({ commandId: 'package-1', workspacePath: '/repo', type: 'progress', action: 'install', source: 'pkg', message: 'downloading' })
    receiveResourceRevision('/repo', 'revision-2')
    expect(getManagementEventSnapshot().packageProgress['package-1'].message).toBe('downloading')
    expect(getManagementEventSnapshot().resourceRevisions['/repo']).toBe('revision-2')
  })
})
