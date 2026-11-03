import { describe, expect, it } from 'vitest'
import { isBrowserScreenshot, MAX_SCREENSHOT_BASE64 } from '../src/visual.ts'
import { isReadOnlyBrowserTool, parseBridgeFrame } from '../src/protocol.ts'
const screenshot = { text: 'Synthetic viewport', screenshotRef: 'shot_00000000-0000-4000-8000-000000000001', width: 1000, height: 800,
  scrollX: 0, scrollY: 0, devicePixelRatio: 2, mediaType: 'image/jpeg', data: '/9j/2Q==' }
describe('bounded visual protocol', () => {
  it('keeps optional image capability compatible with text-only v4 peers', () => {
    const caps = { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 }
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps }))).toBeDefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { ...caps, visualViewport: true } }))).toMatchObject({ caps: { visualViewport: true } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { ...caps, visualViewport: 'true' } }))).toBeUndefined()
    expect(isReadOnlyBrowserTool('browser_screenshot')).toBe(true)
    expect(isReadOnlyBrowserTool('browser_click_at')).toBe(false)
  })
  it('requires bounded image bytes, a viewport and an opaque screenshot reference', () => {
    expect(isBrowserScreenshot(screenshot)).toBe(true)
    for (const change of [{ data: 'https://example.com/image.jpg' }, { data: 'A'.repeat(MAX_SCREENSHOT_BASE64 + 4) }, { width: 0 }, { height: 8193 },
      { devicePixelRatio: NaN }, { screenshotRef: 'forged' }, { mediaType: 'image/svg+xml' }]) {
      expect(isBrowserScreenshot({ ...screenshot, ...change })).toBe(false)
    }
  })
})
