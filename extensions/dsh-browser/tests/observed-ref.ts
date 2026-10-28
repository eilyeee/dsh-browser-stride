import type { ElementIds } from '../src/content/ids.ts'

/** Recover the reference actually shown for a test control. */
export function observedRef(snapshot: { text: string }, ids: ElementIds, element: Element): string {
  const index = ids.indexOf(element)
  const match = new RegExp(`ref=(obs_[a-f0-9-]+:${String(index)})(?:\\s|$)`, 'i').exec(snapshot.text)
  if (match?.[1] === undefined) throw new Error('The control was not visible in the snapshot')
  return match[1]
}
