import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { ExtensionUiSurface } from './ExtensionUiSurface'

describe('ExtensionUiSurface', () => {
  beforeEach(() => extensionUiStore.reset())

  it('renders extension status and string widgets in their requested placements', () => {
    extensionUiStore.replace({
      sessionId: 'session-1',
      state: {
        revision: 1,
        statuses: { mode: 'reviewing' },
        workingMessage: 'Checking files',
        workingVisible: true,
        widgets: {
          top: { lines: ['Above editor'], placement: 'aboveEditor' },
          bottom: { lines: ['Below editor'], placement: 'belowEditor' },
        },
        editorText: '',
        toolsExpanded: true,
      },
      pending: [],
    })
    const { rerender } = render(<ExtensionUiSurface sessionId="session-1" placement="aboveEditor" />)
    expect(screen.getByText('reviewing')).toBeInTheDocument()
    expect(screen.getByText('Checking files')).toBeInTheDocument()
    expect(screen.getByText('Above editor')).toBeInTheDocument()
    rerender(<ExtensionUiSurface sessionId="session-1" placement="belowEditor" />)
    expect(screen.getByText('Below editor')).toBeInTheDocument()
    expect(screen.queryByText('Above editor')).not.toBeInTheDocument()
  })
})
