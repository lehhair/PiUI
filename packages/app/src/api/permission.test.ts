import { describe, expect, it } from 'vitest'
import { getPendingPermissions, getPendingQuestions, rejectQuestion, replyPermission } from './permission'

describe('Pi permission facade', () => {
  it('returns no pending requests while protocol support is unavailable', async () => {
    await expect(getPendingPermissions('session-1')).resolves.toEqual([])
    await expect(getPendingQuestions('session-1')).resolves.toEqual([])
  })

  it('reports unsupported replies explicitly', async () => {
    await expect(replyPermission('permission-1', 'once')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(rejectQuestion('question-1')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})
