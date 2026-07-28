import { listSessionSkills } from '../pi/sessionApi'
import type { SkillList } from '../types/api/skill'

export async function getSkills(sessionId?: string | null): Promise<SkillList> {
  if (!sessionId) return []
  const { skills } = await listSessionSkills(sessionId)
  return skills.map(skill => ({
    name: skill.name,
    description: skill.description,
    location: skill.filePath,
  }))
}
