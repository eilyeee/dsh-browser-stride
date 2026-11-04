// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureLayout } from '../src/content/layout.ts'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
function box(selector: string, left: number, top: number, width: number, height: number) {
  const element = document.querySelector(selector)!
  const rect = new DOMRect(left, top, width, height)
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect)
  vi.spyOn(element, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList)
  return element
}

describe('read-only DOM layout observations', () => {
  it('uses actual boxes for gaps and keeps computed spacing separate', () => {
    document.body.innerHTML = '<section class="hero"></section><section class="card" style="margin-top:50px;padding:20px;border:1px solid"></section>'
    box('.hero', 0, 0, 600, 80); box('.card', 100, 80, 400, 120)
    const report = measureLayout({ selector: '.card', referenceSelector: '.hero' })
    expect(report.units).toBe('CSS pixels')
    expect(report.target.css.margin.top).toBe('50px')
    expect(report.target.css.padding.top).toBe('20px')
    expect(report.target.css.border.top).toBe('1px')
    expect(report.comparison).toMatchObject({ verticalOrder: 'below', verticalGap: 0, horizontalGap: null })
  })

  it('measures separation in both directions and distinguishes overlapping or unaligned boxes', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>'
    box('#a', 0, 0, 100, 20);box('#b', 0, 70, 100, 30)
    expect(measureLayout({ selector: '#b', referenceSelector: '#a' }).comparison).toMatchObject({ verticalOrder: 'below', verticalGap: 50 })
    expect(measureLayout({ selector: '#a', referenceSelector: '#b' }).comparison).toMatchObject({ verticalOrder: 'above', verticalGap: 50 })
    box('#b', 150, 0, 100, 20)
    expect(measureLayout({ selector: '#b', referenceSelector: '#a' }).comparison).toMatchObject({ horizontalOrder: 'right', horizontalGap: 50, verticalGap: null })
    box('#b', 150, 70, 100, 20)
    expect(measureLayout({ selector: '#b', referenceSelector: '#a' }).comparison).toMatchObject({ horizontalGap: null, verticalGap: null })
    box('#b', 50, 10, 100, 20)
    expect(measureLayout({ selector: '#b', referenceSelector: '#a' }).comparison).toMatchObject({ overlapX: 50, overlapY: 10, horizontalGap: null, verticalGap: null })
  })

  it('reports border-box insets without claiming they equal CSS padding', () => {
    document.body.innerHTML = '<section id="parent" style="padding:20px;border:1px solid"><h2 id="child">Synthetic title</h2></section>'
    box('#parent', 10, 10, 200, 100);box('#child', 31, 31, 158, 30)
    const report = measureLayout({ selector: '#child', referenceSelector: '#parent' })
    expect(report.comparison).toMatchObject({ insideReference: true, verticalGap: null,
      insetsFromReferenceBorder: { top: 21, right: 21, bottom: 49, left: 21 } })
    expect(report.reference!.css.padding.top).toBe('20px')
    expect(measureLayout({ selector: '#child', referenceSelector: '#child' }).comparison).toMatchObject({ sameElement: true, verticalGap: null })
  })

  it('rejects missing, ambiguous, malformed and unrendered targets rather than fabricating zero', () => {
    document.body.innerHTML = '<div class="card"></div><div class="card"></div><div id="hidden" style="display:none"></div>'
    for (const selector of [undefined, '', ' '.repeat(2), 'x'.repeat(501), '[', '.absent', '.card', '#hidden']) {
      expect(() => measureLayout({ selector })).toThrow()
    }
    box('.card', 0, 0, 100, 20)
    expect(() => measureLayout({ selector: '.card:first-child', referenceSelector: '.absent' })).toThrow('0 elements')
  })

  it('does not read text, attributes or input values, and does not focus, scroll or modify the page', async () => {
    document.body.innerHTML = '<input id="field" type="password" value="synthetic-secret"><p id="note">Synthetic private text</p>'
    const element = box('#field', 20, 30, 100, 20)
    const focus = vi.spyOn(element as HTMLInputElement, 'focus')
    const before = document.body.innerHTML
    const result = await runAction('browser_measure_layout', { selector: '#field' }, {
      ids: new ElementIds(), budget: { maxChars: 2000, maxItems: 10, maxForms: 10 },
    })
    const report = JSON.parse(result.text)
    expect(report.target.rect.width).toBe(100)
    expect(result.text).not.toContain('synthetic-secret')
    expect(result.text).not.toContain('Synthetic private text')
    expect(document.body.innerHTML).toBe(before)
    expect(focus).not.toHaveBeenCalled()
  })

  it('refuses non-finite geometry and includes transform/visibility metadata for valid layout boxes', () => {
    document.body.innerHTML = '<div id="box" style="visibility:hidden;opacity:0;transform:scale(2)"></div>'
    box('#box', 10, 20, 100, 30)
    expect(measureLayout({ selector: '#box' }).target.css).toMatchObject({ visibility: 'hidden', opacity: '0', transform: 'scale(2)' })
    box('#box', Infinity, 0, 10, 10)
    expect(() => measureLayout({ selector: '#box' })).toThrow('range')
  })
})
