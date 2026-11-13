// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskBriefPanel, acceptanceMarkdown, criteriaFromLines } from '../src/panel/TaskBriefPanel.tsx'
import { versionStatus } from '../src/panel/VersionStatus.tsx'
import { PanelRpcError } from '../src/panel/api.ts'
import type { TaskBrief } from '@eilyeee/dsh-browser-stride/src/task-brief-contract.ts'
const brief: TaskBrief = { sessionId: 's', version: 1, updatedAt: 1, userEdited: false, goal: 'Synthetic goal', projectPath: '/synthetic/project', materials: [],
  criteria: [{ id: 'save', text: 'Save once' }], progress: [{ criterionId: 'save', implementation: 'implemented', observation: 'observed',
    evidence: ['Synthetic backend readback'], nextStep: '', userConfirmed: false }] }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('task notes panel', () => {
  it('imports an authorized page only into the draft and saves an unknown role without opening or selecting it', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    document.body.innerHTML = '<div id="test"></div>'
    const url = 'https://wiki.example/view?pageId=42&space=TEST'
    const pages = [{ tabId: 1, windowId: 1, title: 'Synthetic requirements', url },
      { tabId: 2, windowId: 1, title: 'Duplicate copy', url: 'https://wiki.example/view?space=TEST&pageId=42' },
      { tabId: 3, windowId: 1, title: 'Private URL', url: url + '&token=synthetic' }]
    const onSelectPage = vi.fn()
    const rpc = vi.fn(async (method: string, payload: unknown) => method.endsWith('.save')
      ? { ...brief, ...(payload as { input: object }).input, version: 2 } : brief)
    const api = { rpc: async <T,>(method: string, payload: unknown) => await rpc(method, payload) as T }
    const root = createRoot(document.querySelector('#test')!)
    try {
      await act(async () => root.render(createElement(TaskBriefPanel, { api, sessionId: 's', supported: true, connected: true,
        locale: 'en', pages, onSelectPage, onProjectChat: vi.fn() })))
      const picker = document.querySelector('.task-material-picker')!
      expect(picker.querySelectorAll('button')).toHaveLength(1)
      await act(async () => { picker.querySelector('button')!.click() })
      expect(picker.querySelectorAll('button')).toHaveLength(0)
      expect(onSelectPage).not.toHaveBeenCalled()
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(document.querySelector('select')?.value).toBe('unknown')
      await act(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Save notes')!.click() })
      expect(rpc).toHaveBeenLastCalledWith('bridge.taskBrief.save', expect.objectContaining({ input: expect.objectContaining({
        materials: [{ url, label: 'Synthetic requirements', role: 'unknown' }],
      }) }))
      expect(document.querySelector('.task-material-links a')).toBeNull()
      expect(document.querySelectorAll('[data-material-tab-id]')).toHaveLength(2)
      // Page selection requires a trusted native click, unlike editing a draft.
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-material-tab-id]')!.click() })
      expect(onSelectPage).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })

  it('keeps the eight-material limit and withdraws revoked matches without choosing another page', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    document.body.innerHTML = '<div id="test"></div>'
    const materials = Array.from({ length: 8 }, (_, i) => ({ url: `https://wiki.example/view?pageId=${i}`, label: `Material ${i}`, role: 'unknown' as const }))
    const rpc = vi.fn(async (_method: string, _payload: unknown) => ({ ...brief, materials }))
    const api = { rpc: async <T,>(method: string, payload: unknown) => await rpc(method, payload) as T }
    const onSelectPage = vi.fn(), root = createRoot(document.querySelector('#test')!)
    const render = async (pages: Array<{ tabId: number; windowId: number; url: string; title: string }>) => {
      await act(async () => root.render(createElement(TaskBriefPanel, { api, sessionId: 's', supported: true, connected: true,
        locale: 'en', pages, onSelectPage, onProjectChat: vi.fn(), canSelectPage: false })))
    }
    try {
      await render([{ tabId: 1, windowId: 1, url: materials[0]!.url, title: 'Synthetic page' }])
      expect(document.querySelector('.task-material-picker')!.textContent).toContain('Up to 8 materials')
      expect(document.querySelector<HTMLButtonElement>('[data-material-tab-id]')!.disabled).toBe(true)
      await render([])
      expect(document.querySelector('[data-material-tab-id]')).toBeNull()
      expect(document.querySelectorAll('.task-material-links a')).toHaveLength(8)
      expect(onSelectPage).not.toHaveBeenCalled()
      expect(rpc).toHaveBeenCalledTimes(1)
    } finally { await act(async () => root.unmount()) }
  })

  it('explains unavailable storage without loading forever or sending note requests', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    document.body.innerHTML = '<div id="test"></div>'
    const rpc = vi.fn()
    const api = { rpc: async <T,>(method: string, payload: unknown) => await rpc(method, payload) as T }
    const root = createRoot(document.querySelector('#test')!)
    try {
      await act(async () => root.render(createElement(TaskBriefPanel, { api, sessionId: 's', supported: false, unavailable: true,
        connected: true, locale: 'zh', onProjectChat: vi.fn() })))
      expect(document.body.textContent).toContain('任务资料暂不可用，聊天可以继续')
      expect(document.body.textContent).not.toContain('正在读取')
      expect(rpc).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })

  it('keeps criterion identity on reorder and distinguishes model observations from user review in exports', () => {
    expect(criteriaFromLines('Other\nSave once', brief.criteria)[1]?.id).toBe('save')
    const model = acceptanceMarkdown(brief, 'zh')
    expect(model).toContain('模型已观察到')
    expect(model).not.toContain('用户已核验')
    expect(acceptanceMarkdown({ ...brief, progress: [{ ...brief.progress[0]!, userConfirmed: true }] }, 'en')).toContain('User reviewed')
  })
  it('does not lose edits when collapsed or send them to a different conversation', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    document.body.innerHTML = '<div id="test"></div>'
    const rpc = vi.fn(async (_method: string, payload: unknown) => ({ ...brief, sessionId: (payload as { sessionId: string }).sessionId }))
    const api = { rpc: async <T,>(method: string, payload: unknown) => await rpc(method, payload) as T }
    const root = createRoot(document.querySelector('#test')!)
    const render = async (sessionId: string) => { await act(async () => root.render(createElement(TaskBriefPanel, { api, sessionId, supported: true, connected: true, locale: 'zh', onProjectChat: vi.fn() }))) }
    try {
      await render('s')
      const textarea = document.querySelector('textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Unsaved change')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        const details = document.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle'))
      })
      await act(async () => { const details = document.querySelector('details')!; details.open = false; details.dispatchEvent(new Event('toggle')) })
      expect(document.querySelector('textarea')?.value).toBe('Unsaved change')
      await render('other')
      expect(document.querySelector('textarea')?.value).toBe('Synthetic goal')
      expect(rpc.mock.calls.filter(([method]) => method.endsWith('.save'))).toEqual([])
    } finally { await act(async () => root.unmount()) }
  })
  it('distinguishes package mismatch from older peers without version metadata', () => {
    const caps = { textOnly: true as const, snapshotMaxChars: 32000, maxInteractiveItems: 60 }
    expect(versionStatus(caps, '0.1.5')).toBe('unknown')
    expect(versionStatus({ ...caps, release: { bridgeVersion: '0.1.4', dshVersion: '0.2.1-rc.5' } }, '0.1.5')).toBe('different')
    expect(versionStatus({ ...caps, release: { bridgeVersion: '0.1.5', dshVersion: '0.2.1-rc.5' } }, '0.1.5')).toBe('matched')
  })
  it('retains an unsaved draft through disconnects and settings remounts without crossing Hosts or rebasing its version', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    document.body.innerHTML = '<div id="test"></div>'
    let remote = brief
    const rpc = vi.fn(async (method: string, payload: unknown) => {
      if (method.endsWith('.save')) throw new PanelRpcError('stale-version', 'Synthetic changed record')
      return { ...remote, sessionId: (payload as { sessionId: string }).sessionId }
    })
    const api = { rpc: async <T,>(method: string, payload: unknown) => await rpc(method, payload) as T }
    let root = createRoot(document.querySelector('#test')!)
    const render = async (hostIdentity = 'host-a', connected = true) => {
      await act(async () => root.render(createElement(TaskBriefPanel, { api, sessionId: 's', supported: connected, connected, hostIdentity, locale: 'en', onProjectChat: vi.fn() })))
    }
    try {
      await render()
      await act(async () => {
        const field = document.querySelector('textarea')!
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Unsaved local change')
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await render('host-a', false)
      remote = { ...brief, version: 2, goal: 'Changed on Host' }
      await render()
      expect(document.querySelector('textarea')!.value).toBe('Unsaved local change')
      expect(rpc.mock.calls.some(([method]) => method.endsWith('.save'))).toBe(false)
      await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Save notes')!.click() })
      expect(rpc).toHaveBeenCalledWith('bridge.taskBrief.save', expect.objectContaining({ version: 1 }))
      expect(document.querySelector('textarea')!.value).toBe('Unsaved local change')
      expect(document.body.textContent).toContain('The notes changed')
      await act(async () => root.unmount())
      root = createRoot(document.querySelector('#test')!)
      await render()
      expect(document.querySelector('textarea')!.value).toBe('Unsaved local change')
      await render('host-b')
      expect(document.querySelector('textarea')!.value).toBe('Changed on Host')
      await render('host-a')
      expect(document.querySelector('textarea')!.value).toBe('Unsaved local change')
      await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Reload (discard unsaved edits)')!.click() })
      await act(async () => root.unmount())
      root = createRoot(document.querySelector('#test')!)
      await render()
      expect(document.querySelector('textarea')!.value).toBe('Changed on Host')
    } finally { await act(async () => root.unmount()) }
  })
  it('exports a fresh Host record even while the panel still displays a cached record', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob)
    let exported: NodeBlob | undefined
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob: unknown) { exported = blob as NodeBlob; return 'blob:synthetic-download' }
      static revokeObjectURL() {}
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    document.body.innerHTML = '<div id="test"></div>'
    const root = createRoot(document.querySelector('#test')!)
    const rpc = vi.fn().mockResolvedValueOnce({ ...brief, goal: 'Cached goal', progress: [] }).mockResolvedValueOnce({ ...brief, version: 2 })
    const api = { rpc: async <T,>(method: string, payload: unknown) => await rpc(method, payload) as T }
    try {
      await act(async () => root.render(createElement(TaskBriefPanel, { api, sessionId: 's', supported: true, connected: true, locale: 'en', onProjectChat: vi.fn() })))
      await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Download acceptance record')!.click() })
      expect(await exported!.text()).toContain('Synthetic backend readback')
      expect(await exported!.text()).not.toContain('Cached goal')
      expect(rpc).toHaveBeenCalledTimes(2)
    } finally { vi.clearAllTimers(); click.mockRestore(); await act(async () => root.unmount()) }
  })
})
