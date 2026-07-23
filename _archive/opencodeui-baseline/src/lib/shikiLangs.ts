declare const __SHIKI_SUPPORTED_LANGS__: string[]

const supportedLangs = new Set<string>(__SHIKI_SUPPORTED_LANGS__)

export function isSupportedLanguage(lang: string): boolean {
  return supportedLangs.has(lang)
}
