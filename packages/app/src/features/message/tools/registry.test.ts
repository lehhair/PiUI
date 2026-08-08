import { describe, expect, it } from 'vitest'
import type { PiToolExecution } from '../../../pi/domain/index.js'
import { defaultExtractData, extractToolData } from './registry'

describe('defaultExtractData', () => {
  it('extracts files and diagnostics from result details', () => {
    const execution: PiToolExecution = {
      call: {
        type: 'toolCall',
        id: 'call-1',
        name: 'read',
        arguments: { filePath: 'src/app.ts' },
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
        timestamp: 0,
        details: {
          files: [
            {
              filePath: 'src/app.ts',
              diff: '@@ -1 +1 @@',
              additions: 1,
              deletions: 1,
            },
          ],
          diagnostics: {
            'src/app.ts': [
              {
                severity: 1,
                message: 'Syntax error',
                range: { start: { line: 3, character: 5 } },
              },
            ],
          },
        },
      },
    }

    const extracted = defaultExtractData(execution)

    expect(extracted.files).toEqual([expect.objectContaining({ filePath: 'src/app.ts', additions: 1, deletions: 1 })])
    expect(extracted.diagnostics).toEqual([
      expect.objectContaining({ file: 'app.ts', severity: 'error', line: 3, column: 5 }),
    ])
  })

  it('extracts native bash truncation fields from result details', () => {
    const execution: PiToolExecution = {
      call: {
        type: 'toolCall',
        id: 'call-2',
        name: 'bash',
        arguments: { command: 'make build' },
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'bash',
        content: [{ type: 'text', text: 'truncated output...' }],
        isError: false,
        timestamp: 0,
        details: {
          truncated: true,
          fullOutputPath: '/tmp/pi-bash-abc.log',
          exitCode: 0,
        },
      },
    }

    const extracted = extractToolData(execution)

    expect(extracted.cwd).toBeUndefined()
    expect(extracted.truncated).toBe(true)
    expect(extracted.fullOutputPath).toBe('/tmp/pi-bash-abc.log')
  })
})
