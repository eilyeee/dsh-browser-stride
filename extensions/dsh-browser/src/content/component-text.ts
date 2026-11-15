/** Bounded rendered-DOM prose, with open roots and slot assignment in scope. */
import { composedParent, OPEN_TREE_LIMITS } from './dom-tree.ts'
import { redactSensitivePageText } from './privacy.ts'

const MAX_TEXT_CHARS = 250_000
const OMIT = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'SELECT', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED'])
const BLOCK = new Set(['block', 'flex', 'grid', 'flow-root', 'list-item', 'table', 'table-row'])
type Scope = Document | ShadowRoot | Element

/** Partial prefixes are withheld before output clipping, so redaction sees complete text. */
export function componentText(source: Scope): string {
  const anchor = source instanceof Document ? source.body : source instanceof ShadowRoot ? source.host : source
  if (anchor === null) return ''
  for (let node: Element | null = anchor; node !== null; node = composedParent(node)) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.opacity === '0') return ''
  }
  const doc = source instanceof Document ? source : source.ownerDocument
  const chunks: string[] = [], seen = new Set<Node>()
  let chars = 0, nodes = 0, roots = 0, limited = false
  type Entry = { node?: Node; depth: number; visible?: boolean; newline?: true }
  const stack: Entry[] = [{ node: source, depth: 0 }]
  const append = (text: string): void => {
    chars += text.length
    if (chars > MAX_TEXT_CHARS) limited = true
    else chunks.push(text)
  }
  const children = (items: ArrayLike<Node>, depth: number, visible?: boolean): void => {
    for (let i = items.length - 1; i >= 0; i--) stack.push({ node: items[i]!, depth, visible })
  }
  while (stack.length > 0 && !limited) {
    const entry = stack.pop()!
    if (entry.newline) { append('\n'); continue }
    const node = entry.node!
    if (seen.has(node)) continue
    seen.add(node)
    if (++nodes > OPEN_TREE_LIMITS.elements) { limited = true; break }
    if (node instanceof ShadowRoot) {
      if (node.mode !== 'open' || entry.depth >= OPEN_TREE_LIMITS.depth || ++roots > OPEN_TREE_LIMITS.roots) { limited = true; break }
      const visible = entry.visible ?? getComputedStyle(node.host).visibility === 'visible'
      children(node.childNodes, entry.depth + 1, visible)
    } else if (node instanceof Document) {
      if (node.body !== null) stack.push({ node: node.body, depth: entry.depth })
    } else if (node instanceof Element) {
      if (OMIT.has(node.tagName)) continue
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.opacity === '0') continue
      const visible = style.visibility !== 'hidden' && style.visibility !== 'collapse'
      if (node.tagName === 'BR') { if (visible) append('\n'); continue }
      const block = BLOCK.has(style.display)
      if (block) { append('\n'); stack.push({ newline: true, depth: entry.depth }) }
      if (node.shadowRoot !== null) stack.push({ node: node.shadowRoot, depth: entry.depth, visible })
      else if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes()
        children(assigned.length === 0 ? node.childNodes : assigned, entry.depth, visible)
      } else children(node.childNodes, entry.depth, visible)
    } else if (node instanceof Text && entry.visible !== false) {
      const range = doc.createRange(); range.selectNodeContents(node)
      // jsdom has no Range layout API. Browsers must have a rendered text box.
      if (typeof range.getClientRects === 'function'
        && !Array.from(range.getClientRects()).some(rect => rect.width > 0 && rect.height > 0)) continue
      append(node.data)
    }
  }
  if (limited) return '[Component text withheld: traversal or character limit reached.]'
  const text = chunks.join('').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return redactSensitivePageText(anchor, text)
}
