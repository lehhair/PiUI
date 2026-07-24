export function extractContentFromUnifiedDiff(diff: string): { before: string; after: string } {
  let before = ''
  let after = ''

  for (const line of diff.split('\n')) {
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('Index:') ||
      line.startsWith('===') ||
      line.startsWith('@@') ||
      line.startsWith('\\ No newline')
    ) {
      continue
    }

    if (line.startsWith('-')) {
      before += line.slice(1) + '\n'
    } else if (line.startsWith('+')) {
      after += line.slice(1) + '\n'
    } else if (line.startsWith(' ')) {
      before += line.slice(1) + '\n'
      after += line.slice(1) + '\n'
    }
  }

  return { before: before.trimEnd(), after: after.trimEnd() }
}
