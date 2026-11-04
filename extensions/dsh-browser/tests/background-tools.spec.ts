// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchToolCall,
  forgetTabSnapshot,
  isNavigationCandidateTool,
  resetTabSnapshot,
  type ToolAnswer,
  type ToolCall,
} from '../src/background/tools.ts'

const CALL: ToolCall = { id: 'tool-1', name: 'browser_snapshot', args: {} }
const OK: ToolAnswer = { ok: true, result: { text: 'page' } }
const ZOOM_STEP = { ticket: 'zoom_00000000-0000-4000-8000-000000000001', before: 27, percent: 150 }

function managedTab(tabId: number, overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: tabId,
    windowId: 1,
    index: tabId,
    active: false,
    highlighted: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    lastAccessed: 0,
    groupId: -1,
    url: `https://example.com/${tabId}`,
    title: `Tab ${tabId}`,
    ...overrides,
  }
}

function mockChrome(options: {
  tab?: Partial<chrome.tabs.Tab>
  tabs?: chrome.tabs.Tab[]
  responses?: Array<unknown>
  injectionError?: Error
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
  respond?: (message: unknown, frameId: number) => unknown
}) {
  const responses = [...(options.responses ?? [OK])]
  const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
  const currentFrames = () => options.frames ?? (options.tab?.id === undefined ? [] : [{
    frameId: 0,
    parentFrameId: -1,
    documentId: `document-${options.tab.id}`,
    url: options.tab.url ?? '',
  }])
  const sendMessage = vi.fn(async (
    _tabId: number,
    message: unknown,
    target?: { frameId?: number; documentId?: string },
  ) => {
    const targetFrameId = target?.frameId
      ?? currentFrames().find((frame) => frame.documentId === target?.documentId)?.frameId
      ?? 0
    const response = options.respond?.(message, targetFrameId) ?? responses.shift()
    if (response instanceof Error) throw response
    return response
  })
  const executeScript = options.injectionError === undefined
    ? vi.fn(async () => [{ frameId: 0, result: undefined }])
    : vi.fn(async () => { throw options.injectionError })
  const allTabs = () => options.tabs ?? (options.tab === undefined ? [] : [options.tab as chrome.tabs.Tab])
  const query = vi.fn(async (queryInfo?: chrome.tabs.QueryInfo) => Object.keys(queryInfo ?? {}).length === 0
    ? allTabs()
    : (options.tab === undefined ? [] : [options.tab]))
  const get = vi.fn(async (tabId: number) => {
    const found = allTabs().find((tab) => tab.id === tabId)
    if (found === undefined) throw new Error(`No tab with id: ${tabId}`)
    return { ...found }
  })
  const update = vi.fn(async (_tabId: number, changes: chrome.tabs.UpdateProperties) => ({ ...options.tab, ...changes }))
  const goBack = vi.fn(async () => undefined)
  const goForward = vi.fn(async () => undefined)
  const reload = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const getAllFrames = vi.fn(async () => currentFrames())
  vi.stubGlobal('chrome', {
    tabs: { query, get, sendMessage, update, goBack, goForward, reload, remove },
    scripting: { executeScript },
    webNavigation: { getAllFrames },
    runtime: {
      onMessage: {
        addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
          runtimeListeners.add(listener)
        },
        removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
          runtimeListeners.delete(listener)
        },
      },
    },
  })
  const emitContentReady = (tabId: number, frameId: number, documentId: string): void => {
    for (const listener of runtimeListeners) {
      listener({ type: 'DSH_CONTENT_READY' }, { tab: { id: tabId }, frameId, documentId } as chrome.runtime.MessageSender)
    }
  }
  return { emitContentReady, executeScript, get, getAllFrames, goBack, goForward, query, reload, remove, sendMessage, update }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isNavigationCandidateTool', () => {
  it('classifies only tools that may change the page checkpoint', () => {
    expect(isNavigationCandidateTool('browser_click')).toBe(true)
    expect(isNavigationCandidateTool('browser_navigate')).toBe(true)
    expect(isNavigationCandidateTool('browser_open_tab')).toBe(true)
    expect(isNavigationCandidateTool('browser_snapshot')).toBe(false)
    expect(isNavigationCandidateTool('browser_type')).toBe(false)
  })
})

