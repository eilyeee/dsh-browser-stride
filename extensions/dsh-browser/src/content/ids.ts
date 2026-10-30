/**
 * Stable element numbering for the interactive inventory.
 *
 * Inventory numbers are internal slots; models use an observation-bound
 * reference, not a bare number. Slots survive re-snapshots only while the
 * element and its action identity survive. `data-dsh-el` attributes make the
 * numbering observable from the outside, but confer no authority.
 *
 * @module
 */

import { accessibleName, isVisible } from './extract.ts'
import { parseElementRef, type ObservationId } from '@eilyeee/dsh-browser-stride/src/contracts/ids.ts'

/** Attribute written on every inventoried element (observable numbering). */
const ID_ATTRIBUTE = 'data-dsh-el'
/** Only options represented in the snapshot can be selected by index. */
export const SELECT_OPTION_LIMIT = 20
const MAX_ACTION_IDENTITY_CHARS = 8_192

/**
 * Stable element → id registry. One instance per content-script lifetime.
 */
export class ElementIds {
  private readonly idByElement = new WeakMap<Element, number>()
  private readonly elementById = new Map<number, Element>()
  private readonly observedIdentity = new Map<number, string>()
  private observation?: { id: ObservationId; url: string; targets: Set<number>; selects: Set<number> }
  private nextId = 1

  /**
   * Reconcile the registry against the current element set: drop ids of
   * vanished elements, assign fresh ids to new ones.
   * @param elements - the current interactive inventory (document order).
   * @returns counts of added and removed elements.
   */
  assign(elements: Element[]): { added: number; removed: number } {
    const seen = new Set(elements)
    let removed = 0
    for (const [id, el] of this.elementById) {
      if (!seen.has(el)) {
        this.elementById.delete(id)
        this.observedIdentity.delete(id)
        this.idByElement.delete(el)
        removed += 1
      }
    }
    let added = 0
    for (const el of elements) {
      const previous = this.idByElement.get(el)
      const identity = actionIdentity(el)
      // A later snapshot must not silently make an old index authorize a
      // different semantic action on a reused DOM node.
      if (previous !== undefined && this.observedIdentity.get(previous) !== identity) {
        this.idByElement.delete(el)
        this.elementById.delete(previous)
        this.observedIdentity.delete(previous)
        removed += 1
      }
      if (!this.idByElement.has(el)) {
        const id = this.nextId
        this.nextId += 1
        this.idByElement.set(el, id)
        this.elementById.set(id, el)
        el.setAttribute(ID_ATTRIBUTE, String(id))
        added += 1
      }
      const id = this.idByElement.get(el)
      if (id !== undefined) {
        if (identity === undefined) this.observedIdentity.delete(id)
        else this.observedIdentity.set(id, identity)
      }
    }
    return { added, removed }
  }

  /**
   * Resolve an element's stable id.
   * @param el - element.
   * @returns the assigned id, or undefined when not inventoried.
   */
  indexOf(el: Element): number | undefined {
    return this.idByElement.get(el)
  }

  /**
   * Resolve an id to its element.
   * @param index - inventory number.
   * @returns the element, or undefined when stale or removed.
   */
  elementByIndex(index: number): Element | undefined {
    return this.elementById.get(index)
  }

  /** Record only controls whose complete representation was returned by this observation. */
  publishObservation(id: ObservationId, targets: Set<number>, selects: Set<number>): void {
    this.observation = { id, url: location.href, targets, selects }
  }

  /** Invalidate references on page lifecycle events and before navigation. */
  clearObservation(): void {
    this.observation = undefined
  }

  /** Resolve a reference only in the current observation and same document URL. */
  resolveReference(value: unknown, needsOptions = false): number | undefined {
    if (typeof value !== 'string') return undefined
    const parsed = parseElementRef(value)
    const observed = this.observation
    if (parsed === undefined || observed === undefined || parsed.observationId !== observed.id
      || location.href !== observed.url || !observed.targets.has(parsed.index)
      || (needsOptions && !observed.selects.has(parsed.index))) return undefined
    return parsed.index
  }

  /** Reject stale, detached, hidden, disabled or semantically changed targets. */
  isActionTargetCurrent(index: number): boolean {
    const el = this.elementById.get(index)
    const identity = this.observedIdentity.get(index)
    return el !== undefined && identity !== undefined && el.isConnected && isVisible(el)
      && ancestorsOpaque(el)
      && !el.matches(':disabled') && el.closest('[inert], [aria-disabled="true"]') === null
      && identity === actionIdentity(el)
  }
}

function ancestorsOpaque(el: Element): boolean {
  for (let parent = el.parentElement; parent !== null; parent = parent.parentElement) {
    if (getComputedStyle(parent).opacity === '0') return false
  }
  return true
}

function actionIdentity(el: Element): string | undefined {
  // Editable content is data, not the identity of an editor. In particular,
  // never put a password or typed form value into this fingerprint.
  const editable = el.hasAttribute('contenteditable')
  const form = el instanceof HTMLButtonElement || el instanceof HTMLInputElement
    || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.form : null
  const submitValue = el instanceof HTMLButtonElement
    || (el instanceof HTMLInputElement && ['button', 'submit', 'reset', 'image'].includes(el.type))
    ? el.value : null
  const identity = JSON.stringify([
    el.tagName, el.getAttribute('role'), el.getAttribute('type'), el.getAttribute('name'),
    el.getAttribute('href'), el instanceof HTMLAnchorElement ? [
      el.href, el.target, el.rel, el.getAttribute('download'), el.getAttribute('ping'),
      el.getAttribute('referrerpolicy'), el.getAttribute('attributionsrc'),
    ] : null,
    el.getAttribute('form'), el.getAttribute('formaction'), el.getAttribute('formmethod'),
    el.getAttribute('formenctype'), el.getAttribute('formtarget'), el.hasAttribute('formnovalidate'),
    form === null ? null : [form.action, form.method, form.enctype, form.target, form.noValidate],
    submitValue, el.getAttribute('aria-label'),
    el.getAttribute('aria-labelledby'), editable ? null : accessibleName(el, MAX_ACTION_IDENTITY_CHARS),
    el instanceof HTMLSelectElement ? [
      el.multiple, el.options.length,
      Array.from({ length: Math.min(el.options.length, SELECT_OPTION_LIMIT) }, (_, index) => el.options.item(index)!).map(option => [
        option.value, option.label, option.matches(':disabled'),
      ]),
    ] : null,
  ])
  // Never authorize an identity that had to be clipped to fit memory bounds.
  return identity.length <= MAX_ACTION_IDENTITY_CHARS ? identity : undefined
}
