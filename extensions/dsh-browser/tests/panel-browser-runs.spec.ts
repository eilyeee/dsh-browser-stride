// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelApi } from '../src/panel/api.ts'
import { BrowserRuns } from '../src/panel/BrowserRuns.tsx'
import { parseBrowserRuns } from '../src/panel/browser-runs.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'
import { BRIDGE_RUN_LIST_METHOD, BRIDGE_RUN_CONTROL_METHOD, type BrowserRunSummary } from '@eilyeee/dsh-stride-browser-bridge/src/protocol.ts'

function item(sessionId = 'session-a', state: BrowserRunSummary['state'] = 'running'): BrowserRunSummary {
  return { runId: 'run_synthetic', sessionId, state, version: 1, controlRevision: 0, updatedAt: 1,
    recoveryRequired: false, requiresReconciliation: false, controls: state === 'running' ? ['pause', 'stop'] : [] }
}
const list = (entry = item()) => ({ items: [entry], total: 1 })
let root: Root
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  root = createRoot(document.querySelector('#root')!)
})
afterEach(async () => { await act(async () => { root.unmount() }); vi.useRealTimers(); vi.restoreAllMocks() })

describe('browser task panel boundaries', () => {
  it('continues polling after an empty session later receives a managed task', async () => {
    vi.useFakeTimers()
    const rpc = vi.fn().mockResolvedValueOnce({ items: [], total: 0 }).mockResolvedValue(list())
    await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'] }, sessionId: 'session-a', connected: true, copy: PANEL_COPY.en.runs })) })
    expect(document.querySelector('.browser-runs')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(document.body.textContent).toContain('Running')
  })

  it.each([
    list(item('foreign-session')),
    list({ ...item(), version: -1 }),
    list({ ...item(), controls: ['resume'] } as unknown as BrowserRunSummary),
    list({ ...item('session-a', 'completed'), controls: ['stop'] }),
    { items: [item(), item()], total: 2 },
  ])('rejects foreign, stale-shaped or unsupported metadata', value => {
    expect(() => parseBrowserRuns(value, 'session-a')).toThrow()
  })

  it('shows existing task controls but rejects script-generated clicks', async () => {
    const rpc = vi.fn(async () => list())
    await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'] }, sessionId: 'session-a', connected: true, copy: PANEL_COPY.zh.runs })) })
    expect(document.body.textContent).toContain('运行中')
    await act(async () => { document.querySelector<HTMLButtonElement>('.browser-run-actions button')!.click() })
    expect(rpc).toHaveBeenCalledWith(BRIDGE_RUN_LIST_METHOD, { sessionId: 'session-a' })
    expect(rpc.mock.calls.some((call: unknown[]) => call[0] === BRIDGE_RUN_CONTROL_METHOD)).toBe(false)
    expect(document.body.textContent).not.toContain('恢复任务')
  })

  it('does not restore a prior session from an out-of-order read, or show controls after disconnect', async () => {
    let finishA!: (value: unknown) => void
    const rpc = vi.fn((_method: string, payload?: unknown) => (payload as { sessionId: string }).sessionId === 'session-a'
      ? new Promise(resolve => { finishA = resolve }) : Promise.resolve(list(item('session-b'))))
    const api = { rpc: rpc as PanelApi['rpc'] }
    const render = (sessionId: string, connected = true) => root.render(createElement(BrowserRuns, { api, sessionId, connected, copy: PANEL_COPY.en.runs }))
    await act(async () => { render('session-a') })
    await act(async () => { render('session-b') })
    await act(async () => { finishA(list(item('session-a', 'failed'))) })
    expect(document.body.textContent).toContain('Running')
    expect(document.body.textContent).not.toContain('Failed')
    await act(async () => { render('session-b', false) })
    expect(document.querySelector('.browser-runs')).toBeNull()
  })

  it('shows stopping as a request awaiting confirmation and offers no further controls', async () => {
    const rpc = vi.fn(async () => list(item('session-a', 'stopping')))
    await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'] }, sessionId: 'session-a', connected: true, copy: PANEL_COPY.en.runs })) })
    expect(document.body.textContent).toContain('waiting for the executor to confirm')
    expect(document.querySelector('.browser-run-actions')).toBeNull()
  })

  it('fails closed on malformed data without continually polling or echoing the response', async () => {
    vi.useFakeTimers()
    const rpc = vi.fn(async () => ({ items: [{ privatePageValue: 'synthetic-private' }], total: 1 }))
    await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'] }, sessionId: 'session-a', connected: true, copy: PANEL_COPY.en.runs })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Could not read task status')
    expect(document.body.textContent).not.toContain('synthetic-private')
    expect(document.querySelector('.browser-run-actions')).toBeNull()
  })
})
