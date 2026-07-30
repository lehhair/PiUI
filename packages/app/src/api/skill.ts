import { getPiSkills } from '../pi/transport/index.js'
import type { SkillList } from '../types/api/skill'

interface NativeSkill {
  name: string
  description?: string
  filePath: string
  baseDir?: string
  sourceInfo?: unknown
  disableModelInvocation?: boolean
}

export async function getSkills(sessionId?: string | null): Promise<SkillList> {
  if (!sessionId) return []
  const skills = (await getPiSkills(sessionId)) as unknown as NativeSkill[]
  return skills.map(skill => ({
    name: skill.name,
    description: skill.description,
    location: skill.filePath,
    content: JSON.stringify({
      baseDir: skill.baseDir,
      disableModelInvocation: skill.disableModelInvocation,
      sourceInfo: skill.sourceInfo,
    }, null, 2),
  }))
}
