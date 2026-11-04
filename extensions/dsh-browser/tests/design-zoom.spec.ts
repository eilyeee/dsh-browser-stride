// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeDesignZoom } from '../src/content/design-zoom.ts'
import { DesignZoomNotSelectedError } from '../src/content/design-zoom-error.ts'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
function fixture(html = '<label>Design zoom <select><option>27%</option><option>100%</option><option>150%</option></select></label>') {
  document.body.innerHTML = html
  for (const element of document.querySelectorAll('select')) vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 120, 30))
  return document.querySelector('select')!
}
describe('bounded design zoom control', () => {
  it('changes one labelled select, emits its page events and reads back; repeated same scale emits nothing', () => {
    const control = fixture(), change = vi.fn()
    control.addEventListener('change', change)
    expect(changeDesignZoom(150)()).toEqual({ before: 27, percent: 150, changed: true })
    expect(change).toHaveBeenCalledOnce()
    expect(changeDesignZoom(150)()).toEqual({ before: 150, percent: 150, changed: false })
    expect(change).toHaveBeenCalledOnce()
  })
  it.each([undefined, NaN, 99, 201, '150'])('refuses invalid percent %s before any mutation', value => {
    const control = fixture(), change = vi.fn(); control.addEventListener('change', change)
    expect(() => changeDesignZoom(value)).toThrow()
    expect(change).not.toHaveBeenCalled()
    expect(control.selectedIndex).toBe(0)
  })
  it('refuses missing, ambiguous, disabled, unrelated and unavailable percentage choices', () => {
    for (const html of [
      '<output>27%</output>',
      '<select aria-label="Opacity"><option>27%</option><option>150%</option></select>',
      '<select disabled aria-label="Zoom"><option>27%</option><option>150%</option></select>',
      '<select aria-label="Zoom"><option>Fit</option><option>150%</option></select>',
      '<select aria-label="Zoom"><option>27%</option><option>120%</option></select>',
      '<select aria-label="Zoom"><option>27%</option><option disabled>150%</option></select>',
      '<select aria-label="Zoom"><option>27%</option><option>150%</option><option>150%</option></select>',
      '<select aria-label="Zoom"><option>27%</option><option>150%</option></select><select aria-label="Zoom"><option>27%</option><option>150%</option></select>',
    ]) { fixture(html); expect(() => changeDesignZoom(150)).toThrow(DesignZoomNotSelectedError) }
  })
  it('refuses ignored or replaced controls instead of retrying the change', () => {
    const control = fixture()
    control.addEventListener('change', () => { control.selectedIndex = 0 })
    expect(() => changeDesignZoom(150)()).toThrow('readback')
    try { changeDesignZoom(150)() } catch (error) { expect(error).not.toBeInstanceOf(DesignZoomNotSelectedError) }
    fixture(); const readback = changeDesignZoom(150); document.body.replaceChildren()
    expect(readback).toThrow('readback')
  })
})
