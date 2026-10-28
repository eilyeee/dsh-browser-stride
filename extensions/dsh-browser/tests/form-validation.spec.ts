// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, renderSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'
import { observedRef } from './observed-ref.ts'

const budget: SnapshotBudget = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

function formLine(text: string, ids: ElementIds, element: Element): string {
  const index = ids.indexOf(element)
  const line = text.split('\n').find(value => value.startsWith(`  [${index}] `) && value.includes('native-constraints='))
  expect(line).toBeDefined()
  return line!
}

afterEach(() => { document.body.replaceChildren() })

describe('form validation observations', () => {
  it('reports native constraints for inputs, textareas, and selects without firing invalid events', () => {
    document.body.innerHTML = `
      <input id="email" type="email" aria-label="Email" value="invalid-address" required>
      <textarea id="note" aria-label="Note" required></textarea>
      <select id="choice" aria-label="Choice" required><option value="">Choose</option><option value="ok">OK</option></select>
      <fieldset disabled><input id="locked" aria-label="Locked" required><textarea aria-label="Locked note" required></textarea></fieldset>
    `
    const fields = [...document.querySelectorAll('input, textarea, select')]
    let invalidEvents = 0
    fields.forEach(field => field.addEventListener('invalid', () => { invalidEvents += 1 }))
    const ids = new ElementIds()
    const text = renderSnapshot(buildSnapshot(ids, { budget }, null), false)

    expect(formLine(text, ids, fields[0]!)).toContain('required native-constraints=invalid(type-mismatch)')
    expect(formLine(text, ids, fields[1]!)).toContain('required native-constraints=invalid(value-missing)')
    expect(formLine(text, ids, fields[2]!)).toContain('required native-constraints=invalid(value-missing)')
    expect(formLine(text, ids, fields[3]!)).toContain('required native-constraints=not-validated')
    expect(formLine(text, ids, fields[4]!)).toContain('required native-constraints=not-validated')
    expect(text).toContain('input "Locked" [disabled]')
    expect(text).toContain('textarea "Locked note" [disabled]')
    expect(invalidEvents).toBe(0)
  })

  it('reports validation changes and their removal in deltas without exposing custom messages or passwords', () => {
    document.body.innerHTML = '<input type="password" aria-label="Password" value="fixture-secret"><div contenteditable="true" aria-label="Editor"></div>'
    const input = document.querySelector('input')!
    const editor = document.querySelector('div')!
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget }, null)
    input.setCustomValidity('private-message-fixture')
    input.setAttribute('aria-invalid', 'true')
    editor.setAttribute('aria-invalid', 'grammar')
    const invalid = buildSnapshot(ids, { budget, delta: true }, first)
    const invalidText = renderSnapshot(invalid, true)

    expect(invalid.changed).toContain(ids.indexOf(input))
    expect(invalid.changed).toContain(ids.indexOf(editor))
    expect(formLine(invalidText, ids, input)).toContain('native-constraints=invalid(custom-error) aria-invalid=true')
    expect(invalidText).toContain('aria-invalid=grammar')
    expect(invalidText).not.toContain('fixture-secret')
    expect(invalidText).not.toContain('private-message-fixture')

    editor.setAttribute('aria-invalid', 'page-supplied-unrecognized-value')
    const unknown = buildSnapshot(ids, { budget, delta: true }, invalid)
    const unknownText = renderSnapshot(unknown, true)
    expect(unknown.changed).toContain(ids.indexOf(editor))
    expect(unknownText).toContain('aria-invalid=true')
    expect(unknownText).not.toContain('page-supplied-unrecognized-value')

    input.setCustomValidity('')
    input.setAttribute('aria-invalid', 'false')
    editor.removeAttribute('aria-invalid')
    const corrected = buildSnapshot(ids, { budget, delta: true }, unknown)
    const correctedText = renderSnapshot(corrected, true)
    expect(corrected.changed).toContain(ids.indexOf(input))
    expect(corrected.changed).toContain(ids.indexOf(editor))
    expect(formLine(correctedText, ids, input)).toContain('native-constraints=valid')
    expect(correctedText).not.toContain('aria-invalid=')
  })

  it('includes new validation failures in a permitted action delta without claiming a save', async () => {
    document.body.innerHTML = '<input type="email" aria-label="Email" value="before@example.test">'
    const input = document.querySelector('input')!
    input.addEventListener('input', () => {
      input.setCustomValidity('private-message-fixture')
      input.setAttribute('aria-invalid', 'true')
    })
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const result = await runAction('browser_type', {
      elementRef: observedRef(snapshot, ids, input), text: 'after@example.test', replace: true,
    }, { ids, budget, includePageDelta: true })

    expect(result.text).toContain('does not confirm a saved change')
    expect(result.pageContent).toContain('native-constraints=invalid(custom-error) aria-invalid=true')
    expect(result.pageContent).not.toContain('private-message-fixture')
  })

  it('masks one-time codes and grouped card fields in observations', async () => {
    document.body.innerHTML = '<label for="verification">验证码</label><input id="verification" value="synthetic-verification"><input autocomplete="section-pay billing cc-number" value="synthetic-card"><select aria-label="Card choice"><option>synthetic-selected</option><option>synthetic-unselected</option></select>'
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    expect(snapshot.text).toContain('value="••••"')
    expect(snapshot.text).not.toContain('synthetic-verification')
    expect(snapshot.text).not.toContain('synthetic-card')
    expect(snapshot.text).not.toContain('synthetic-selected')
    expect(snapshot.text).not.toContain('synthetic-unselected')
  })

  it('masks sensitive textarea and editor text in snapshots and text extraction', async () => {
    const longValue = `synthetic-editor-${'x'.repeat(120)}`
    document.body.innerHTML = `<main><p>Public details</p><textarea autocomplete="one-time-code">synthetic-textarea-secret</textarea><div id="otp" contenteditable="true"><span id="inside">${longValue}</span></div></main>`
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const whole = await runAction('browser_get_text', {}, { ids, budget })
    const child = await runAction('browser_get_text', { selector: '#inside' }, { ids, budget })
    for (const text of [snapshot.text, whole.text, child.text]) {
      expect(text).not.toContain('synthetic-textarea-secret')
      expect(text).not.toContain(longValue.slice(0, 80))
    }
    expect(whole.text).toContain('Public details')
  })

  it('redacts a sensitive field value mirrored outside the requested text region', async () => {
    document.body.innerHTML = '<main id="public">Shown: synthetic-mirrored-value</main><input autocomplete="one-time-code" value="synthetic-mirrored-value">'
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const region = await runAction('browser_get_text', { selector: '#public' }, { ids, budget })
    expect(snapshot.text).not.toContain('synthetic-mirrored-value')
    expect(region.text).not.toContain('synthetic-mirrored-value')
  })

  it('does not attach validation observations when page sharing is disabled', async () => {
    document.body.innerHTML = '<input aria-label="Field" value="before">'
    const input = document.querySelector('input')!
    input.addEventListener('input', () => { input.setCustomValidity('private-message-fixture') })
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const result = await runAction('browser_type', {
      elementRef: observedRef(snapshot, ids, input), text: 'after', replace: true,
    }, { ids, budget, includePageDelta: false })
    expect(result.pageContent).toBeUndefined()
    expect(result.text).not.toContain('custom-error')
    expect(result.text).not.toContain('private-message-fixture')
  })
})
