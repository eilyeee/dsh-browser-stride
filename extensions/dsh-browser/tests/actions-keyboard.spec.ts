// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const budget = { maxItems: 20, maxForms: 10, maxChars: 4_000 }

afterEach(() => { document.body.replaceChildren() })

describe('synthetic keyboard actions', () => {
  it('does not dispatch a fabricated submit event for an invalid or valid form', async () => {
    document.body.innerHTML = '<form><input required><button>Submit</button></form>'
    const form = document.querySelector('form')!
    const input = document.querySelector('input')!
    const submit = vi.fn((event: Event) => { event.preventDefault() })
    const keydown = vi.fn()
    form.addEventListener('submit', submit)
    input.addEventListener('keydown', keydown)
    input.focus()
    const ctx = { ids: new ElementIds(), budget }

    const invalidResult = await runAction('browser_press', { key: 'Enter' }, ctx)
    input.value = 'valid'
    const validResult = await runAction('browser_press', { key: 'Enter' }, ctx)
    expect(keydown).toHaveBeenCalledTimes(2)
    expect(submit).not.toHaveBeenCalled()
    expect(invalidResult.text).toContain('synthetic')
    expect(validResult.text).toContain('not guaranteed')
  })

  it('does not submit a second time when a page handler responds to Enter', async () => {
    document.body.innerHTML = '<form><input><button>Submit</button></form>'
    const form = document.querySelector('form')!
    const input = document.querySelector('input')!
    const submit = vi.fn((event: Event) => { event.preventDefault() })
    form.addEventListener('submit', submit)
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    input.focus()

    const result = await runAction('browser_press', { key: 'Enter' }, { ids: new ElementIds(), budget })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(result.text).toContain('Page handlers may have caused effects')
  })

  it('rejects overlong keys and control characters before dispatch', async () => {
    const keydown = vi.fn()
    document.body.addEventListener('keydown', keydown, { once: true })
    const ctx = { ids: new ElementIds(), budget }
    for (const key of ['', 'x'.repeat(65), 'Enter\nother']) {
      await expect(runAction('browser_press', { key }, ctx)).rejects.toThrow('key must be')
    }
    expect(keydown).not.toHaveBeenCalled()
  })
})
