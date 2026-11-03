/** Viewport-bound, single-use points for image/canvas pages. No page-world API. */
import type { VisualObservation } from '@eilyeee/dsh-browser-stride/src/visual.ts'
import { makeObservationId } from '@eilyeee/dsh-browser-stride/src/contracts/ids.ts'
const INVALIDATION_EVENTS = ['scroll', 'resize', 'wheel', 'pointermove', 'pointerdown', 'mousemove', 'mousedown', 'click', 'input', 'change', 'keydown', 'pagehide', 'popstate', 'hashchange'] as const
export class VisualViewportState {
  private observation?: VisualObservation
  private observer?: MutationObserver
  private watching = false
  private readonly invalidate = () => { this.observation = undefined }
  private relevant(records: MutationRecord[]): boolean {
    return records.some(record => record.type !== 'attributes' || record.attributeName !== 'data-dsh-el')
  }

  private viewport(): Omit<VisualObservation, 'screenshotRef'> {
    if (window.visualViewport !== null && window.visualViewport !== undefined && window.visualViewport.scale !== 1) {
      throw new Error('Reset pinch zoom before taking a browser screenshot.')
    }
    return { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio }
  }

  capture(): VisualObservation {
    if (!this.watching) {
      this.watching = true
      for (const name of INVALIDATION_EVENTS) {
        window.addEventListener(name, this.invalidate, true)
      }
      window.visualViewport?.addEventListener('resize', this.invalidate)
      window.visualViewport?.addEventListener('scroll', this.invalidate)
      this.observer = new MutationObserver(records => { if (this.relevant(records)) this.invalidate() })
      this.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    }
    this.observer?.takeRecords()
    const viewport = this.viewport()
    if (viewport.width < 1 || viewport.height < 1 || viewport.width > 8192 || viewport.height > 8192) {
      throw new Error('The viewport is outside the supported screenshot dimensions.')
    }
    // Reuse the secure HTTP-compatible nonce generator; randomUUID is absent
    // in non-secure page worlds even though getRandomValues is available.
    this.observation = { screenshotRef: `shot_${makeObservationId().slice(4)}`, ...viewport }
    return { ...this.observation }
  }

  check(ref: unknown): VisualObservation {
    if (this.relevant(this.observer?.takeRecords() ?? [])) this.invalidate()
    const observed = this.observation
    const viewport = this.viewport()
    if (typeof ref !== 'string' || observed?.screenshotRef !== ref
      || Object.entries(viewport).some(([key, value]) => observed[key as keyof typeof viewport] !== value)) {
      this.invalidate()
      throw new Error('The screenshot is stale. Take browser_screenshot again before a coordinate click.')
    }
    return { ...observed }
  }

  /** Fractions keep points correct if the Host/model resizes the complete image. */
  click(ref: unknown, x: unknown, y: unknown): void {
    const observed = this.check(ref)
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x >= 1
      || typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y >= 1) {
      throw new Error('x and y must be fractions from 0 inclusive to 1 exclusive.')
    }
    const clientX = x * observed.width, clientY = y * observed.height
    let element = document.elementFromPoint(clientX, clientY)
    while (element?.shadowRoot !== null && element?.shadowRoot !== undefined) {
      const inner = element.shadowRoot.elementFromPoint?.(clientX, clientY)
      if (inner === null || inner === undefined || inner === element) break
      element = inner
    }
    if (!(element instanceof Element) || element.closest('iframe,frame') !== null) {
      throw new Error('The point is not in an accessible main-document element. Use frame-aware DOM tools for iframes.')
    }
    // Fix one actual element before events; never re-hit-test into an iframe or
    // a replacement element between page-authored event handlers.
    this.invalidate()
    const initialUrl = location.href
    const target = element
    const rect = target.getBoundingClientRect()
    const current = () => target.isConnected && location.href === initialUrl
      && Object.entries(this.viewport()).every(([key, value]) => observed[key as keyof typeof observed] === value)
      && ['x', 'y', 'width', 'height'].every(key => target.getBoundingClientRect()[key as keyof DOMRect] === rect[key as keyof DOMRect])
    const base = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, view: document.defaultView }
    for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      if (!current()) throw new Error('The coordinate target changed during page events; its result is uncertain. Re-observe before another action.')
      const pressed = type === 'pointerdown' || type === 'mousedown'
      target.dispatchEvent(type.startsWith('pointer')
        ? new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: pressed ? 1 : 0 })
        : new MouseEvent(type, { ...base, buttons: pressed ? 1 : 0 }))
    }
  }

  dispose(): void {
    this.invalidate()
    this.observer?.disconnect()
    for (const name of INVALIDATION_EVENTS) {
      window.removeEventListener(name, this.invalidate, true)
    }
    window.visualViewport?.removeEventListener('resize', this.invalidate)
    window.visualViewport?.removeEventListener('scroll', this.invalidate)
    this.watching = false
  }
}

export const visualViewportState = new VisualViewportState()
