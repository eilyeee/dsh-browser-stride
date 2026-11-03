// @vitest-environment jsdom
// Each point test owns a native jsdom Window, independent from Vitest’s proxy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis } }
import { VisualViewportState } from '../src/content/visual.ts'

let state: VisualViewportState
let dom: InstanceType<typeof JSDOM>
beforeEach(() => {
  dom = new JSDOM('<!doctype html><canvas></canvas><aside></aside>', { url: 'https://example.test/' })
  const page = dom.window
  for (const key of ['window', 'document', 'Element', 'Event', 'MouseEvent', 'MutationObserver', 'location'] as const) vi.stubGlobal(key, page[key])
  state = new VisualViewportState()
  vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('scrollX', 0); vi.stubGlobal('scrollY', 0); vi.stubGlobal('devicePixelRatio', 2)
  vi.stubGlobal('PointerEvent', page.MouseEvent)
  document.body.innerHTML = '<canvas></canvas><aside></aside>'
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn() })
})
afterEach(() => { state.dispose(); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('viewport-bound canvas points', () => {
  it('works on plain HTTP without randomUUID and ignores observation-number attributes', () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto)
    vi.stubGlobal('crypto', { getRandomValues })
    const observed = state.capture()
    expect(observed.screenshotRef).toMatch(/^shot_[a-f0-9-]{36}$/)
    document.querySelector('canvas')!.setAttribute('data-dsh-el', '1')
    expect(state.check(observed.screenshotRef).screenshotRef).toBe(observed.screenshotRef)
  })
  it('selects a canvas layer using complete-image fractions and consumes the screenshot', () => {
    const canvas = document.querySelector('canvas')!
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(canvas)
    const points: Array<[number, number, boolean]> = []
    canvas.addEventListener('pointerdown', event => {
      const pointer = event as PointerEvent
      points.push([pointer.clientX, pointer.clientY, event.isTrusted])
      document.querySelector('aside')!.textContent = 'Synthetic layer: radius 12px; color #2563eb'
    })
    const observed = state.capture()
    state.click(observed.screenshotRef, 0.4, 0.25)
    expect(points).toEqual([[400, 200, false]])
    expect(document.querySelector('aside')?.textContent).toContain('radius 12px')
    expect(() => state.click(observed.screenshotRef, 0.4, 0.25)).toThrow('stale')
  })

  it.each(['scroll', 'resize', 'wheel', 'pointerdown', 'click', 'input', 'change', 'keydown', 'pagehide', 'hashchange'])('rejects a point after %s', event => {
    const observed = state.capture()
    window.dispatchEvent(new Event(event))
    expect(() => state.check(observed.screenshotRef)).toThrow('stale')
  })

  it('rejects pending DOM changes, viewport-size changes and superseded refs', () => {
    const old = state.capture(), fresh = state.capture()
    expect(() => state.check(old.screenshotRef)).toThrow('stale')
    const afterOld = state.capture()
    document.querySelector('canvas')!.setAttribute('width', '600')
    expect(() => state.check(afterOld.screenshotRef)).toThrow('stale')
    const resized = state.capture()
    vi.stubGlobal('innerWidth', 900)
    expect(() => state.check(resized.screenshotRef)).toThrow('stale')
    expect(fresh.screenshotRef).not.toBe(old.screenshotRef)
  })

  it.each([[1, 0], [-1, 0], [0, Infinity], [0, NaN]])('rejects out-of-image point %s, %s', (x, y) => {
    const observed = state.capture()
    expect(() => state.click(observed.screenshotRef, x, y)).toThrow('fractions')
  })

  it('does not turn a main-page screenshot into iframe click authority', () => {
    const iframe = document.createElement('iframe'); document.body.append(iframe)
    const observed = state.capture(), click = vi.fn(); iframe.addEventListener('click', click)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(iframe)
    expect(() => state.click(observed.screenshotRef, 0.5, 0.5)).toThrow('main-document')
    expect(click).not.toHaveBeenCalled()
  })

  it('stops a gesture whose target moves during a page-authored event', () => {
    const canvas = document.querySelector('canvas')!, click = vi.fn()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(canvas)
    canvas.addEventListener('pointerdown', () => vi.stubGlobal('scrollY', 100))
    canvas.addEventListener('click', click)
    const observed = state.capture()
    expect(() => state.click(observed.screenshotRef, 0.5, 0.5)).toThrow('uncertain')
    expect(click).not.toHaveBeenCalled()
  })
})
