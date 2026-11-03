// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capturePageScreenshot, consumeVisualObservation } from '../src/background/visual.ts'
import { debuggerPages, PageDispatchRevoked } from '../src/background/debugger-pages.ts'
import { dispatchToolCall } from '../src/background/tools.ts'
import type { VisualObservation } from '@eilyeee/dsh-browser-stride/src/visual.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture() {
  const view: VisualObservation = { screenshotRef: `shot_${crypto.randomUUID()}`, width: 1000, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 2 }
  const sendMessage = vi.fn(async () => ({ ok: true, result: { text: 'synthetic', visual: { ...view } } }))
  vi.stubGlobal('chrome', { tabs: { sendMessage }, webNavigation: { getAllFrames: vi.fn(async () => [
    { frameId: 0, parentFrameId: -1, documentId: 'synthetic-document', url: 'https://example.test/design' },
  ]) } })
  vi.spyOn(debuggerPages, 'has').mockReturnValue(false)
  vi.spyOn(debuggerPages, 'prepareViewportCapture').mockResolvedValue()
  const capture = vi.spyOn(debuggerPages, 'captureViewport').mockResolvedValue('/9j/2Q==')
  return { view, sendMessage, capture }
}
describe('visual scope ownership', () => {
  it('returns a bounded image and permits only one point in the original scope', async () => {
    const h = fixture(), authority = { scope: crypto.randomUUID(), current: () => true }
    const answer = await capturePageScreenshot(42, () => true, authority)
    expect(answer).toMatchObject({ ok: true, result: { mediaType: 'image/jpeg', screenshotRef: h.view.screenshotRef } })
    expect(h.capture).toHaveBeenCalledWith(42, h.view, expect.any(Function))
    expect(consumeVisualObservation(42, h.view.screenshotRef, { ...authority, scope: 'another session/revision' })).toBe(false)
    expect(consumeVisualObservation(99, h.view.screenshotRef, authority)).toBe(false)
    expect(consumeVisualObservation(42, h.view.screenshotRef, authority)).toBe(true)
    expect(consumeVisualObservation(42, h.view.screenshotRef, authority)).toBe(false)
  })
  it('cannot reuse image coordinates after the original permission, document or connection expires', async () => {
    const h = fixture(); let current = true
    const authority = { scope: crypto.randomUUID(), current: () => current }
    expect((await capturePageScreenshot(42, () => current, authority)).ok).toBe(true)
    current = false
    expect(consumeVisualObservation(42, h.view.screenshotRef, authority)).toBe(false)
  })
  it('withholds a late image or changed viewport and grants no coordinate reference', async () => {
    const h = fixture(), authority = { scope: crypto.randomUUID(), current: () => true }
    h.sendMessage.mockResolvedValueOnce({ ok: true, result: { text: 'before', visual: h.view } })
    h.sendMessage.mockResolvedValueOnce({ ok: true, result: { text: 'changed', visual: { ...h.view, width: 900 } } })
    expect((await capturePageScreenshot(42, () => true, authority)).ok).toBe(false)
    expect(consumeVisualObservation(42, h.view.screenshotRef, authority)).toBe(false)
  })
  it('does not attach or read a page without an original visual authority', async () => {
    const h = fixture()
    expect((await capturePageScreenshot(42, () => true)).ok).toBe(false)
    expect(h.sendMessage).not.toHaveBeenCalled(); expect(h.capture).not.toHaveBeenCalled()
  })
  it('reports a native debugging conflict without exposing native error data or reading the page', async () => {
    const h = fixture(), authority = { scope: crypto.randomUUID(), current: () => true }
    vi.mocked(debuggerPages.prepareViewportCapture).mockRejectedValue(new Error('private-native-detail'))
    const answer = await capturePageScreenshot(42, () => true, authority)
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('DevTools') } })
    expect(JSON.stringify(answer)).not.toContain('private-native-detail')
    expect(h.sendMessage).not.toHaveBeenCalled()
  })
  it('does not admit a reference after capture failure and preserves cancellation fences', async () => {
    const h = fixture(), authority = { scope: crypto.randomUUID(), current: () => true }
    h.capture.mockRejectedValueOnce(new Error('native capture failed'))
    expect((await capturePageScreenshot(42, () => true, authority)).ok).toBe(false)
    expect(consumeVisualObservation(42, h.view.screenshotRef, authority)).toBe(false)
    vi.mocked(debuggerPages.prepareViewportCapture).mockRejectedValueOnce(new PageDispatchRevoked())
    await expect(capturePageScreenshot(42, () => true, authority)).rejects.toBeInstanceOf(PageDispatchRevoked)
  })
  it('keeps only the latest screenshot owner on one page across many conversations', async () => {
    const h = fixture(), first = { scope: crypto.randomUUID(), current: () => true }
    expect((await capturePageScreenshot(73, () => true, first)).ok).toBe(true)
    const oldRef = h.view.screenshotRef
    let latest = first
    for (let index = 0; index < 130; index++) {
      h.view.screenshotRef = `shot_${crypto.randomUUID()}`
      latest = { scope: crypto.randomUUID(), current: () => true }
      expect((await capturePageScreenshot(73, () => true, latest)).ok).toBe(true)
    }
    expect(consumeVisualObservation(73, oldRef, first)).toBe(false)
    expect(consumeVisualObservation(73, h.view.screenshotRef, latest)).toBe(true)
  })
  it('withdraws the earlier screenshot reference when a newer capture fails', async () => {
    const h = fixture(), authority = { scope: crypto.randomUUID(), current: () => true }
    expect((await capturePageScreenshot(74, () => true, authority)).ok).toBe(true)
    const ref = h.view.screenshotRef
    h.view.screenshotRef = `shot_${crypto.randomUUID()}`
    h.capture.mockRejectedValueOnce(new Error('native capture failed'))
    expect((await capturePageScreenshot(74, () => true, authority)).ok).toBe(false)
    expect(consumeVisualObservation(74, ref, authority)).toBe(false)
  })
  it('withholds an old capture reply that arrives after a newer conversation captured the page', async () => {
    const h = fixture(), oldView = { ...h.view }
    const first = { scope: crypto.randomUUID(), current: () => true }
    const next = { scope: crypto.randomUUID(), current: () => true }
    type PageAnswer = Awaited<ReturnType<typeof h.sendMessage>>
    let finish!: (value: PageAnswer) => void
    h.sendMessage.mockImplementation(async (_tabId?: unknown, message?: unknown) => {
      const command = message as { action: string; args?: { screenshotRef?: string } }
      if (command.action === 'browser_visual_check' && command.args?.screenshotRef === oldView.screenshotRef) {
        return await new Promise<PageAnswer>(resolve => { finish = resolve })
      }
      return { ok: true, result: { text: 'synthetic', visual: { ...h.view } } }
    })
    const old = capturePageScreenshot(75, () => true, first)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    h.view.screenshotRef = `shot_${crypto.randomUUID()}`
    expect((await capturePageScreenshot(75, () => true, next)).ok).toBe(true)
    finish({ ok: true, result: { text: 'delayed', visual: oldView } })
    expect((await old).ok).toBe(false)
    expect(consumeVisualObservation(75, oldView.screenshotRef, first)).toBe(false)
    expect(consumeVisualObservation(75, h.view.screenshotRef, next)).toBe(true)
  })
  it.each(['consumed', 'other-session', 'revoked'])('refuses a %s screenshot before asking for action confirmation', async reason => {
    const h = fixture(); let current = true
    const owner = { scope: crypto.randomUUID(), current: () => current }
    await capturePageScreenshot(76, () => true, owner)
    if (reason === 'consumed') consumeVisualObservation(76, h.view.screenshotRef, owner)
    if (reason === 'revoked') current = false
    const authority = reason === 'other-session' ? { ...owner, scope: crypto.randomUUID() } : owner
    const authorize = vi.fn(async () => 'approved' as const)
    const before = h.sendMessage.mock.calls.length
    const answer = await dispatchToolCall({ id: 'stale-point', name: 'browser_click_at', args: { screenshotRef: h.view.screenshotRef, x: .3, y: .4 } },
      'auto', undefined, authorize, undefined, { id: 76, windowId: 1, url: 'https://example.test/design' }, () => true,
      { unrestrictedAccess: false, visualAuthority: authority })
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('browser_screenshot') } })
    expect(authorize).not.toHaveBeenCalled()
    expect(h.sendMessage).toHaveBeenCalledTimes(before)
  })
  it('keeps a fresh screenshot usable after a denied action confirmation', async () => {
    const h = fixture(), authority = { scope: crypto.randomUUID(), current: () => true }
    await capturePageScreenshot(77, () => true, authority)
    const authorize = vi.fn(async () => 'denied' as const), commit = vi.fn()
    const answer = await dispatchToolCall({ id: 'denied-point', name: 'browser_click_at', args: { screenshotRef: h.view.screenshotRef, x: .3, y: .4 } },
      'auto', undefined, authorize, undefined, { id: 77, windowId: 1, url: 'https://example.test/design' }, () => true,
      { unrestrictedAccess: false, visualAuthority: authority, commitAction: commit })
    expect(answer.ok).toBe(false)
    expect(authorize).toHaveBeenCalledTimes(1); expect(commit).not.toHaveBeenCalled()
    expect(consumeVisualObservation(77, h.view.screenshotRef, authority)).toBe(true)
  })
  it('rechecks a screenshot replaced while action confirmation was pending', async () => {
    const h = fixture(), authority = { scope: crypto.randomUUID(), current: () => true }, commit = vi.fn()
    await capturePageScreenshot(78, () => true, authority)
    const ref = h.view.screenshotRef
    const authorize = vi.fn(async () => {
      h.view.screenshotRef = `shot_${crypto.randomUUID()}`
      await capturePageScreenshot(78, () => true, authority)
      return 'approved' as const
    })
    const answer = await dispatchToolCall({ id: 'replaced-point', name: 'browser_click_at', args: { screenshotRef: ref, x: .3, y: .4 } },
      'auto', undefined, authorize, undefined, { id: 78, windowId: 1, url: 'https://example.test/design' }, () => true,
      { unrestrictedAccess: false, visualAuthority: authority, commitAction: commit })
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('browser_screenshot') } })
    expect(authorize).toHaveBeenCalledTimes(1); expect(commit).not.toHaveBeenCalled()
    expect(consumeVisualObservation(78, h.view.screenshotRef, authority)).toBe(true)
  })
})
