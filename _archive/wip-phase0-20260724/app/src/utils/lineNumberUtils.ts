export function getLineCount(text: string): number {
  if (text.length === 0) return 1

  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  return count
}

export function getLineNumberColumnWidth(maxLineNo: number): number {
  const digits = String(Math.max(1, maxLineNo)).length
  return Math.max(44, digits * 8 + 28)
}
