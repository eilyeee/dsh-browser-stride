// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, renderSnapshot, renderSnapshotDetails } from '../src/content/snapshot.ts'
import { readFormControlState, renderFormControlState } from '../src/content/form-control-state.ts'

const budget = { maxItems: 30, maxForms: 30, maxChars: 12000 }
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })
describe('passive form control state', () => {
  it('reports explicit false flags and numeric declarations on a framework text spinbutton', () => {
    document.body.innerHTML = '<input role="spinbutton" aria-label="Minutes" min="1" max="10" value="">'
    const view = buildSnapshot(new ElementIds(), { budget }, null)
    expect(view.forms[0]?.controlState).toMatchObject({ disabled: false, readOnly: false, nativeRequired: false })
    const text = renderSnapshot(view, false)
    expect(text).toContain('dom-state(disabled=false,readonly=false,native-required=false)')
    expect(text).toContain('numeric-attributes(min=1,max=10,step=absent,aria-min=absent,aria-max=absent)')
    expect(text).toContain('not action permission or framework/server validation')
  })
  it('uses the existing disabled/inert and readonly boundaries, including fieldset legend exceptions', () => {
    document.body.innerHTML = '<fieldset disabled><legend><input id="legend"></legend><input id="blocked" required readonly></fieldset><div inert><textarea id="inert"></textarea></div>'
    const state = (id: string) => readFormControlState(document.getElementById(id) as HTMLInputElement)
    expect(state('legend').disabled).toBe(false)
    expect(state('blocked')).toMatchObject({ disabled: true, readOnly: true, nativeRequired: true })
    expect(state('inert')).toMatchObject({ disabled: true, numeric: { state: 'not-input' } })
  })
  it('observes native fields in open roots and composed readonly ancestors', () => {
    document.body.innerHTML = '<div id="host" aria-disabled="true" aria-readonly="true"></div>'
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<input type="number" aria-label="Nested" aria-valuemin="-2.5" aria-valuemax="8e1">'
    const view = buildSnapshot(new ElementIds(), { budget }, null)
    expect(view.forms[0]?.controlState).toMatchObject({ disabled: true, readOnly: true,
      numeric: { ariaMin: { state: 'declared', value: -2.5 }, ariaMax: { state: 'declared', value: 80 } } })
  })
  it('distinguishes absent declarations from unusable/non-numeric ones without echoing arbitrary values', () => {
    document.body.innerHTML = '<input type="text"><input type="date" min="2026-11-17" max="Bearer synthetic-private" step="0">'
    const [plain, malformed] = [...document.querySelectorAll('input')]
    expect(renderFormControlState(readFormControlState(plain!))).toContain('numeric-attributes=absent')
    const text = renderFormControlState(readFormControlState(malformed!))
    expect(text).toContain('min=unusable,max=unusable,step=unusable')
    expect(text).not.toContain('synthetic-private')
    expect(text).not.toContain('2026-11-17')
    malformed!.setAttribute('min', '1e309'); malformed!.setAttribute('max', '9'.repeat(10000)); malformed!.setAttribute('step', 'ANY')
    expect(renderFormControlState(readFormControlState(malformed!))).toContain('min=unusable,max=unusable,step=any')
  })
  it('does not read or expose numeric declarations from recognized sensitive fields', () => {
    document.body.innerHTML = '<input type="password" value="synthetic-password" min="7319" max="9999">'
    const field = document.querySelector('input')!, original = field.getAttribute.bind(field)
    vi.spyOn(field, 'getAttribute').mockImplementation(name => {
      if (['min', 'max', 'step', 'aria-valuemin', 'aria-valuemax'].includes(name)) throw Error('Sensitive attribute read')
      return original(name)
    })
    const text = renderSnapshot(buildSnapshot(new ElementIds(), { budget }, null), false)
    expect(text).toContain('numeric-attributes=masked')
    expect(text).not.toContain('7319'); expect(text).not.toContain('9999'); expect(text).not.toContain('synthetic-password')
  })
  it('never invokes validation or input events and does not expose framework error text or patterns', () => {
    document.body.innerHTML = '<input type="number" min="3" max="9" step="2" value="4" required pattern="synthetic-private-pattern">'
    const field = document.querySelector('input')!, events: string[] = []
    for (const type of ['invalid', 'input', 'change', 'focus']) field.addEventListener(type, () => events.push(type))
    field.setCustomValidity('synthetic-private-validation')
    const check = vi.spyOn(field, 'checkValidity'), report = vi.spyOn(field, 'reportValidity')
    const view = buildSnapshot(new ElementIds(), { budget }, null), text = renderSnapshot(view, false)
    expect(text).toContain('native-constraints=invalid(')
    expect(text).not.toContain('synthetic-private-validation'); expect(text).not.toContain('synthetic-private-pattern')
    expect(check).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled(); expect(events).toEqual([])
    expect(field.value).toBe('4')
  })
  it('includes declaration-only and disabled-state changes in deltas without renumbering controls', () => {
    document.body.innerHTML = '<input aria-label="Count" min="1" max="10">'
    const field = document.querySelector('input')!, ids = new ElementIds(), first = buildSnapshot(ids, { budget }, null)
    field.min = '2'
    const second = buildSnapshot(ids, { budget, delta: true }, first)
    expect(second.changed).toContain(ids.indexOf(field)); expect(second.reindexed).toBe(false)
    expect(renderSnapshot(second, true)).toContain('numeric-attributes(min=2,max=10')
    field.disabled = true
    const third = buildSnapshot(ids, { budget, delta: true }, second)
    expect(third.changed).toContain(ids.indexOf(field)); expect(renderSnapshot(third, true)).toContain('dom-state(disabled=true')
  })
  it('keeps the character cap and does not authorize references whose complete lines were clipped', () => {
    document.body.innerHTML = '<select aria-label="Choice"><option>A</option><option>B</option></select>'
    const view = buildSnapshot(new ElementIds(), { budget }, null)
    const full = renderSnapshot(view, false), index = full.indexOf('dom-state(')
    const rendered = renderSnapshotDetails(view, false, index + 15)
    expect(rendered.text.length).toBeLessThanOrEqual(index + 15)
    expect(rendered.renderComplete).toBe(false)
    // Its full inventory line remains readable, but the clipped form line
    // cannot independently admit a new reference.
    expect(renderSnapshotDetails(view, false).selects.has(view.forms[0]!.index)).toBe(true)
    expect(rendered.targets.has(view.forms[0]!.index)).toBe(true)
    expect(rendered.selects.has(view.forms[0]!.index)).toBe(false)
    expect(renderFormControlState(undefined)).toBe('dom-state=unreported')
  })
})
