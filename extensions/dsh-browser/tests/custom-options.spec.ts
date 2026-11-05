// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectInteractive } from '../src/content/extract.ts'
import { ElementIds } from '../src/content/ids.ts'
import { runAction } from '../src/content/actions.ts'
import { observedRef } from './observed-ref.ts'

const budget = { maxItems: 30, maxForms: 10, maxChars: 6000 }
function fixture() {
  document.body.innerHTML = `<div role="dialog"><input readonly aria-label="Channel"></div>
    <div class="el-select-dropdown"><ul class="el-select-dropdown__list">
      <li class="el-select-dropdown__item selected">Current</li>
      <li class="el-select-dropdown__item">Replacement</li>
      <li class="el-select-dropdown__item is-disabled">Unavailable</li>
    </ul></div>`
  const options = [...document.querySelectorAll<HTMLLIElement>('li')]
  for (const el of options) el.scrollIntoView = vi.fn()
  return { options, ctx: { ids: new ElementIds(), budget } }
}
afterEach(() => document.body.replaceChildren())

describe('observed custom dropdown options', () => {
  it('exposes portalled options under a tight budget and uses their actual observed references', async () => {
    const { options, ctx } = fixture()
    const input = document.querySelector('input')!
    const click = vi.fn(() => {
      for (const el of options) el.classList.remove('selected')
      options[1]!.classList.add('selected')
      input.value = 'Replacement'
    })
    options[1]!.addEventListener('click', click)
    const snapshot = await runAction('browser_snapshot', {}, { ...ctx, budget: { ...budget, maxItems: 3 } })
    expect(snapshot.text).toMatch(/option "Current" \[selected\]/)
    expect(snapshot.text).toMatch(/option "Unavailable" \[disabled\/not selected\]/)
    await runAction('browser_click', { elementRef: observedRef(snapshot, ctx.ids, options[1]!) }, ctx)
    expect(click).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('Replacement')
    const delta = await runAction('browser_snapshot', { delta: true }, ctx)
    expect(delta.text).toMatch(/option "Replacement" \[selected\]/)
    expect(delta.text).toMatch(/option "Current" \[not selected\]/)
  })

  it('does not invent options from arbitrary list items or closed popups', () => {
    fixture()
    document.body.insertAdjacentHTML('beforeend', '<li>Ordinary text</li><li class="el-select-dropdown__item">Outside a popup</li>')
    const popup = document.querySelector<HTMLElement>('.el-select-dropdown')!
    for (const style of ['display:none', 'opacity:0', 'visibility:hidden']) {
      popup.setAttribute('style', style)
      expect(collectInteractive(document).map(el => el.textContent)).not.toContain('Replacement')
    }
    popup.removeAttribute('style')
    expect(collectInteractive(document).map(el => el.textContent)).toContain('Replacement')
    expect(collectInteractive(document).map(el => el.textContent)).not.toContain('Outside a popup')
    expect(collectInteractive(document).map(el => el.textContent)).not.toContain('Ordinary text')
  })

  it('rejects disabled, hidden and relabelled options before dispatch', async () => {
    const { options, ctx } = fixture()
    const option = options[1]!, click = vi.fn()
    option.addEventListener('click', click)
    const snapshot = await runAction('browser_snapshot', {}, ctx)
    const ref = observedRef(snapshot, ctx.ids, option)
    option.classList.add('is-disabled')
    await expect(runAction('browser_click', { elementRef: ref }, ctx)).rejects.toThrow(/not actionable/)
    option.classList.remove('is-disabled')
    document.querySelector<HTMLElement>('.el-select-dropdown')!.style.opacity = '0'
    await expect(runAction('browser_click', { elementRef: ref }, ctx)).rejects.toThrow(/not actionable/)
    document.querySelector<HTMLElement>('.el-select-dropdown')!.style.opacity = '1'
    option.textContent = 'Different action'
    await expect(runAction('browser_click', { elementRef: ref }, ctx)).rejects.toThrow(/changed/)
    expect(click).not.toHaveBeenCalled()
  })

  it('rejects the same option moved into a different popup, even with the same text', async () => {
    const { options, ctx } = fixture()
    const option = options[1]!, click = vi.fn()
    option.addEventListener('click', click)
    const snapshot = await runAction('browser_snapshot', {}, ctx)
    const oldRef = observedRef(snapshot, ctx.ids, option)
    const other = document.createElement('div')
    other.className = 'el-select-dropdown'
    other.innerHTML = '<ul class="el-select-dropdown__list"></ul>'
    document.body.append(other)
    other.firstElementChild!.append(option)
    await expect(runAction('browser_click', { elementRef: oldRef }, ctx)).rejects.toThrow(/changed/)
    const next = await runAction('browser_snapshot', {}, ctx)
    await expect(runAction('browser_click', { elementRef: oldRef }, ctx)).rejects.toThrow(/stale/)
    await runAction('browser_click', { elementRef: observedRef(next, ctx.ids, option) }, ctx)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('reads standard combobox/option semantics and rejects ARIA-disabled options', async () => {
    document.body.innerHTML = `<div role="combobox" aria-label="Platform"></div>
      <div role="listbox"><div role="option" aria-selected="true">Primary</div>
      <div role="option" aria-disabled="true">Blocked</div></div>`
    const ctx = { ids: new ElementIds(), budget }
    const snapshot = await runAction('browser_snapshot', {}, ctx)
    expect(snapshot.text).toContain('combobox "Platform"')
    expect(snapshot.text).toContain('option "Primary" [selected]')
    const blocked = document.querySelector('[aria-disabled]')!
    await expect(runAction('browser_click', { elementRef: observedRef(snapshot, ctx.ids, blocked) }, ctx)).rejects.toThrow(/not actionable/)
  })
})
