// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DefaultRenderer } from './DefaultRenderer'
import { liveToolOutputStore } from '../../../../pi/liveToolOutput'
import type { ExtractedToolData } from '../types'
import type { PiToolExecution } from '../../../../pi/domain/index.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../../../contexts', () => ({
  useFullscreen: () => ({
    activeId: null,
    openFullscreen: vi.fn(),
    updateFullscreen: vi.fn(),
    closeFullscreen: vi.fn(),
  }),
  useFullscreenLayer: () => ({ isOpen: false, open: vi.fn(), close: vi.fn() }),
}))



function runningEditExecution(toolCallId = 'call-edit'): PiToolExecution {
  return {
    call: {
      type: 'toolCall',
      id: toolCallId,
      name: 'edit',
      arguments: { filePath: 'src/app.ts', oldString: 'a', newString: 'b' },
    },
    result: undefined,
  }
}

function renderDefault(execution: PiToolExecution, data: ExtractedToolData) {
  return render(
    <DefaultRenderer
      execution={execution}
      partKey="p1"
      data={data}
      onFullscreenChange={vi.fn()}
    />,
  )
}

describe('DefaultRenderer', () => {
  beforeEach(() => liveToolOutputStore.clearAll())

  it('streams live tool output for non-bash tools while running', async () => {
    renderDefault(runningEditExecution(), { input: '{"filePath":"src/app.ts"}' })

    act(() => {
      liveToolOutputStore.set('call-edit', 'session-1', 'editing src/app.ts...')
    })

    expect(await screen.findByText('editing src/app.ts...')).toBeInTheDocument()
  })

  it('prefers the persisted result output once the tool completes', async () => {
    renderDefault(runningEditExecution(), { output: 'final result', filePath: 'src/app.ts' })
    act(() => {
      liveToolOutputStore.set('call-edit', 'session-1', 'stale live text')
    })
    expect(await screen.findByText('final result')).toBeInTheDocument()
    expect(screen.queryByText('stale live text')).not.toBeInTheDocument()
  })
})
