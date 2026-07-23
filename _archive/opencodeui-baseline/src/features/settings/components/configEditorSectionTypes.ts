import type { Config } from '../../../types/api/config'
import type { Choice, JsonRecord, Lang } from './configEditorTypes'

export type SectionProps = {
  config: Config
  setConfig: (config: Config) => void
  lang: Lang
  shells: Choice[]
  models: Choice[]
  agents: Choice[]
  providerCatalog: JsonRecord
}

export function enumChoices(values: string[]): Choice[] {
  return values.map(value => ({ value, label: value }))
}
