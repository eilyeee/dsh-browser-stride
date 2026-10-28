// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetDeltaState, runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { observedRef } from './observed-ref.ts'

const budget = { maxItems: 20, maxForms: 10, maxChars: 4_000 }
afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('observation-bound targets', () => {
  it('rejects bare indices and references from an older observation even for the same element', async () => {
    document.body.innerHTML = '<button>Save</button>'
    const button = document.querySelector('button')!
    button.scrollIntoView = vi.fn()
    const click = vi.spyOn(button, 'click')
    const ids = new ElementIds()
    const first = await runAction('browser_snapshot', {}, { ids, budget })
    const oldRef = observedRef(first, ids, button)
    const second = await runAction('browser_snapshot', {}, { ids, budget })
    const newRef = observedRef(second, ids, button)
    expect(newRef).not.toBe(oldRef)
    await expect(runAction('browser_click', { index: ids.indexOf(button) }, { ids, budget })).rejects.toThrow('element reference')
    await expect(runAction('browser_click', { elementRef: oldRef }, { ids, budget })).rejects.toThrow('stale')
    expect(click).not.toHaveBeenCalled()
    await runAction('browser_click', { elementRef: newRef }, { ids, budget })
    expect(click).toHaveBeenCalledOnce()
  })

  it('does not accept a guessed reference for a control omitted by the inventory cap', async () => {
    document.body.innerHTML = '<button>Shown</button><button>Omitted</button>'
    const [shown, omitted] = document.querySelectorAll('button')
    const click = vi.spyOn(omitted!, 'click')
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget: { ...budget, maxItems: 1 } })
    const ref = observedRef(snapshot, ids, shown!)
    const guessed = `${ref.slice(0, ref.lastIndexOf(':'))}:${ids.indexOf(omitted!)}`
    await expect(runAction('browser_click', { elementRef: guessed }, { ids, budget })).rejects.toThrow('not fully shown')
    expect(click).not.toHaveBeenCalled()
  })

  it('requires the full select option line, even if the control itself was shown', async () => {
    document.body.innerHTML = '<select aria-label="Size"><option>Small</option><option>Large</option></select>'
    const select = document.querySelector('select')!
    const ids = new ElementIds()
    const full = await runAction('browser_snapshot', {}, { ids, budget })
    const cap = full.text.indexOf('Form fields:') + 65
    const truncated = await runAction('browser_snapshot', {}, { ids, budget: { ...budget, maxChars: cap } })
    const ref = observedRef(truncated, ids, select)
    expect(truncated.text).toContain('truncated')
    await expect(runAction('browser_select', { elementRef: ref, optionIndex: 1 }, { ids, budget })).rejects.toThrow('not fully shown')
    expect(select.selectedIndex).toBe(0)
  })

  it('does not reuse a reference in another frame or after a same-document URL change', async () => {
    document.body.innerHTML = '<button>Continue</button>'
    const button = document.querySelector('button')!
    const click = vi.spyOn(button, 'click')
    const frameA = new ElementIds()
    const frameB = new ElementIds()
    const a = await runAction('browser_snapshot', {}, { ids: frameA, budget })
    const refA = observedRef(a, frameA, button)
    await runAction('browser_snapshot', {}, { ids: frameB, budget })
    await expect(runAction('browser_click', { elementRef: refA }, { ids: frameB, budget })).rejects.toThrow('stale')
    history.pushState(null, '', '/different-record')
    await expect(runAction('browser_click', { elementRef: refA }, { ids: frameA, budget })).rejects.toThrow('stale')
    expect(click).not.toHaveBeenCalled()
    const fresh = await runAction('browser_snapshot', { delta: true }, { ids: frameA, budget })
    expect(fresh.text).toContain('Interactive elements:')
  })

  it('invalidates refs at lifecycle reset and returns a full first delta snapshot', async () => {
    document.body.innerHTML = '<button>Continue</button>'
    const button = document.querySelector('button')!
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const ref = observedRef(snapshot, ids, button)
    resetDeltaState(ids)
    await expect(runAction('browser_click', { elementRef: ref }, { ids, budget })).rejects.toThrow('stale')
    const restored = await runAction('browser_snapshot', { delta: true }, { ids, budget })
    expect(restored.text).toContain('Interactive elements:')
    expect(observedRef(restored, ids, button)).not.toBe(ref)
  })

  it('rechecks the target after a synchronous scroll handler changes its meaning', async () => {
    document.body.innerHTML = '<button>Save</button>'
    const button = document.querySelector('button')!
    button.scrollIntoView = () => { button.textContent = 'Delete' }
    const click = vi.spyOn(button, 'click')
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    await expect(runAction('browser_click', { elementRef: observedRef(snapshot, ids, button) }, { ids, budget })).rejects.toThrow('changed')
    expect(click).not.toHaveBeenCalled()
  })

  it('refuses a control whose ancestor has become transparent', async () => {
    document.body.innerHTML = '<section><button>Save</button></section>'
    const button = document.querySelector('button')!
    const click = vi.spyOn(button, 'click')
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const ref = observedRef(snapshot, ids, button)
    document.querySelector('section')!.style.opacity = '0'
    await expect(runAction('browser_click', { elementRef: ref }, { ids, budget })).rejects.toThrow('not actionable')
    expect(click).not.toHaveBeenCalled()
  })

  it('detects a semantic change beyond the shortened snapshot label', async () => {
    document.body.innerHTML = `<button>${'x'.repeat(100)} save</button>`
    const button = document.querySelector('button')!
    const click = vi.spyOn(button, 'click')
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const ref = observedRef(snapshot, ids, button)
    button.textContent = `${'x'.repeat(100)} delete`
    await expect(runAction('browser_click', { elementRef: ref }, { ids, budget })).rejects.toThrow('changed')
    expect(click).not.toHaveBeenCalled()
  })

  it('rejects a button when its form submission destination changes', async () => {
    document.body.innerHTML = '<form action="/draft" method="post"><button>Save</button></form>'
    const button = document.querySelector('button')!
    const click = vi.spyOn(button, 'click')
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const ref = observedRef(snapshot, ids, button)
    document.querySelector('form')!.action = '/different-record'
    await expect(runAction('browser_click', { elementRef: ref }, { ids, budget })).rejects.toThrow('changed')
    expect(click).not.toHaveBeenCalled()
  })

  it('rejects a relative link when a new base URL changes its actual destination', async () => {
    document.body.innerHTML = '<a href="orders">Orders</a>'
    const link = document.querySelector('a')!
    const click = vi.spyOn(link, 'click')
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const ref = observedRef(snapshot, ids, link)
    const base = document.createElement('base')
    base.href = 'https://other.example/'
    document.head.append(base)
    try {
      await expect(runAction('browser_click', { elementRef: ref }, { ids, budget })).rejects.toThrow('changed')
      expect(click).not.toHaveBeenCalled()
    } finally {
      base.remove()
    }
  })

  it('rejects a submit control whose submitted value changed behind the same label', async () => {
    document.body.innerHTML = '<form><input type="submit" aria-label="Submit" value="save"></form>'
    const input = document.querySelector('input')!
    const click = vi.spyOn(input, 'click')
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const ref = observedRef(snapshot, ids, input)
    input.value = 'delete'
    await expect(runAction('browser_click', { elementRef: ref }, { ids, budget })).rejects.toThrow('changed')
    expect(click).not.toHaveBeenCalled()
  })

  it('does not activate a scheduled native link after its destination changes', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<a href="https://example.com/draft" rel="noreferrer">Open</a>'
    const link = document.querySelector('a')!
    link.scrollIntoView = vi.fn()
    const click = vi.spyOn(link, 'click').mockImplementation(() => {})
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const result = await runAction('browser_click', { elementRef: observedRef(snapshot, ids, link) }, { ids, budget })
    expect(result.text).toContain('not confirmed')
    link.href = 'https://example.com/other'
    await vi.advanceTimersByTimeAsync(0)
    expect(click).not.toHaveBeenCalled()
  })

  it('fails closed when a target identity exceeds its memory bound', async () => {
    document.body.innerHTML = `<button>${'x'.repeat(9_000)}</button>`
    const button = document.querySelector('button')!
    const click = vi.spyOn(button, 'click')
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const ref = observedRef(snapshot, ids, button)
    await expect(runAction('browser_click', { elementRef: ref }, { ids, budget })).rejects.toThrow('not actionable')
    expect(click).not.toHaveBeenCalled()
  })

  it('does not type into a rich-text control that changes when focused', async () => {
    document.body.innerHTML = '<div contenteditable="true" tabindex="0" aria-label="Editor"></div>'
    const editor = document.querySelector('div')!
    editor.addEventListener('focus', () => { editor.setAttribute('aria-label', 'Different editor') })
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const elementRef = observedRef(snapshot, ids, editor)
    const result = await runAction('browser_type', { elementRef, text: 'private text' }, { ids, budget })
    expect(editor.textContent).toBe('')
    expect(result.text).toContain('may have partially changed')
    expect(result.text).not.toContain('private text')
  })
})
