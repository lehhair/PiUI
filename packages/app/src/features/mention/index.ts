// ============================================
// Mention Module Exports
// ============================================

// Types
export type { MentionType, MentionItem, ParsedSegment, MentionMenuState, MentionConfig } from './types'

export { MENTION_PATTERN, getMentionPattern } from './types'

// Utils
export {
  normalizePath,
  getFileName,
  toAbsolutePath,
  toFileUrl,
  formatMentionLabel,
  formatMentionShort,
  serializeMention,
  parseMentions,
  extractMentions,
  stripMentions,
  detectMentionTrigger,
  MENTION_COLORS,
} from './utils'

// Components
export { MentionTag, RichText } from './MentionTag'
export { createMentionElement } from './createMentionElement'
export { MentionMenu, type MentionMenuHandle } from './MentionMenu'

// Hooks
export { useMention } from './useMention'
