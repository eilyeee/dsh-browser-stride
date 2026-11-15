/** DOM discovery helpers; open roots add observation scope, never authority. */
export const OPEN_TREE_LIMITS = { elements: 50_000, roots: 64, depth: 16 } as const

/** Include assigned slots and their hosts when checking rendered ancestors. */
export function composedParent(element: Element): Element | null {
  if (element.assignedSlot !== null) return element.assignedSlot
  if (element.parentElement !== null) return element.parentElement
  const root = element.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

export function closestComposed(element: Element, selector: string): Element | null {
  for (let node: Element | null = element; node !== null; node = composedParent(node)) {
    if (node.matches(selector)) return node
  }
  return null
}

/** Host-first traversal; slotted light nodes are scanned only in their own tree. */
export function queryOpenRoots(root: Document | Element | ShadowRoot, selector: string): {
  elements: Element[]; limited: boolean; openRoots: number
} {
  const elements: Element[] = []
  let visited = 0, openRoots = 0, limited = false
  const visit = (scope: Document | Element | ShadowRoot, depth: number): void => {
    if (limited) return
    if (scope instanceof ShadowRoot) {
      if (scope.mode !== 'open' || depth > OPEN_TREE_LIMITS.depth || openRoots >= OPEN_TREE_LIMITS.roots) { limited = true; return }
      openRoots += 1
    }
    if (scope instanceof Element && scope.shadowRoot !== null) visit(scope.shadowRoot, depth + 1)
    const doc = scope instanceof Document ? scope : scope.ownerDocument
    const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT)
    for (let node = walker.nextNode(); node !== null && !limited; node = walker.nextNode()) {
      if (++visited > OPEN_TREE_LIMITS.elements) { limited = true; break }
      const element = node as Element
      if (element.matches(selector)) elements.push(element)
      if (element.shadowRoot !== null) visit(element.shadowRoot, depth + 1)
    }
  }
  visit(root, 0)
  return { elements, limited, openRoots }
}

const rootIds = new WeakMap<ShadowRoot, number>()
let nextRootId = 1
/** Moving the same node to another component must retire its old identity. */
export function shadowContextIdentity(element: Element): readonly number[] {
  const ids: number[] = [], seen = new Set<ShadowRoot>()
  for (let node: Element | null = element; node !== null; node = composedParent(node)) {
    const root = node.getRootNode()
    if (!(root instanceof ShadowRoot) || seen.has(root)) continue
    seen.add(root)
    let id = rootIds.get(root)
    if (id === undefined) { id = nextRootId++; rootIds.set(root, id) }
    ids.push(id)
  }
  return ids
}
