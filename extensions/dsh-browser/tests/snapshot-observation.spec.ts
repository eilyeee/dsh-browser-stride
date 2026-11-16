// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { contentObservationSchema } from '@eilyeee/dsh-browser-stride/src/snapshot-observation.ts'
import { resetDeltaState } from '../src/content/actions.ts'
import { watchNativeInput } from '../src/content/native-input.ts'

afterEach(() => { document.body.replaceChildren(); history.replaceState(null, '', '/') })
const context = () => ({ ids: new ElementIds(), budget: { maxItems: 30, maxForms: 20, maxChars: 8000 } })
describe('live snapshot coverage metadata', () => {
  it('requires a fresh observation for unanchored input and does not confuse synthetic events with native intervention', async () => {
    document.body.innerHTML = '<main>Requirement</main><button>Continue</button>'
    const ctx = { ...context(), requireObservation: true }
    await expect(runAction('browser_press', { key: 'Enter' }, ctx)).rejects.toMatchObject({ code: 'element-stale' })
    await runAction('browser_snapshot', {}, ctx)
    const dispose = watchNativeInput(ctx.ids)
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
      window.dispatchEvent(new MouseEvent('pointerdown'))
      expect(ctx.ids.hasCurrentObservation()).toBe(true)
      resetDeltaState(ctx.ids)
      await expect(runAction('browser_press', { key: 'Enter' }, ctx)).rejects.toMatchObject({ code: 'element-stale' })
    } finally { dispose() }
  })
  it('keeps a fully rendered small snapshot partial without pretending to cover canvas or closed roots', async () => {
    document.body.innerHTML = '<main>Requirement</main><button>Continue</button><canvas></canvas>'
    const result = await runAction('browser_snapshot', {}, context())
    const coverage = contentObservationSchema.parse(result.observation)
    expect(coverage).toMatchObject({ kind: 'snapshot', complete: false, renderComplete: true, textScope: 'main-text',
      omitted: { mainCharacters: 0, controls: 0, fields: 0, selectsWithOmittedOptions: 0, openTreeLimited: false } })
    expect(result.text).toContain(coverage.observationId)
    expect(contentObservationSchema.safeParse({ ...coverage, complete: true }).success).toBe(false)
  })
  it('reports actual collection omissions and rendering separately without copying field values into metadata', async () => {
    document.body.innerHTML = '<main>' + 'Long requirement '.repeat(1000) + '</main><input type="password" value="PRIVATE-VALUE">'
      + '<select>' + '<option>Option</option>'.repeat(120) + '</select>' + '<input value="ordinary">'.repeat(6) + '<button>Long control label</button>'.repeat(30)
    expect((document.querySelector('input[type=password]') as HTMLInputElement).value).toBe('PRIVATE-VALUE')
    const ctx = context(); ctx.budget = { maxItems: 4, maxForms: 3, maxChars: 1500 }
    const result = await runAction('browser_snapshot', {}, ctx), coverage = contentObservationSchema.parse(result.observation)
    expect(coverage.omitted.mainCharacters).toBeGreaterThan(0)
    expect(coverage.omitted.controls).toBeGreaterThan(0); expect(coverage.omitted.fields).toBeGreaterThan(0)
    expect(coverage.omitted.selectsWithOmittedOptions).toBe(1)
    expect(JSON.stringify(coverage)).not.toContain('PRIVATE-VALUE')
    expect(coverage.complete).toBe(false)
  })
  it('declares region text separately from the document control inventory and identifies the actual delta base', async () => {
    document.body.innerHTML = '<main>Outside requirement</main><section id="requirements">Scoped requirement</section><button>Outside control</button>'
    const ctx = context(), first = await runAction('browser_snapshot', { region: '#requirements' }, ctx)
    expect(first.observation?.textScope).toBe('region-text'); expect(first.text).toContain('Outside control')
    expect(first.text).not.toContain('Outside requirement')
    document.querySelector('#requirements')!.textContent = 'Updated scoped requirement'
    const next = await runAction('browser_snapshot', { region: '#requirements', delta: true, baseObservationId: first.observation!.observationId }, ctx)
    expect(next.observation).toMatchObject({ kind: 'delta', baseObservationId: first.observation!.observationId, complete: false })
    expect(contentObservationSchema.safeParse(next.observation).success).toBe(true)
  })
})