describe('dispatchToolCall', () => {
  it.each([[1, .5], [-.1, .5], [.3, Infinity], [.3, NaN]])('rejects invalid image fractions %s, %s before native reads or approval', async (x, y) => {
    const h = mockChrome({ tab: { id: 7, url: 'https://example.com' } })
    const authorize = vi.fn(async () => 'approved' as const)
    const answer = await dispatchToolCall({ id: 'invalid-point', name: 'browser_click_at', args: { screenshotRef: 'shot_synthetic', x, y } },
      'auto', undefined, authorize)
    expect(answer).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    expect(authorize).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled(); expect(h.sendMessage).not.toHaveBeenCalled()
  })
  it('returns an empty admitted scope without querying tabs or requesting page-read approval', async () => {
    const h = mockChrome({ tabs: [managedTab(91, { title: 'Private synthetic tab', url: 'https://private.example/' })] })
    const authorize = vi.fn(async () => 'denied' as const)
    const answer = await dispatchToolCall({ id: 'empty-tab-scope', name: 'browser_list_tabs', args: {} }, 'off',
      undefined, authorize, undefined, undefined, undefined,
      { unrestrictedAccess: false, emptyAuthorizedScope: true, allowsTab: () => false })
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('"tabs":[]')
    expect((answer.result as { text: string }).text).not.toContain('private.example')
    expect(authorize).not.toHaveBeenCalled()
    expect(h.query).not.toHaveBeenCalled()
  })
  it('uses an already-loaded content script without injecting', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('page')
    expect((answer.result as { text: string }).text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('injects content.js and retries for a page opened before extension load', async () => {
    const budget = { maxItems: 80, maxChars: 16_000 }
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://example.com/already-open' },
      responses: [new Error('Could not establish connection. Receiving end does not exist.'), OK],
    })

    const answer = await dispatchToolCall(CALL, 'auto', budget)
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('page')
    expect(chromeMock.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [0] },
      files: ['content.js'],
    })
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeMock.sendMessage).toHaveBeenLastCalledWith(7, {
      type: 'DSH_ACTION',
      action: 'browser_snapshot',
      args: { delta: false },
      budget: { maxItems: budget.maxItems, maxChars: expect.any(Number) },
    }, { documentId: 'document-7' })
    const sentBudget = (chromeMock.sendMessage.mock.lastCall?.[1] as { budget: { maxChars: number } }).budget
    expect(sentBudget.maxChars).toBeLessThan(budget.maxChars)
  })

  it('does not retry or roll back a dispatched action when its response port closes', async () => {
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://example.com/form' },
      responses: [new Error('The message port closed before a response was received.')],
    })
    const commitAction = vi.fn()
    const rollbackActionCommit = vi.fn()

    const answer = await dispatchToolCall(
      { id: 'port-closed', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: true, commitAction, rollbackActionCommit },
    )

    expect(answer).toMatchObject({
      ok: false,
      error: { code: 'content-unavailable', message: expect.stringContaining('operation was dispatched') },
    })
    expect(commitAction).toHaveBeenCalledOnce()
    expect(rollbackActionCommit).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).toHaveBeenCalledOnce()
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('returns browser-level metadata without injecting into Chrome internal pages', async () => {
    const chromeMock = mockChrome({
      tab: { id: 8, windowId: 3, title: 'Extensions', url: 'chrome://extensions' },
      responses: [new Error('no receiver')],
    })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer).toMatchObject({ ok: true })
    expect((answer.result as { text: string }).text).toContain('browser-level controls')
    expect((answer.result as { text: string }).text).toContain('chrome://extensions')
    expect((answer.result as { text: string }).text).toContain('Title: Extensions')
    expect((answer.result as { text: string }).text).toContain('Window ID: 3')
    expect((answer.result as { text: string }).text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('falls back to browser-level metadata when recovery injection is blocked', async () => {
    mockChrome({
      tab: { id: 9, url: 'https://chromewebstore.google.com/detail/example' },
      responses: [new Error('Could not establish connection. Receiving end does not exist.')],
      injectionError: new Error('Cannot access contents of the page'),
    })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer).toMatchObject({ ok: true })
    expect((answer.result as { text: string }).text).toContain('browser-level controls')
    expect((answer.result as { text: string }).text).toContain('chromewebstore.google.com')
  })

  it('uses browser-level navigation, history, and reload on protected pages', async () => {
    const chromeMock = mockChrome({ tab: { id: 8, url: 'chrome://newtab/' } })
    const commitAction = vi.fn()
    await expect(dispatchToolCall(
      { id: 'navigate-protected', name: 'browser_navigate', args: { url: 'https://example.com/path' } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: false, commitAction },
    )).resolves.toMatchObject({ ok: true })
    expect(chromeMock.update).toHaveBeenCalledWith(8, { url: 'https://example.com/path' })

    for (const [name, operation] of [
      ['browser_back', chromeMock.goBack],
      ['browser_forward', chromeMock.goForward],
      ['browser_reload', chromeMock.reload],
    ] as const) {
      await expect(dispatchToolCall(
        { id: name, name, args: {} },
        'auto',
        undefined,
        async () => 'approved',
        undefined,
        undefined,
        undefined,
        { unrestrictedAccess: false, commitAction },
      )).resolves.toMatchObject({ ok: true })
      expect(operation).toHaveBeenCalledWith(8)
    }
    expect(commitAction).toHaveBeenCalledTimes(4)
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects DOM actions on protected pages before requesting approval', async () => {
    const chromeMock = mockChrome({ tab: { id: 8, url: 'about:config' } })
    const authorize = vi.fn(async () => 'approved' as const)

    await expect(dispatchToolCall(
      { id: 'click-protected', name: 'browser_click', args: { elementRef: 'obs_test:1' } },
      'auto', undefined, authorize,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'content-unavailable', message: expect.stringContaining('DOM is protected') },
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects a select without a snapshot of its current document', async () => {
    const chromeMock = mockChrome({ tab: { id: 981, url: 'https://example.com/' } })
    const authorize = vi.fn(async () => 'approved' as const)
    await expect(dispatchToolCall(
      { id: 'unobserved-select', name: 'browser_select', args: { elementRef: 'obs_test:1', optionIndex: 0 } },
      'auto', undefined, authorize,
    )).resolves.toMatchObject({
      ok: false, error: { message: expect.stringContaining('does not belong to the current document') },
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects legacy bare-index calls before requesting approval or dispatching', async () => {
    const chromeMock = mockChrome({ tab: { id: 982, url: 'https://example.com/' } })
    const authorize = vi.fn(async () => 'approved' as const)
    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()
    const answer = await dispatchToolCall(
      { id: 'legacy-click', name: 'browser_click', args: { index: 1 } },
      'auto', undefined, authorize,
    )
    expect(answer).toMatchObject({ ok: false, error: { code: 'bad-args', message: expect.stringContaining('elementRef') } })
    expect(authorize).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('reserves wrapper and frame overhead before receiving reference-bearing snapshots', async () => {
    const frames = Array.from({ length: 6 }, (_, frameId) => ({
      frameId, parentFrameId: frameId === 0 ? -1 : 0,
      documentId: `budget-doc-${frameId}`, url: `https://frame${frameId}.example/`,
    }))
    mockChrome({
      tab: { id: 983, url: frames[0]!.url }, frames,
      respond: (message) => {
        const maxChars = (message as { budget: { maxChars: number } }).budget.maxChars
        return { ok: true, result: { text: 'x'.repeat(maxChars) } }
      },
    })
    const answer = await dispatchToolCall(CALL, 'auto', { maxItems: 60, maxChars: 4_000 })
    const text = (answer.result as { text: string }).text
    expect(answer.ok).toBe(true)
    expect(text.length).toBeLessThanOrEqual(4_000)
    expect(text).toContain('iframe frame=5')
    expect(text).not.toContain('truncated to the secure boundary budget')
  })

  it('reports an unusable main-frame budget instead of returning an empty successful snapshot', async () => {
    const chromeMock = mockChrome({ tab: { id: 985, url: 'https://example.com/' } })
    const answer = await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 500 })
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('budget is too small') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it.each(['navigation', 'tab closure'])('discards a snapshot invalidated by %s while its response is pending', async (reason) => {
    let finish!: (value: unknown) => void
    mockChrome({
      tab: { id: 984, url: 'https://example.com/' },
      respond: () => new Promise((resolve) => { finish = resolve }),
    })
    const pending = dispatchToolCall(CALL, 'auto')
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    if (reason === 'navigation') resetTabSnapshot(984)
    else forgetTabSnapshot(984)
    finish({ ok: true, result: { text: 'outdated page' } })
    await expect(pending).resolves.toMatchObject({
      ok: false, error: { message: expect.stringContaining('changed while the snapshot') },
    })
  })

  it('lists, follows, and closes selected tabs without activating them', async () => {
    const tabs = [
      managedTab(11, { active: true, title: 'Inbox', url: 'https://mail.example/inbox' }),
      managedTab(12, { windowId: 2, title: 'Docs', url: 'https://docs.example/guide' }),
    ]
    const chromeMock = mockChrome({ tabs })
    const authorize = vi.fn(async () => 'approved' as const)
    const followTab = vi.fn(async () => undefined)
    const commitAction = vi.fn()
    const context = { unrestrictedAccess: false, controlledTabId: 11, followTab, commitAction }

    const listed = await dispatchToolCall(
      { id: 'list-tabs', name: 'browser_list_tabs', args: {} },
      'auto', undefined, authorize, undefined, undefined, undefined, context,
    )
    expect((listed.result as { text: string }).text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect((listed.result as { text: string }).text).toContain('https://docs.example/guide')
    expect((listed.result as { text: string }).text).toContain('"controlled": true')

    await expect(dispatchToolCall(
      { id: 'follow-tab', name: 'browser_follow_tab', args: { tabId: 12 } },
      'auto', undefined, authorize, undefined, undefined, undefined, context,
    )).resolves.toMatchObject({ ok: true })
    expect(followTab).toHaveBeenCalledWith(expect.objectContaining({ id: 12 }))
    expect(chromeMock.update).not.toHaveBeenCalled()

    await expect(dispatchToolCall(
      { id: 'close-tab', name: 'browser_close_tab', args: { tabId: 12 } },
      'auto', undefined, authorize, undefined, undefined, undefined, context,
    )).resolves.toMatchObject({ ok: true })
    expect(chromeMock.get).toHaveBeenCalledTimes(4)
    expect(chromeMock.remove).toHaveBeenCalledWith(12)
    expect(commitAction).toHaveBeenCalledTimes(2)
  })

  it('skips sharing blocks and approval prompts only in unrestricted mode', async () => {
    const authorize = vi.fn(async () => 'denied' as const)
    mockChrome({ tab: { id: 8, url: 'https://example.com/' }, tabs: [managedTab(8)] })

    await expect(dispatchToolCall(
      CALL, 'off', undefined, authorize, undefined, undefined, undefined,
      { unrestrictedAccess: true },
    )).resolves.toMatchObject({ ok: true })
    await expect(dispatchToolCall(
      { id: 'list-unrestricted', name: 'browser_list_tabs', args: {} },
      'ask', undefined, authorize, undefined, undefined, undefined,
      { unrestrictedAccess: true },
    )).resolves.toMatchObject({ ok: true })
    await expect(dispatchToolCall(
      { id: 'navigate-unrestricted', name: 'browser_navigate', args: { url: 'https://docs.example/' } },
      'ask', undefined, authorize, undefined,
      { id: 9, url: 'chrome://newtab/' }, undefined,
      { unrestrictedAccess: true },
    )).resolves.toMatchObject({ ok: true })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('does not follow a tab that navigates while approval is pending', async () => {
    const target = managedTab(12, { url: 'https://docs.example/guide' })
    const followTab = vi.fn(async () => undefined)
    mockChrome({ tabs: [target] })

    await expect(dispatchToolCall(
      { id: 'follow-navigated', name: 'browser_follow_tab', args: { tabId: 12 } },
      'auto', undefined, async () => {
        target.url = 'https://bank.example/transfer'
        return 'approved'
      }, undefined, undefined, undefined,
      { unrestrictedAccess: false, followTab },
    )).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('navigated while approval was pending') },
    })
    expect(followTab).not.toHaveBeenCalled()
  })

  it('keeps the page-sharing privacy boundary ahead of tab access', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })

    await expect(dispatchToolCall(CALL, 'off')).resolves.toMatchObject({
      ok: false,
      error: { code: 'action-failed' },
    })
    expect(chromeMock.query).not.toHaveBeenCalled()
  })

  it('blocks layout reads before tab access when page sharing is off', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })
    const answer = await dispatchToolCall({ id: 'layout-off', name: 'browser_measure_layout', args: { selector: '.card' } }, 'off')
    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(chromeMock.query).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('requests layout read approval without offering action trust, and honors revocation during approval', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })
    let allowed = true
    const authorize = vi.fn(async () => { allowed = false; return 'approved' as const })
    const answer = await dispatchToolCall({ id: 'layout-ask', name: 'browser_measure_layout', args: { selector: '.card' } },
      'ask', undefined, authorize, undefined, { id: 7, url: 'https://example.com' }, () => allowed)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ kind: 'read', action: 'browser_measure_layout', canTrust: false }))
    expect(answer.ok).toBe(false)
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('dispatches to an explicitly bound background tab without querying the active tab', async () => {
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://active.example/' },
      frames: [{ frameId: 0, parentFrameId: -1, documentId: 'bound-doc', url: 'https://bound.example/' }],
    })

    const answer = await dispatchToolCall(
      CALL,
      'auto',
      undefined,
      undefined,
      undefined,
      { id: 88, url: 'https://bound.example/' },
    )

    expect(answer.ok).toBe(true)
    expect(chromeMock.query).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(88, expect.any(Object), { documentId: 'bound-doc' })
  })

  it('aggregates top-level and cross-origin iframe snapshots', async () => {
    const chromeMock = mockChrome({
      tab: { id: 21, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
        { frameId: 4, parentFrameId: 0, documentId: 'child-doc', url: 'https://login.example.net/form' },
      ],
      respond: (_message, frameId) => ({ ok: true, result: { text: frameId === 0 ? 'TOP SNAPSHOT' : 'IFRAME SNAPSHOT' } }),
    })

    const answer = await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })

    expect(answer).toMatchObject({ ok: true })
    const text = (answer.result as { text: string }).text
    expect(text).toContain('TOP SNAPSHOT')
    expect(text).toContain('iframe frame=4 parent=0 origin=https://login.example.net')
    expect(text).toContain('IFRAME SNAPSHOT')
    expect(chromeMock.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      { documentId: 'top-doc' },
      { documentId: 'child-doc' },
    ])
  })

  it('routes an element action to the requested frame and removes routing metadata', async () => {
    const call: ToolCall = { id: 'tool-frame', name: 'browser_click', args: { frame: 8, elementRef: 'obs_test:3' } }
    const chromeMock = mockChrome({
      tab: { id: 22, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
        { frameId: 8, parentFrameId: 0, documentId: 'child-doc', url: 'https://widget.example/' },
      ],
      respond: (message, frameId) => {
        const action = (message as { action?: string }).action
        if (action === 'browser_snapshot') return { ok: true, result: { text: `frame ${frameId}` } }
        return OK
      },
    })

    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()
    await expect(dispatchToolCall(call, 'auto', undefined, async () => 'approved')).resolves.toEqual(OK)
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(22, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { elementRef: 'obs_test:3' },
      budget: expect.objectContaining({ maxItems: 60 }),
      includePageDelta: true,
    }, { documentId: 'child-doc' })
  })

  it('returns automatic action deltas inside a fresh untrusted-content boundary', async () => {
    const call: ToolCall = { id: 'tool-delta', name: 'browser_click', args: { elementRef: 'obs_test:3' } }
    const budget = { maxItems: 10, maxChars: 1_000 }
    const chromeMock = mockChrome({
      tab: { id: 33, url: 'https://app.example/' },
      respond: (message) => (message as { action?: string }).action === 'browser_snapshot'
        ? { ok: true, result: { text: 'Initial page' } }
        : {
            ok: true,
            result: {
              text: 'Clicked [3].',
              pageContent: 'Page change v2\nChanged main content:\nOrder complete',
            },
          },
    })
    await dispatchToolCall(CALL, 'auto', budget)
    chromeMock.sendMessage.mockClear()

    const answer = await dispatchToolCall(call, 'auto', budget, async () => 'approved')

    expect(answer.ok).toBe(true)
    const result = answer.result as { text: string; pageContent?: string }
    expect(result.text).toContain('Clicked [3].')
    expect(result.text).toContain('Only shown references are current')
    expect(result.text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(result.text).toContain('Order complete')
    expect(result.text.length).toBeLessThanOrEqual(budget.maxChars)
    expect(result.pageContent).toBeUndefined()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(33, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { elementRef: 'obs_test:3' },
      budget: { maxItems: budget.maxItems, maxChars: expect.any(Number) },
      includePageDelta: true,
    }, { documentId: 'document-33' })
  })

  it('does not extract or forward an action delta when reads require approval', async () => {
    const call: ToolCall = { id: 'tool-private-delta', name: 'browser_click', args: { elementRef: 'obs_test:2' } }
    const chromeMock = mockChrome({
      tab: { id: 34, url: 'https://private.example/' },
      respond: (message) => (message as { action?: string }).action === 'browser_snapshot'
        ? { ok: true, result: { text: 'Initial private page' } }
        : {
            ok: true,
            result: {
              text: 'Clicked [2].',
              pageContent: 'This content must not cross the sharing boundary',
            },
          },
    })
    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()

    const commitAction = vi.fn()
    const answer = await dispatchToolCall(
      call,
      'ask',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: false, commitAction },
    )

    expect(answer).toEqual({ ok: true, result: { text: 'Clicked [2].' } })
    expect(commitAction).toHaveBeenCalledOnce()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(34, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { elementRef: 'obs_test:2' },
    }, { documentId: 'document-34' })
  })

  it('returns the replacement page snapshot in the same navigation tool call', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'document-before', url: 'https://app.example/start' },
    ]
    const budget = { maxItems: 10, maxChars: 2_000 }
    const chromeMock = mockChrome({
      tab: { id: 35, url: 'https://app.example/start' },
      frames,
      respond: (message) => (message as { action?: string }).action === 'browser_navigate'
        ? {
            ok: true,
            result: {
              text: 'Navigating to https://app.example/next. Call browser_snapshot again after the page loads.',
              navigationPending: true,
            },
          }
        : { ok: true, result: { text: 'Title: Next page\nURL: https://app.example/next' } },
    })

    const pending = dispatchToolCall(
      { id: 'tool-navigation', name: 'browser_navigate', args: { url: 'https://app.example/next' } },
      'auto',
      budget,
      async () => 'approved',
    )
    await vi.waitFor(() => { expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1) })
    frames[0] = {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'document-after',
      url: 'https://app.example/next',
    }
    chromeMock.emitContentReady(35, 0, 'document-after')

    const answer = await pending
    const text = (answer.result as { text: string }).text
    expect(text).toContain('Navigation completed')
    expect(text).toContain('Title: Next page')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text).not.toContain('Call browser_snapshot again')
    expect(text.length).toBeLessThanOrEqual(budget.maxChars)
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeMock.sendMessage).toHaveBeenLastCalledWith(35, expect.objectContaining({
      action: 'browser_snapshot',
      args: { delta: false },
      budget: expect.objectContaining({ maxChars: expect.any(Number) }),
    }), { documentId: 'document-after' })
  })

  it('does not wait for or return navigation page content when reads are not automatic', async () => {
    const chromeMock = mockChrome({
      tab: { id: 36, url: 'https://app.example/start' },
      respond: () => ({
        ok: true,
        result: {
          text: 'Navigating to https://app.example/next. Call browser_snapshot again after the page loads.',
          navigationPending: true,
        },
      }),
    })

    const answer = await dispatchToolCall(
      { id: 'tool-private-navigation', name: 'browser_navigate', args: { url: 'https://app.example/next' } },
      'ask',
      undefined,
      async () => 'approved',
    )

    expect(answer).toEqual({
      ok: true,
      result: { text: expect.stringContaining('Call browser_snapshot again') },
    })
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('wraps browser_get_text output in the same untrusted-content boundary', async () => {
    const call: ToolCall = { id: 'tool-text', name: 'browser_get_text', args: {} }
    mockChrome({ tab: { id: 24, url: 'https://app.example/' }, responses: [{ ok: true, result: { text: 'page text' } }] })

    const answer = await dispatchToolCall(call, 'auto', { maxItems: 10, maxChars: 1_000 })

    const text = (answer.result as { text: string }).text
    expect(text).toContain('page text')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text.length).toBeLessThanOrEqual(1_000)
  })

  it('keeps layout data inside the read boundary without truncating it to an action-status line', async () => {
    const text = JSON.stringify({ target: { selector: '.card', css: { padding: { top: '20px' } } }, observation: 'synthetic '.repeat(50) })
    mockChrome({ tab: { id: 24, url: 'https://app.example/' }, responses: [{ ok: true, result: { text } }] })
    const answer = await dispatchToolCall({ id: 'layout-text', name: 'browser_measure_layout', args: { selector: '.card' } }, 'auto', { maxItems: 10, maxChars: 2000 })
    const output = (answer.result as { text: string }).text
    expect(output).toContain(text)
    expect(output).toContain('UNTRUSTED_PAGE_CONTENT')
  })

  it('requires action approval and refuses delivery after revocation during design zoom confirmation', async () => {
    const chromeMock = mockChrome({ tab: { id: 24, url: 'https://app.example/' } })
    let current = true
    const authorize = vi.fn(async prompt => {
      expect(prompt).toMatchObject({ kind: 'action', action: 'browser_set_design_zoom', origins: ['https://app.example'] })
      current = false
      return 'approved' as const
    })
    const answer = await dispatchToolCall({ id: 'zoom-revoked', name: 'browser_set_design_zoom', args: { percent: 150 } }, 'auto', undefined, authorize,
      undefined, { id: 24, url: 'https://app.example/' }, () => current)
    expect(answer.ok).toBe(false)
    expect(authorize).toHaveBeenCalledOnce()
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it.each(['success', 'revoked', 'cancelled', 'invalid', 'receiver-lost', 'repeated'] as const)('keeps staged design zoom on its original scope, %s', async mode => {
    const controller = new AbortController(), phases: string[] = [], rollback = vi.fn()
    let current = true
    const h = mockChrome({ tab: { id: 24, url: 'https://app.example/' }, respond: message => {
      const m = message as { action?: string; args?: { phase?: string } }
      if (m.action !== 'browser_set_design_zoom') return OK
      phases.push(m.args!.phase!)
      if (m.args!.phase === 'prepare') {
        if (mode === 'revoked') current = false
        if (mode === 'cancelled') controller.abort()
        return { ok: true, result: { text: 'prepared', designZoomStep: { ...ZOOM_STEP, ...(mode === 'invalid' ? { percent: 201 } : {}) } } }
      }
      if (mode === 'receiver-lost') return new Error('Receiving end does not exist')
      if (mode === 'repeated') return { ok: true, result: { text: 'prepared again', designZoomStep: ZOOM_STEP } }
      return OK
    } })
    const answer = await dispatchToolCall({ id: 'zoom-staged', name: 'browser_set_design_zoom', args: { percent: 150, phase: 'forged', ticket: 'forged' } },
      'auto', undefined, async () => 'approved', controller.signal, { id: 24, url: 'https://app.example/' }, () => current,
      { unrestrictedAccess: false, rollbackActionCommit: rollback })
    expect(answer.ok).toBe(mode === 'success')
    expect(phases).toEqual(mode === 'success' || mode === 'receiver-lost' || mode === 'repeated' ? ['prepare', 'commit'] : ['prepare'])
    expect(JSON.stringify(answer)).not.toContain(ZOOM_STEP.ticket)
    expect(h.executeScript).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('refuses an oversized layout observation instead of reporting truncated JSON as success', async () => {
    mockChrome({ tab: { id: 24, url: 'https://app.example/' }, responses: [{ ok: true, result: { text: JSON.stringify({ observation: 'x'.repeat(1000) }) } }] })
    const answer = await dispatchToolCall({ id: 'layout-small-budget', name: 'browser_measure_layout', args: { selector: '.card' } }, 'auto', { maxItems: 10, maxChars: 500 })
    expect(answer).toMatchObject({ ok: false, error: { code: 'content-unavailable', message: expect.stringContaining('text sharing budget') } })
  })

  it('returns the explicit user denial before reading', async () => {
    const authorize = vi.fn(async () => 'denied' as const)
    const chromeMock = mockChrome({
      tab: { id: 25, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://app.example/' },
        { frameId: 2, parentFrameId: 0, documentId: 'child', url: 'https://embed.example.net/' },
      ],
    })

    const answer = await dispatchToolCall(CALL, 'ask', undefined, authorize)

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'action-failed',
        message: 'The user denied the browser approval request for "browser_snapshot".',
      },
    })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'read',
      origins: ['https://app.example', 'https://embed.example.net'],
    }))
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('reports when no side panel can receive a state-changing approval', async () => {
    const call: ToolCall = { id: 'tool-denied', name: 'browser_press', args: { key: 'Enter' } }
    const chromeMock = mockChrome({ tab: { id: 26, url: 'https://app.example/' } })

    const answer = await dispatchToolCall(call, 'auto')

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'action-failed',
        message: 'No browser side panel was available to receive or complete the approval request for "browser_press".',
      },
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('returns an approval timeout without treating it as a user denial', async () => {
    const call: ToolCall = { id: 'tool-timeout', name: 'browser_press', args: { key: 'Enter' } }
    const chromeMock = mockChrome({ tab: { id: 27, url: 'https://app.example/' } })

    const answer = await dispatchToolCall(call, 'auto', undefined, async () => 'timed-out')

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'timeout',
        message: 'The browser approval request for "browser_press" timed out before the user responded.',
      },
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('does not dispatch an action after its bridge call is cancelled during approval', async () => {
    const call: ToolCall = { id: 'tool-cancelled', name: 'browser_press', args: { key: 'Enter' } }
    const controller = new AbortController()
    const chromeMock = mockChrome({ tab: { id: 27, url: 'https://app.example/' } })
    const authorize = vi.fn(async () => {
      controller.abort()
      return 'approved' as const
    })

    const answer = await dispatchToolCall(call, 'auto', undefined, authorize, controller.signal)

    expect(answer).toMatchObject({ ok: false, error: { code: 'bridge-closed' } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('does not dispatch an approved action after tab affinity changes', async () => {
    const call: ToolCall = { id: 'tool-switched', name: 'browser_press', args: { key: 'Enter' } }
    let targetAllowed = true
    const chromeMock = mockChrome({ tab: { id: 28, url: 'https://app.example/' } })
    const authorize = vi.fn(async () => {
      targetAllowed = false
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      call,
      'auto',
      undefined,
      authorize,
      undefined,
      { id: 28, url: 'https://app.example/' },
      () => targetAllowed,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('controlled tab') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an element reference after its frame document reloads', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 3, parentFrameId: 0, documentId: 'child-v1', url: 'https://widget.example/form' },
    ]
    const chromeMock = mockChrome({
      tab: { id: 30, url: 'https://app.example/' },
      frames,
      respond: (_message, frameId) => ({ ok: true, result: { text: `frame ${frameId}` } }),
    })
    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()
    frames[1] = { ...frames[1]!, documentId: 'child-v2' }

    const answer = await dispatchToolCall(
      { id: 'stale-click', name: 'browser_click', args: { frame: 3, elementRef: 'obs_test:4' } },
      'auto',
      undefined,
      async () => 'approved',
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('Call browser_snapshot again') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an action when its target origin changes during approval', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-v1', url: 'https://app.example/' },
    ]
    const chromeMock = mockChrome({ tab: { id: 31, url: 'https://app.example/' }, frames })
    const authorize = vi.fn(async () => {
      frames[0] = { ...frames[0]!, documentId: 'top-v2', url: 'https://evil.example/' }
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      { id: 'changed-origin', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('page changed while approval was pending') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an action when the same-origin document changes during approval', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-v1', url: 'https://app.example/one' },
    ]
    const chromeMock = mockChrome({ tab: { id: 32, url: 'https://app.example/one' }, frames })
    const authorize = vi.fn(async () => {
      frames[0] = { ...frames[0]!, documentId: 'top-v2', url: 'https://app.example/two' }
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      { id: 'changed-document', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('page changed while approval was pending') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('forces a full snapshot for a newly navigated frame before resuming deltas', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 6, parentFrameId: 0, documentId: 'child-v1', url: 'https://widget.example/one' },
    ]
    const seen: Array<{ frameId: number; delta: unknown }> = []
    const chromeMock = mockChrome({
      tab: { id: 23, url: 'https://app.example/' },
      frames,
      respond: (message, frameId) => {
        seen.push({ frameId, delta: (message as { args?: { delta?: unknown } }).args?.delta })
        return { ok: true, result: { text: `frame ${frameId}` } }
      },
    })
    const deltaCall: ToolCall = { ...CALL, id: 'delta', args: { delta: true } }

    await dispatchToolCall(deltaCall, 'auto')
    expect(seen.splice(0)).toEqual([{ frameId: 0, delta: false }, { frameId: 6, delta: false }])

    await dispatchToolCall(deltaCall, 'auto')
    expect(seen.splice(0)).toEqual([{ frameId: 0, delta: true }, { frameId: 6, delta: true }])

    frames[1] = { ...frames[1]!, documentId: 'child-v2', url: 'https://widget.example/two' }
    await dispatchToolCall(deltaCall, 'auto')
    expect(seen).toEqual([{ frameId: 0, delta: true }, { frameId: 6, delta: false }])
    expect(chromeMock.getAllFrames).toHaveBeenCalledTimes(3)
  })
})

describe('dispatchOpenTab', () => {
  it('creates a blank tab, navigates after arming readiness, rebinds, and snapshots', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
    const create = vi.fn(async () => ({ id: 42, windowId: 9, url: '' }))
    const update = vi.fn(async () => ({ id: 42, windowId: 9, url: 'https://docs.example/' }))
    const remove = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => ({ ok: true, result: { text: 'new page' } }))
    const getAllFrames = vi.fn(async () => [{
      frameId: 0, parentFrameId: -1, documentId: 'doc-42', url: 'https://docs.example/',
    }])
    vi.stubGlobal('chrome', {
      tabs: { create, update, remove, sendMessage, query: vi.fn(async () => []) },
      scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
      webNavigation: { getAllFrames },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.add(listener)
          },
          removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.delete(listener)
          },
        },
      },
    })

    const bindCreatedTab = vi.fn(() => true)
    const commitAction = vi.fn()
    const open = dispatchOpenTab(
      { id: 'open-1', name: 'browser_open_tab', args: { url: 'https://docs.example/' } },
      9,
      'auto',
      { maxItems: 60, maxChars: 12_000 },
      async () => 'approved',
      undefined,
      bindCreatedTab,
      () => true,
      commitAction,
    )
    await vi.waitFor(() => { expect(runtimeListeners.size).toBe(1) })
    expect(create).toHaveBeenCalledWith({ active: true, windowId: 9 })
    expect(update).toHaveBeenCalledWith(42, { url: 'https://docs.example/' })
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 42 }, frameId: 0, documentId: 'blank-doc', url: 'about:blank',
        } as chrome.runtime.MessageSender,
      )
    }
    await Promise.resolve()
    expect(bindCreatedTab).not.toHaveBeenCalled()
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 42 }, frameId: 0, documentId: 'doc-42', url: 'https://docs.example/',
        } as chrome.runtime.MessageSender,
      )
    }
    const answer = await open
    expect(bindCreatedTab).toHaveBeenCalledOnce()
    expect(commitAction).toHaveBeenCalledOnce()
    expect(remove).not.toHaveBeenCalled()
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('Opened a new tab')
    expect((answer.result as { text: string }).text).toContain('new page')
  })

  it('opens a background tab when active is false', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const { bindOpenedTabAffinity } = await import('../src/background/open-tab-binding.ts')
    const { TabAffinityController } = await import('../src/background/tab-affinity.ts')
    const affinity = new TabAffinityController()
    affinity.observeActive({
      tabId: 1,
      windowId: 9,
      title: 'Current',
      url: 'https://current.example/',
    })
    affinity.bindInitial({
      tabId: 1,
      windowId: 9,
      title: 'Current',
      url: 'https://current.example/',
    }, 'session-bg')

    const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
    const create = vi.fn(async () => ({ id: 42, windowId: 9, url: '' }))
    const update = vi.fn(async () => ({ id: 42, windowId: 9, url: 'https://docs.example/' }))
    const remove = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => ({
      type: 'DSH_RESULT',
      text: 'new page',
    }))
    const getAllFrames = vi.fn(async () => [{
      frameId: 0, parentFrameId: -1, documentId: 'doc-42', url: 'https://docs.example/',
    }])
    vi.stubGlobal('chrome', {
      tabs: { create, update, remove, sendMessage, query: vi.fn(async () => []) },
      scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
      webNavigation: { getAllFrames },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.add(listener)
          },
          removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.delete(listener)
          },
        },
      },
    })

    const bindCreatedTab = (chromeTab: chrome.tabs.Tab) => {
      if (chromeTab.id === undefined) return false
      return bindOpenedTabAffinity(affinity, {
        tabId: chromeTab.id,
        windowId: chromeTab.windowId,
        title: chromeTab.title ?? '',
        url: chromeTab.url ?? '',
      }, { active: false, sessionId: 'session-bg' })
    }
    const open = dispatchOpenTab(
      { id: 'open-bg', name: 'browser_open_tab', args: { url: 'https://docs.example/', active: false } },
      9,
      'auto',
      { maxItems: 60, maxChars: 12_000 },
      async () => 'approved',
      undefined,
      bindCreatedTab,
      () => true,
    )
    await vi.waitFor(() => { expect(runtimeListeners.size).toBe(1) })
    expect(create).toHaveBeenCalledWith({ active: false, windowId: 9 })
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 42 }, frameId: 0, documentId: 'blank-doc', url: 'about:blank',
        } as chrome.runtime.MessageSender,
      )
    }
    await Promise.resolve()
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 42 }, frameId: 0, documentId: 'doc-42', url: 'https://docs.example/',
        } as chrome.runtime.MessageSender,
      )
    }
    const answer = await open
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('Opened a new background tab')
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      active: { tabId: 1 },
      controlled: { tabId: 42 },
    })
    expect(affinity.resolveTarget('session-bg')).toMatchObject({
      kind: 'target',
      tab: { tabId: 42 },
    })
    expect(affinity.allowsTarget(42)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)
  })

  it('rejects non-http URLs before creating a tab', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const create = vi.fn()
    vi.stubGlobal('chrome', { tabs: { create } })
    const answer = await dispatchOpenTab(
      { id: 'open-bad', name: 'browser_open_tab', args: { url: 'javascript:alert(1)' } },
      1,
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      () => true,
      () => true,
    )
    expect(answer).toEqual({
      ok: false,
      error: { code: 'action-failed', message: 'url must be a complete http or https URL.' },
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('rolls back an unbound tab when cancelled before affinity bind', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const controller = new AbortController()
    const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
    const create = vi.fn(async () => ({ id: 55, windowId: 2, url: '' }))
    const update = vi.fn(async () => ({ id: 55, windowId: 2, url: 'https://docs.example/' }))
    const remove = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      tabs: { create, update, remove, sendMessage: vi.fn(), query: vi.fn(async () => []) },
      scripting: { executeScript: vi.fn(async () => []) },
      webNavigation: { getAllFrames: vi.fn(async () => []) },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.add(listener)
          },
          removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.delete(listener)
          },
        },
      },
    })
    const bindCreatedTab = vi.fn(() => true)
    const open = dispatchOpenTab(
      { id: 'open-cancel', name: 'browser_open_tab', args: { url: 'https://docs.example/' } },
      2,
      'auto',
      undefined,
      async () => 'approved',
      controller.signal,
      bindCreatedTab,
      () => true,
    )
    await vi.waitFor(() => { expect(runtimeListeners.size).toBe(1) })
    controller.abort()
    await expect(open).resolves.toMatchObject({
      ok: false,
      error: { code: 'bridge-closed' },
    })
    expect(remove).toHaveBeenCalledWith(55)
    expect(bindCreatedTab).not.toHaveBeenCalled()
  })

  it.each(['commit-revoked', 'metadata-failed', 'cancelled'])('revokes a newly authorized tab when adoption is %s, even if native close fails', async failure => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const controller = new AbortController()
    const created = { id: 56, windowId: 2, url: 'https://docs.example/' }
    let granted = false
    const release = vi.fn(async () => { granted = false })
    const remove = vi.fn(async () => { throw new Error('Synthetic native close failure') })
    const bind = vi.fn(() => true)
    vi.stubGlobal('chrome', {
      tabs: { create: vi.fn(async () => created), update: vi.fn(async () => created), remove,
        get: vi.fn(async () => {
          if (failure === 'metadata-failed') throw new Error('Synthetic metadata failure')
          if (failure === 'cancelled') controller.abort()
          return created
        }) },
      runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    })
    const answer = await dispatchOpenTab({ id: 'failed-adoption', name: 'browser_open_tab', args: { url: created.url } },
      2, 'auto', undefined, async () => 'approved', controller.signal, bind, () => true,
      () => { if (failure === 'commit-revoked') throw new Error('The original request was revoked') },
      false, async () => { granted = true }, () => ({ current: () => granted, release, canClose: () => true }))
    expect(answer.ok).toBe(false)
    expect(granted).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith(56)
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!)
    expect(bind).not.toHaveBeenCalled()
    expect(answer.error?.message).toContain('Tab closure is unconfirmed')
    expect(answer.error?.message).not.toContain('was closed')
  })

  it('keeps a page when its user authorization changes during cleanup persistence', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const created = { id: 57, windowId: 2, url: 'https://docs.example/' }
    const remove = vi.fn(async () => {})
    let finish!: () => void
    let owned = true
    const release = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    vi.stubGlobal('chrome', {
      tabs: { create: vi.fn(async () => created), update: vi.fn(async () => created), remove,
        get: vi.fn(async () => { throw new Error('Synthetic metadata failure') }) },
      runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    })
    const pending = dispatchOpenTab({ id: 'user-adopted', name: 'browser_open_tab', args: { url: created.url } },
      2, 'auto', undefined, async () => 'approved', undefined, () => true, () => true,
      undefined, false, async () => {}, () => ({ current: () => owned, release, canClose: () => owned }))
    await vi.waitFor(() => expect(release).toHaveBeenCalled())
    owned = false; finish()
    const answer = await pending
    expect(answer.ok).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(answer.error?.message).toContain('no close was attempted')
  })

  it('reports a committed open instead of cancellation after affinity bind', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const controller = new AbortController()
    const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
    const create = vi.fn(async () => ({ id: 77, windowId: 3, url: '' }))
    const update = vi.fn(async () => ({ id: 77, windowId: 3, url: 'https://docs.example/' }))
    const remove = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => ({ ok: true, result: { text: 'late page' } }))
    const getAllFrames = vi.fn(async () => [{
      frameId: 0, parentFrameId: -1, documentId: 'doc-77', url: 'https://docs.example/',
    }])
    vi.stubGlobal('chrome', {
      tabs: { create, update, remove, sendMessage, query: vi.fn(async () => []) },
      scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
      webNavigation: { getAllFrames },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.add(listener)
          },
          removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.delete(listener)
          },
        },
      },
    })
    const bindCreatedTab = vi.fn(() => {
      controller.abort()
      return true
    })
    const open = dispatchOpenTab(
      { id: 'open-committed', name: 'browser_open_tab', args: { url: 'https://docs.example/' } },
      3,
      'auto',
      { maxItems: 60, maxChars: 12_000 },
      async () => 'approved',
      controller.signal,
      bindCreatedTab,
      () => true,
    )
    await vi.waitFor(() => { expect(runtimeListeners.size).toBe(1) })
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 77 }, frameId: 0, documentId: 'doc-77', url: 'https://docs.example/',
        } as chrome.runtime.MessageSender,
      )
    }
    const answer = await open
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('Opened a new tab')
    expect((answer.result as { text: string }).text).toContain('Call browser_snapshot again')
    expect(remove).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
