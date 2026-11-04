// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ControlGroupStatus, pageAccessNotice } from '../src/panel/App.tsx'
import { PANEL_COPY } from '../src/panel/strings.ts'

describe('control group UI', () => {
  it.each(['zh', 'en'] as const)('distinguishes page selection from missing authorization in %s', locale => {
    const copy = PANEL_COPY[locale]
    const empty = { activeGranted: false, controlledGranted: false, controlledTabId: null, revocableTabId: null }
    const page = { tabId: 1, windowId: 1, title: 'Synthetic group page', url: 'https://example.test/' }
    expect(pageAccessNotice(empty, copy)).toBe(copy.pageAccess.required)
    expect(pageAccessNotice({ ...empty, pages: [page] }, copy)).toBe(copy.pageAccess.selectExisting)
    expect(pageAccessNotice({ ...empty, activeGranted: true, pages: [page] }, copy)).toBe(copy.pageAccess.selectExisting)
    expect(pageAccessNotice({ ...empty, controlledGranted: true, controlledTabId: 1, pages: [page] }, copy)).toBe(copy.pageAccess.granted)
  })
  it('offers only authorized group pages and has no human follow controls', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const page = { tabId: 1, windowId: 1, title: 'Synthetic group page', url: 'https://example.com/' }
    const outside = { ...page, tabId: 2, title: 'Unapproved human page' }
    const onSelect = vi.fn(async () => {})
    try {
      await act(async () => root.render(createElement(ControlGroupStatus, { state: { revision: 1, status: 'background', controlled: page, active: outside }, pages: [page], copy: PANEL_COPY.zh, onSelect })))
      expect(container.textContent).toContain('Synthetic group page')
      expect(container.textContent).not.toContain('Unapproved human page')
      expect(container.textContent).not.toContain('跟随')
      expect(container.querySelector('.follow')).toBeNull()
      expect(container.querySelector('button')?.getAttribute('aria-pressed')).toBe('true')
      await act(async () => { container.querySelector('button')!.click() })
      expect(onSelect).not.toHaveBeenCalled()
      await act(async () => root.render(createElement(ControlGroupStatus, { state: { revision: 2, status: 'lost', controlled: null, active: outside }, pages: [], copy: PANEL_COPY.zh, onSelect })))
      expect(container.textContent).toContain('还没有已授权的分组页面')
      expect(container.querySelector('button')).toBeNull()
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})
