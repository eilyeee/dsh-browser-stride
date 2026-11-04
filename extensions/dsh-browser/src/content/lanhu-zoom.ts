import { isVisible } from './extract.ts'
import type { DesignZoomStep } from '../design-zoom-step.ts'
import { makeObservationId } from '@eilyeee/dsh-browser-stride/src/contracts/ids.ts'

const ownerSelector = '#detail_container .operation-wrap .operation-center .choose_size_box .choose_size'
const menuSelector = '.mu-popover.percent-pop > .choose_dialog'
const ticketMs = 90_000
interface Pending extends DesignZoomStep {
  href: string
  expires: number
  owner: HTMLElement
  trigger: HTMLElement
  menu?: HTMLElement
  option?: HTMLElement
}
let pending: Pending | undefined
export function clearLanhuZoom(): void { pending = undefined }
const percentOf = (element: Element): number | undefined => {
  const match = element.textContent?.trim().match(/^(\d+(?:\.\d+)?)\s*%$/u)
  return match ? Number(match[1]) : undefined
}
const disabled = (element: HTMLElement) => element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' || element.classList.contains('disabled')
function requireForeground(): void {
  if (document.visibilityState !== 'visible') throw new Error('Bring the Lanhu design page to the foreground, then send a new message before preparing its zoom menu.')
}
function supportedPage(): boolean {
  return location.hostname === 'lanhuapp.com' && location.pathname === '/web/'
    && /^#\/item\/project\/detailDetach(?:[/?]|$)/u.test(location.hash)
}
function currentOwner(): { owner: HTMLElement; trigger: HTMLElement; before: number } {
  const owners = [...document.querySelectorAll<HTMLElement>(ownerSelector)].filter(isVisible)
  if (owners.length !== 1) throw new Error('No unique supported Lanhu zoom toolbar.')
  const owner = owners[0]!
  const controls = [...owner.querySelectorAll<HTMLElement>(':scope > mu-button')].filter(isVisible)
  if (controls.length !== 1 || disabled(controls[0]!)) throw new Error('The Lanhu zoom entry is unavailable.')
  const trigger = controls[0]!, before = percentOf(trigger)
  if (before === undefined || !Number.isFinite(before) || before < 0 || before > 1_000_000) throw new Error('Lanhu zoom percentage cannot be read.')
  return { owner, trigger, before }
}
function sameOwner(p: Pick<Pending, 'href' | 'owner' | 'trigger' | 'before'>): boolean {
  if (!supportedPage() || location.href !== p.href || !p.owner.isConnected || !p.trigger.isConnected) return false
  try { const now = currentOwner(); return now.owner === p.owner && now.trigger === p.trigger && now.before === p.before } catch { return false }
}
function menuFor(owner: HTMLElement, trigger: HTMLElement): HTMLElement | undefined {
  if (!owner.classList.contains('open')) return undefined
  const menus = [...document.querySelectorAll<HTMLElement>(menuSelector)]
    .filter(menu => isVisible(menu) && menu.parentElement !== null && isVisible(menu.parentElement))
  if (menus.length > 1) throw new Error('The Lanhu zoom menu is ambiguous.')
  const menu = menus[0]
  if (!menu) return undefined
  const box = menu.parentElement!.getBoundingClientRect(), anchor = trigger.getBoundingClientRect()
  if (Math.min(box.right, anchor.right) <= Math.max(box.left, anchor.left)
    || box.top < anchor.top - 8 || box.top > anchor.bottom + 80) throw new Error('The zoom popup is not anchored to the Lanhu toolbar.')
  return menu
}
function optionFor(menu: HTMLElement, percent: number): HTMLElement {
  const options = [...menu.querySelectorAll<HTMLElement>(':scope > .choose_item')]
    .filter(element => isVisible(element) && percentOf(element) === percent)
  if (options.length !== 1 || disabled(options[0]!)) throw new Error('The requested percentage is not a unique available Lanhu option.')
  return options[0]!
}
/** Open only; choosing the option requires a fresh guarded background dispatch. */
export async function prepareLanhuZoom(percent: unknown): Promise<DesignZoomStep | undefined> {
  clearLanhuZoom()
  if (!supportedPage()) return undefined
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 100 || percent > 200) throw new Error('Design zoom must be between 100 and 200 percent.')
  const current = currentOwner(), href = location.href
  let menu: HTMLElement | undefined, option: HTMLElement | undefined
  if (current.before !== percent) {
    requireForeground()
    menu = menuFor(current.owner, current.trigger)
    if (!menu) {
      const box = current.trigger.getBoundingClientRect()
      for (const target of [current.owner, current.trigger]) {
        if (!sameOwner({ ...current, href })) throw new Error('The Lanhu design changed before opening its zoom menu.')
        target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, relatedTarget: document.body }))
      }
    }
    const deadline = Date.now() + 1000
    for (;;) {
      if (!sameOwner({ ...current, href })) throw new Error('The Lanhu design changed while opening its zoom menu.')
      menu = menuFor(current.owner, current.trigger)
      if (menu) { option = optionFor(menu, percent); break }
      if (Date.now() >= deadline) throw new Error('The Lanhu zoom menu did not become available.')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const ticket = 'zoom_' + makeObservationId().slice(4)
  pending = { ...current, href, percent, ticket, expires: Date.now() + ticketMs,
    ...(menu ? { menu } : {}), ...(option ? { option } : {}) }
  return { ticket, before: current.before, percent }
}
/** A ticket only pins the observed DOM. It cannot grant page or Host authority. */
export function commitLanhuZoom(ticket: unknown, percent: unknown): () => { before: number; percent: number; changed: boolean } {
  const saved = pending
  pending = undefined // consume before any effect; a lost reply cannot replay it
  if (!saved || ticket !== saved.ticket || percent !== saved.percent || Date.now() >= saved.expires || !sameOwner(saved)) {
    throw new Error('The prepared Lanhu zoom step is stale or unavailable.')
  }
  if (saved.option !== undefined) {
    requireForeground()
    if (menuFor(saved.owner, saved.trigger) !== saved.menu || !saved.option.isConnected || optionFor(saved.menu!, saved.percent) !== saved.option) {
      throw new Error('The Lanhu zoom menu changed before selection.')
    }
    saved.option.click()
  }
  return () => {
    const now = currentOwner()
    if (location.href !== saved.href || now.owner !== saved.owner || now.trigger !== saved.trigger
      || now.before !== saved.percent) throw new Error('Lanhu zoom readback did not confirm the requested percentage.')
    return { before: saved.before, percent: saved.percent, changed: saved.before !== saved.percent }
  }
}
