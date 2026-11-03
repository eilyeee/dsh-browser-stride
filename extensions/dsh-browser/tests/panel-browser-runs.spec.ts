// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelApi } from '../src/panel/api.ts'
import { BrowserRuns } from '../src/panel/BrowserRuns.tsx'
import { parseBrowserRuns } from '../src/panel/browser-runs.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'
import { BRIDGE_RUN_LIST_METHOD, BRIDGE_RUN_CONTROL_METHOD, type BrowserRunSummary } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { TASK_LIMITS } from '@eilyeee/dsh-browser-stride/src/task-budget.ts'

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
  it.each(['en', 'zh'] as const)('explains a native target-loss pause without claiming reconnection or authorization resumes it in %s', async locale => {
    const paused = { ...item('session-a', 'paused'), pauseReason: 'page-unavailable' as const, canRetarget: true,
      controls: ['stop' as const], task: { goal: 'Synthetic task', activeMs: 1, modelRequests: 1, toolCalls: 1, outcome: 'pending' as const, canStart: false } }
    const rpc = vi.fn(async () => list(paused)), copy = PANEL_COPY[locale].runs
    await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'], retargetRun: vi.fn() },
      sessionId: 'session-a', connected: true, targetRevision: 4, copy })) })
    expect(document.body.textContent).toContain(copy.targetLostHelp)
    expect(document.body.textContent).not.toContain(copy.disconnectedHelp)
    expect(parseBrowserRuns(list(paused), 'session-a').items[0]?.pauseReason).toBe('page-unavailable')
  })

  it.each((['activeMs', 'modelRequests', 'toolCalls'] as const).flatMap(counter =>
    (['en', 'zh'] as const).map(locale => ({ counter, locale }))))(
    'keeps stop available without advertising exhausted $counter continuation in $locale', async ({ counter, locale }) => {
      const paused = { ...item('session-a', 'paused'), pauseReason: 'browser-disconnected' as const, canRetarget: true,
        controls: ['stop' as const], task: { goal: 'Synthetic limited task', activeMs: 0, modelRequests: 0, toolCalls: 0,
          [counter]: TASK_LIMITS[counter], outcome: 'pending' as const, canStart: false } }
      const rpc = vi.fn(async () => list(paused)), copy = PANEL_COPY[locale].runs
      await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'], retargetRun: vi.fn() },
        sessionId: 'session-a', connected: true, targetRevision: 4, copy })) })
      expect(document.querySelector('.run-retarget')).toBeNull()
      expect(document.querySelector('.browser-run-actions')?.textContent).toContain(copy.stop)
      expect(document.body.textContent).toContain(copy.outcomes['budget-exhausted'])
      expect(document.body.textContent).not.toContain(copy.disconnectedHelp)
    },
  )

  it.each(['en', 'zh'] as const)('hides exhausted selected-page and new-page startup from an older Host in %s', async locale => {
    const queued = { ...item('session-a', 'queued'), controls: ['pause' as const, 'stop' as const],
      task: { goal: 'Synthetic limited task', activeMs: 0, modelRequests: 0, toolCalls: TASK_LIMITS.toolCalls,
        outcome: 'pending' as const, canStart: true, canStartNewPage: true } }
    const rpc = vi.fn(async () => list(queued)), copy = PANEL_COPY[locale].runs
    await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'], retargetRun: vi.fn() },
      sessionId: 'session-a', connected: true, supportsNewPages: true, startRevision: 4, newPageRevision: 4, copy })) })
    expect(document.querySelector('.run-start')).toBeNull()
    expect(document.querySelector('.run-start-new-page')).toBeNull()
    expect(document.querySelector('.browser-run-new-page')).toBeNull()
    expect(document.body.textContent).toContain(copy.outcomes['budget-exhausted'])
    expect(document.body.textContent).not.toContain(copy.waitingHelp)
    expect(document.querySelector('.browser-run-actions')?.textContent).toContain(copy.stop)
  })

  it('explains a connection-loss pause without inventing continuation after an uncertain write', async () => {
    const paused = { ...item('session-a', 'paused'), pauseReason: 'browser-disconnected' as const, canRetarget: false, requiresReconciliation: true,
      controls: ['stop' as const], task: { goal: 'Synthetic task', activeMs: 1, modelRequests: 1, toolCalls: 1, outcome: 'pending' as const, canStart: false } }
    const rpc = vi.fn(async () => list(paused))
    await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'] }, sessionId: 'session-a', connected: true, copy: PANEL_COPY.zh.runs })) })
    expect(document.body.textContent).toContain('浏览器连接已中断，任务已暂停')
    expect(document.body.textContent).toContain('部分操作结果尚未明确')
    expect(document.querySelector('.run-retarget')).toBeNull()
    expect(parseBrowserRuns(list(paused), 'session-a').items[0]?.pauseReason).toBe('browser-disconnected')
    expect(() => parseBrowserRuns(list({ ...paused, state: 'running' }), 'session-a')).toThrow()
    expect(() => parseBrowserRuns(list({ ...paused, pauseReason: 'page-supplied' } as unknown as BrowserRunSummary), 'session-a')).toThrow()
  })
  it('gates new-page startup by Host capability, saved opt-in, URL and genuine click', async () => {
    const queued = { ...item('session-a', 'queued'), task: { goal: 'Synthetic goal', activeMs: 0, modelRequests: 0, toolCalls: 0, outcome: 'pending' as const, canStart: true, canStartNewPage: true } }
    const rpc = vi.fn(async () => list(queued)), retargetRun = vi.fn(async () => {})
    const render = (props: object) => root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'], retargetRun }, sessionId: 'session-a', connected: true, copy: PANEL_COPY.en.runs, ...props }))
    await act(async () => { render({ supportsNewPages: false }) })
    expect(document.querySelector('.run-start-new-page')).toBeNull()
    await act(async () => { render({ supportsNewPages: true }) })
    expect(document.body.textContent).toContain('then save and connect')
    expect(document.querySelector<HTMLButtonElement>('.run-start-new-page')?.disabled).toBe(true)
    await act(async () => { render({ supportsNewPages: true, newPageRevision: 1 }) })
    const input = document.querySelector<HTMLInputElement>('.browser-run-new-page input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://synthetic.test/')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const button = document.querySelector<HTMLButtonElement>('.run-start-new-page')!
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(retargetRun).not.toHaveBeenCalled()
    expect(() => parseBrowserRuns(list({ ...queued, task: { ...queued.task, canStart: false } }), 'session-a')).toThrow()
  })
  it('requires a selected native view and a real click for target handoff', async () => {
    const paused = { ...item('session-a', 'paused'), canRetarget: true }
    const rpc = vi.fn(async () => list(paused))
    const retargetRun = vi.fn(async () => {})
    await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'], retargetRun }, targetRevision: 4, sessionId: 'session-a', connected: true, copy: PANEL_COPY.en.runs })) })
    expect(document.querySelector('.run-retarget')).not.toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('.run-retarget')!.click() })
    expect(retargetRun).not.toHaveBeenCalled()
  })
  it('shows queued task binding and its goal without accepting a synthetic start', async () => {
    const queued = { ...item('session-a', 'queued'), task: { goal: 'Synthetic goal', activeMs: 0, modelRequests: 0, toolCalls: 0, outcome: 'pending' as const, canStart: true } }
    const rpc = vi.fn(async () => list(queued))
    const retargetRun = vi.fn(async () => {})
    await act(async () => { root.render(createElement(BrowserRuns, { api: { rpc: rpc as PanelApi['rpc'], retargetRun }, startRevision: 5, sessionId: 'session-a', connected: true, copy: PANEL_COPY.en.runs })) })
    expect(document.body.textContent).toContain('Synthetic goal')
    await act(async () => { document.querySelector<HTMLButtonElement>('.run-start')!.click() })
    expect(retargetRun).not.toHaveBeenCalled()
    expect(() => parseBrowserRuns(list({ ...queued, state: 'running' }), 'session-a')).toThrow()
    expect(() => parseBrowserRuns(list({ ...queued, task: { ...queued.task, modelRequests: -1 } }), 'session-a')).toThrow()
  })
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
    list({ ...item(), canRetarget: true }),
    list({ ...item('session-a', 'paused'), canRetarget: true, requiresReconciliation: true }),
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
