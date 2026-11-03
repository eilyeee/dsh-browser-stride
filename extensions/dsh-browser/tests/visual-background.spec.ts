// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capturePageScreenshot, consumeVisualObservation } from '../src/background/visual.ts'
import { debuggerPages, PageDispatchRevoked } from '../src/background/debugger-pages.ts'
import type { VisualObservation } from '@eilyeee/dsh-browser-stride/src/visual.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture() {
  const view: VisualObservation = { screenshotRef: `shot_${crypto.randomUUID()}`, width: 1000, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 2 }
  const sendMessage = vi.fn(async () => ({ ok: true, result: { text: 'synthetic', visual: { ...view } } }))
  vi.stubGlobal('chrome', { tabs: { sendMessage } })
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
})
