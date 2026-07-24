/** 多选连续高亮的圆角：中间项直角，首尾保留外侧圆角 */
export function getSelectionRoundClass(
  isChecked: boolean,
  checkedPrev: boolean,
  checkedNext: boolean,
  radius: 'md' | 'lg' = 'md',
): string {
  if (!isChecked) return radius === 'lg' ? 'rounded-lg' : 'rounded-md'
  if (checkedPrev && checkedNext) return 'rounded-none'
  if (checkedPrev) return radius === 'lg' ? 'rounded-b-lg' : 'rounded-b-md'
  if (checkedNext) return radius === 'lg' ? 'rounded-t-lg' : 'rounded-t-md'
  return radius === 'lg' ? 'rounded-lg' : 'rounded-md'
}
