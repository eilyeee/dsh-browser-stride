// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { observedRef } from './observed-ref.ts'

const budget = { maxItems: 30, maxForms: 20, maxChars: 8_000 }
const observation = (text: string): string => {
  const id = /^Observation: (obs_[a-f0-9-]+)/m.exec(text)?.[1]
  if (!id) throw Error('Missing observation header')
  return id
}
function fixture() {
  document.body.innerHTML = '<main>Requirement</main><section id="left">Same prose</section><section id="right">Same prose</section><button>Continue</button>'
  return { ids: new ElementIds(), budget }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); history.replaceState(null, '', '/') })

describe('explicit snapshot baselines', () => {
  it('returns a named delta only for the current fully rendered observation', async () => {
    const ctx = fixture(), first = await runAction('browser_snapshot', {}, ctx)
    document.querySelector('main')!.textContent = 'Updated requirement'
    const next = await runAction('browser_snapshot', { delta: true, baseObservationId: observation(first.text) }, ctx)
    expect(next.text).toContain('Page change'); expect(next.text).toContain('base: ' + observation(first.text))
    expect(next.text).toContain('Updated requirement')
  })
  it.each(['missing', 'superseded', 'foreign'])('returns full content for a %s baseline', async kind => {
    const ctx = fixture(), first = await runAction('browser_snapshot', {}, ctx)
    if (kind === 'superseded') await runAction('browser_snapshot', {}, ctx)
    const baseObservationId = kind === 'missing' ? undefined : kind === 'foreign' ? 'obs_foreign-frame' : observation(first.text)
    const next = await runAction('browser_snapshot', { delta: true, baseObservationId }, ctx)
    expect(next.text).not.toContain('Page change'); expect(next.text).toContain('Main content:')
    expect(next.text).toContain('Interactive elements:'); expect(next.text).toContain('Delta unavailable')
  })
  it('can chain deltas when each named baseline was actually rendered', async () => {
    const ctx = fixture(), first = await runAction('browser_snapshot', {}, ctx)
    const second = await runAction('browser_snapshot', { delta: true, baseObservationId: observation(first.text) }, ctx)
    const third = await runAction('browser_snapshot', { delta: true, baseObservationId: observation(second.text) }, ctx)
    expect(third.text).toContain('base: ' + observation(second.text)); expect(third.text).toContain('No visible changes')
  })
  it('returns full content when the main-text selector changes even if the prose matches', async () => {
    const ctx = fixture(), first = await runAction('browser_snapshot', { region: '#left' }, ctx)
    const next = await runAction('browser_snapshot', { delta: true, baseObservationId: observation(first.text), region: '#right' }, ctx)
    expect(next.text).not.toContain('Page change'); expect(next.text).toContain('Main content:\nSame prose')
  })
  it('returns full content when the same region selector now resolves to a replacement node', async () => {
    const ctx = fixture(), first = await runAction('browser_snapshot', { region: '#left' }, ctx)
    document.querySelector('#left')!.outerHTML = '<section id="left">Same prose</section>'
    const next = await runAction('browser_snapshot', { delta: true, baseObservationId: observation(first.text), region: '#left' }, ctx)
    expect(next.text).not.toContain('Page change'); expect(next.text).toContain('Main content:')
  })
  it('keeps a delta for the same live region and budget', async () => {
    const ctx = fixture(), first = await runAction('browser_snapshot', { region: '#left' }, ctx)
    document.querySelector('#left')!.textContent = 'New region requirement'
    const next = await runAction('browser_snapshot', { delta: true, baseObservationId: observation(first.text), region: '#left' }, ctx)
    expect(next.text).toContain('Page change'); expect(next.text).toContain('New region requirement')
  })
  it.each(['maxItems', 'maxForms', 'maxChars'] as const)('starts a full view after the %s budget changes', async key => {
    const ctx = fixture(), first = await runAction('browser_snapshot', {}, ctx)
    const next = await runAction('browser_snapshot', { delta: true, baseObservationId: observation(first.text) }, { ...ctx, budget: { ...budget, [key]: budget[key] + 1 } })
    expect(next.text).not.toContain('Page change'); expect(next.text).toContain('Main content:')
  })
  it('does not diff against an internal view whose previous render was clipped', async () => {
    const ctx = fixture(); ctx.budget = { ...budget, maxChars: 1_500 }
    document.body.innerHTML += '<button>Long inventory label</button>'.repeat(40)
    const first = await runAction('browser_snapshot', {}, ctx); expect(first.text).toContain('truncated')
    const next = await runAction('browser_snapshot', { delta: true, baseObservationId: observation(first.text) }, ctx)
    expect(next.text).not.toContain('Page change'); expect(next.text).toContain('previous-render-clipped')
    expect(next.text.length).toBeLessThanOrEqual(ctx.budget.maxChars)
  })
  it.each([null, 3, '', 'x'.repeat(201)])('refuses invalid baseline data without replacing the current observation', async baseObservationId => {
    const ctx = fixture(), first = await runAction('browser_snapshot', {}, ctx), button = document.querySelector('button')!
    const ref = observedRef(first, ctx.ids, button)
    await expect(runAction('browser_snapshot', { delta: true, baseObservationId }, ctx)).rejects.toMatchObject({ code: 'bad-args' })
    expect(ctx.ids.resolveReference(ref)).toBeDefined()
  })
  it.each(['[', 'section', 'x'.repeat(501)])('refuses an invalid or ambiguous region before publishing another observation: %s', async region => {
    const ctx = fixture(), first = await runAction('browser_snapshot', {}, ctx), button = document.querySelector('button')!
    const ref = observedRef(first, ctx.ids, button)
    await expect(runAction('browser_snapshot', { region }, ctx)).rejects.toThrow()
    expect(ctx.ids.resolveReference(ref)).toBeDefined()
  })
})

