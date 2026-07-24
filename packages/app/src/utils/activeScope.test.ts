import { describe, expect, it } from 'vitest'
import { collectActiveDirectories } from './activeScope'

describe('collectActiveDirectories', () => {
  it('includes saved project directories in the active scope', () => {
    expect(
      collectActiveDirectories({
        routeDirectory: '/workspace/current',
        currentDirectory: '/workspace/current',
        paneDirectories: ['/workspace/split-pane'],
        projectDirectories: ['/workspace/current', '/workspace/project-a', '/workspace/project-b'],
      }),
    ).toEqual(['/workspace/current', '/workspace/split-pane', '/workspace/project-a', '/workspace/project-b'])
  })

  it('deduplicates directories across different path styles', () => {
    expect(
      collectActiveDirectories({
        routeDirectory: 'E:/Dev/Repo',
        currentDirectory: 'e:\\dev\\repo',
        paneDirectories: ['E:/dev/other'],
        projectDirectories: ['e:/DEV/repo', 'E:\\DEV\\OTHER', 'E:/dev/third'],
      }),
    ).toEqual(['E:/Dev/Repo', 'E:/dev/other', 'E:/dev/third'])
  })
})
