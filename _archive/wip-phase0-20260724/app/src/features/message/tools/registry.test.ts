import { describe, expect, it } from 'vitest'
import type { ToolPart } from '../../../types/message'
import { defaultExtractData } from './registry'

describe('defaultExtractData', () => {
  it('extracts files and diagnostics from metadata', () => {
    const part = {
      type: 'tool',
      tool: 'read',
      id: 'tool-1',
      callID: 'call-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      state: {
        input: { filePath: 'src/app.ts' },
        metadata: {
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
    } as unknown as ToolPart

    const extracted = defaultExtractData(part)

    expect(extracted.files).toEqual([expect.objectContaining({ filePath: 'src/app.ts', additions: 1, deletions: 1 })])
    expect(extracted.diagnostics).toEqual([
      expect.objectContaining({ file: 'app.ts', severity: 'error', line: 3, column: 5 }),
    ])
  })
})
