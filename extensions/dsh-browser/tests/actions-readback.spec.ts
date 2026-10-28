// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { observedRef } from './observed-ref.ts'

const budget = { maxItems: 20, maxForms: 10, maxChars: 2_000 }
afterEach(() => { document.body.replaceChildren() })

describe('basic form readback', () => {
  it('reports a reverted password field without revealing the entered value', async () => {
    document.body.innerHTML = '<input type="password" aria-label="Password">'
    const input = document.querySelector('input')!
    input.addEventListener('change', () => { input.value = '' })
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const result = await runAction('browser_type', { elementRef: observedRef(snapshot, ids, input), text: 'secret-test-value' }, { ids, budget })
    expect(input.value).toBe('')
    expect(result.text).toContain('could not be confirmed')
    expect(result.text).not.toContain('secret-test-value')
  })

  it('stops a replace operation when the target changes during its input event', async () => {
    document.body.innerHTML = '<input aria-label="Account" value="old">'
    const input = document.querySelector('input')!
    const change = vi.fn()
    input.addEventListener('input', () => { input.setAttribute('aria-label', 'Different account') })
    input.addEventListener('change', change)
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const elementRef = observedRef(snapshot, ids, input)
    const result = await runAction('browser_type', { elementRef, text: 'new-value', replace: true }, { ids, budget })
    expect(input.value).toBe('')
    expect(change).not.toHaveBeenCalled()
    expect(result.text).toContain('may have partially changed')
    expect(result.text).not.toContain('new-value')
    await expect(runAction('browser_type', { elementRef, text: 'new-value' }, { ids, budget })).rejects.toThrow('stale')
  })

  it('does not type into read-only fields or checkbox values', async () => {
    document.body.innerHTML = '<input aria-label="Locked" value="old" readonly><input aria-label="Agree" type="checkbox"><input aria-label="ARIA locked" value="old" aria-readonly="true">'
    const [locked, checkbox, ariaLocked] = document.querySelectorAll('input')
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    expect(snapshot.text).toContain('readonly')
    for (const input of [locked!, checkbox!, ariaLocked!]) {
      await expect(runAction('browser_type', { elementRef: observedRef(snapshot, ids, input), text: 'new', replace: true }, { ids, budget }))
        .rejects.toThrow('read-only or does not support text input')
    }
    expect(locked!.value).toBe('old')
    expect(checkbox!.value).toBe('on')
    expect(ariaLocked!.value).toBe('old')
  })

  it('reports the observed checkbox state without claiming the form was saved', async () => {
    document.body.innerHTML = '<input type="checkbox" aria-label="Agree">'
    const input = document.querySelector('input')!
    input.scrollIntoView = () => {}
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const result = await runAction('browser_click', { elementRef: observedRef(snapshot, ids, input) }, { ids, budget })
    expect(input.checked).toBe(true)
    expect(result.text).toContain('Observed control state: checked')
    expect(result.text).toContain('does not confirm a saved change')
  })

  it('lists and selects an observed single-select option, then reads back its state', async () => {
    document.body.innerHTML = '<select aria-label="Size"><option>Small</option><option>Large</option></select>'
    const select = document.querySelector('select')!
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    expect(snapshot.text).toContain('0="Small", 1="Large"')
    const result = await runAction('browser_select', { elementRef: observedRef(snapshot, ids, select), optionIndex: 1 }, { ids, budget })
    expect(select.selectedIndex).toBe(1)
    expect(result.text).toContain('control state was read back')
    expect(result.text).toContain('does not confirm a saved change')
  })

  it('stops selection when the option list changes during an input event', async () => {
    document.body.innerHTML = '<select aria-label="Size"><option>Small</option><option>Large</option></select>'
    const select = document.querySelector('select')!
    const change = vi.fn()
    select.addEventListener('input', () => { select.options[1]!.text = 'Different' })
    select.addEventListener('change', change)
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const elementRef = observedRef(snapshot, ids, select)
    const result = await runAction('browser_select', { elementRef, optionIndex: 1 }, { ids, budget })
    expect(change).not.toHaveBeenCalled()
    expect(result.text).toContain('may have partially changed')
    await expect(runAction('browser_select', { elementRef, optionIndex: 0 }, { ids, budget })).rejects.toThrow('stale')
  })

  it('rejects a changed or disabled option and reports selection rollback', async () => {
    document.body.innerHTML = '<select aria-label="Size"><option>Small</option><option>Large</option><option disabled>Unavailable</option></select>'
    const select = document.querySelector('select')!
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const elementRef = observedRef(snapshot, ids, select)
    await expect(runAction('browser_select', { elementRef, optionIndex: 2 }, { ids, budget })).rejects.toThrow('unavailable')
    select.options[1]!.text = 'Different'
    await expect(runAction('browser_select', { elementRef, optionIndex: 1 }, { ids, budget })).rejects.toThrow('changed')
    const refreshed = await runAction('browser_snapshot', {}, { ids, budget })
    select.addEventListener('change', () => { select.selectedIndex = 0 })
    const result = await runAction('browser_select', { elementRef: observedRef(refreshed, ids, select), optionIndex: 1 }, { ids, budget })
    expect(select.selectedIndex).toBe(0)
    expect(result.text).toContain('could not be confirmed')
  })
})
