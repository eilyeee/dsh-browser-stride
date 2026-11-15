/** Vertical user-scrollable context for an observed control, excluding the viewport. */
import { composedParent } from './dom-tree.ts'
export function nearestScrollContainer(element: Element): HTMLElement | undefined {
  for (let node: Element | null = element; node !== null; node = composedParent(node)) {
    if (!(node instanceof HTMLElement) || node === document.body || node === document.documentElement
      || node === document.scrollingElement) continue
    const style = getComputedStyle(node)
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll')
      && node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 1) return node
  }
  return undefined
}

/** Informational page geometry; it grants no access or target selection. */
export function scrollContext(element: Element): { top: number; max: number } | undefined {
  const container = nearestScrollContainer(element)
  return container === undefined ? undefined : { top: Math.round(container.scrollTop), max: container.scrollHeight - container.clientHeight }
}
