export interface LSPStatus {
  running: boolean
  language?: string
  capabilities?: string[]
}

export interface FormatterStatus {
  available: boolean
  name?: string
}

export async function getLspStatus(_directory?: string): Promise<LSPStatus> {
  return { running: false }
}

export async function getFormatterStatus(_directory?: string): Promise<FormatterStatus> {
  return { available: false }
}
