// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsPanel } from '../src/panel/DiagnosticsPanel.tsx'
import type { PanelApi, PageDiagnosticsStatus } from '../src/panel/api.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function pending() {
  let resolve!: (value: PageDiagnosticsStatus) => void, reject!: (reason: Error) => void
  const promise = new Promise<PageDiagnosticsStatus>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const page = { tabId: 7, windowId: 1, title: 'Synthetic diagnostics', url: 'https://synthetic.test/' }
const affinity = { revision: 2, status: 'background' as const, controlled: page, active: page }
describe('diagnostics panel async state', () => {
  it('does not let an older failed status poll clear a newer enabled capture', async () => {
    vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const first = pending(), second = pending(), pageDiagnostics = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const api = { pageDiagnostics } as unknown as PanelApi, container = document.createElement('div'), root = createRoot(container)
    try {
      await act(async () => root.render(createElement(DiagnosticsPanel, { api, sessionId: 'synthetic', affinity, available: true, locale: 'zh' })))
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(pageDiagnostics).toHaveBeenCalledTimes(2)
      await act(async () => second.resolve({ enabled: true, count: 3, dropped: 0, captureId: 'capture_new' }))
      expect(container.textContent).toContain('已记录 3 条')
      await act(async () => first.reject(Error('old status unavailable')))
      expect(container.textContent).toContain('已记录 3 条')
      expect(container.querySelector('button')?.textContent).toBe('停止并清空诊断')
    } finally { await act(async () => root.unmount()) }
  })
  it('resets displayed state on scope loss and keeps synthetic clicks unable to start capture', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const first = pending(), current = pending(), pageDiagnostics = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(current.promise)
    const api = { pageDiagnostics } as unknown as PanelApi, container = document.createElement('div'), root = createRoot(container)
    const render = (available: boolean) => act(async () => root.render(createElement(DiagnosticsPanel, { api, sessionId: 'synthetic', affinity, available, locale: 'en' })))
    try {
      await render(true)
      await act(async () => { container.querySelector('button')!.click() })
      expect(pageDiagnostics).toHaveBeenCalledTimes(1)
      await render(false); expect(container.querySelector('button')?.disabled).toBe(true)
      await render(true)
      await act(async () => current.resolve({ enabled: true, count: 4, dropped: 0, captureId: 'capture_current' }))
      await act(async () => first.resolve({ enabled: false, count: 0, dropped: 0 }))
      expect(container.textContent).toContain('4 entries')
      expect(container.querySelector('button')?.textContent).toBe('Stop and clear diagnostics')
      expect(pageDiagnostics.mock.calls.every(([request]) => request.action === 'status')).toBe(true)
    } finally { await act(async () => root.unmount()) }
  })
})
