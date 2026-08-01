/**
 * Build per-turn redo checkpoints from the branch tail being undone.
 *
 * Each checkpoint is the tail entry of one user turn ON THE CUT BRANCH
 * (its entry id, captured before navigation) so redo always follows the
 * branch the entries came from — never a guessed child when the undo
 * point has multiple branches (earlier forks, or a new send after undo).
 *
 * Turns whose tail is only user/custom messages can't be restored via
 * navigateTree (navigating to those cuts before them again) and are
 * skipped — they stay cut, their text is in the editor for re-send.
 */
export function buildRedoCheckpoints(cutItems: Array<{ kind: string; entryId: string }>): string[] {
  const isTurnStart = (kind: string) => kind === 'user_message' || kind === 'custom_message'
  const turnStarts = cutItems
    .map((item, index) => (isTurnStart(item.kind) ? index : -1))
    .filter(index => index >= 0)
  const checkpoints: string[] = []
  for (let j = 0; j < turnStarts.length; j++) {
    const endExclusive = j + 1 < turnStarts.length ? turnStarts[j + 1] : cutItems.length
    let tail = endExclusive - 1
    while (tail > turnStarts[j] && isTurnStart(cutItems[tail].kind)) tail--
    if (isTurnStart(cutItems[tail].kind)) continue
    checkpoints.push(cutItems[tail].entryId)
  }
  return checkpoints
}
