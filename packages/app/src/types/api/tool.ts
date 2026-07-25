export type ToolIDs = string[]
export interface ToolListItem { id: string; description?: string; parameters?: Record<string, unknown> }
export type ToolList = ToolListItem[]