describe('action feedback baselines', () => {
  it('returns a full observation for an unanchored wait', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const ctx = { ...fixture(), includePageDelta: true }; await runAction('browser_snapshot', {}, ctx)
    const pending = runAction('browser_wait', {}, ctx); await vi.advanceTimersByTimeAsync(100)
    const next = await pending
    expect(next.pageContent).not.toContain('Page change'); expect(next.pageContent).toContain('Main content:')
  })
  it('does not use another observation published while a click was settling as an implicit base', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const ctx = { ...fixture(), includePageDelta: true }, button = document.querySelector('button')!; button.scrollIntoView = vi.fn()
    const first = await runAction('browser_snapshot', {}, ctx)
    const pending = runAction('browser_click', { elementRef: observedRef(first, ctx.ids, button) }, ctx)
    await runAction('browser_snapshot', {}, ctx); await vi.advanceTimersByTimeAsync(100)
    const next = await pending
    expect(next.pageContent).not.toContain('Page change'); expect(next.pageContent).toContain('Interactive elements:')
  })
  it('does not reuse the unseen part of a clipped automatic response in a later delta', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const ctx = { ...fixture(), budget: { ...budget, maxItems: 60 }, includePageDelta: true }, button = document.querySelector('button')!; button.scrollIntoView = vi.fn()
    button.onclick = () => { document.body.insertAdjacentHTML('beforeend', '<button>Extra long inventory control label</button>'.repeat(100)) }
    const first = await runAction('browser_snapshot', {}, ctx)
    const pending = runAction('browser_click', { elementRef: observedRef(first, ctx.ids, button) }, ctx); await vi.advanceTimersByTimeAsync(100)
    const result = await pending; expect(result.pageContent).toContain('truncated')
    const next = await runAction('browser_snapshot', { delta: true, baseObservationId: observation(result.pageContent!) }, ctx)
    expect(next.text).not.toContain('Page change'); expect(next.text).toContain('previous-render-clipped')
  })
})
