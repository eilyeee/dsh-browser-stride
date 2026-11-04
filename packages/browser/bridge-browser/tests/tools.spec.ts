import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { BridgeToolError } from '../src/server.ts'
import { BROWSER_TOOL_NAMES, registerBrowserTools } from '../src/tools.ts'

describe('registerBrowserTools', () => {
  function makeHarness() {
    const registered: { name: string; definition: Record<string, unknown> }[] = []
    const ctx = {
      on: vi.fn(() => () => {}),
      tools: {
        register: vi.fn((definition: { name: string }) => {
          registered.push({ name: definition.name, definition: definition as Record<string, unknown> })
          return () => {}
        }),
      },
    } as unknown as Context
    const requestTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal, _timeoutMs?: number): Promise<unknown> => {
      return { text: 'ok' }
    })
    const bridge = { requestTool } as unknown as BridgeServer
    return { ctx, bridge, requestTool, registered }
  }

  it('blocks approval retries across browser tools until a new turn, without affecting another Agent', async () => {
    const h = makeHarness()
    const agent = { id: 'approval-session' }, other = { id: 'other-session' }
    Object.assign(h.ctx, { agents: { get: () => agent }, get: () => ({ saveImage: vi.fn() }) })
    h.requestTool.mockRejectedValueOnce(new BridgeToolError('timeout', 'The browser approval request for "browser_list_tabs" timed out before the user responded.'))
    registerBrowserTools(h.ctx, h.bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = (name: string) => h.registered.find(item => item.name === name)!.definition.execute as (a: unknown, e: unknown) => Promise<unknown>
    const signal = new AbortController().signal
    await expect(tool('browser_list_tabs')({}, { agent, signal })).rejects.toThrow('Stop browser calls')
    await expect(tool('browser_list_tabs')({}, { agent, signal })).rejects.toThrow('paused for this turn')
    await expect(tool('browser_screenshot')({}, { agent, signal })).rejects.toThrow('paused for this turn')
    await expect(tool('browser_read_design_styles')({}, { agent, signal })).rejects.toThrow('paused for this turn')
    expect(h.requestTool).toHaveBeenCalledTimes(1)
    await expect(tool('browser_snapshot')({}, { agent: other, signal })).resolves.toEqual({ text: 'ok' })
    const on = h.ctx.on as ReturnType<typeof vi.fn>
    const event = on.mock.calls.find(([name]) => name === 'session/event')![1]
    event({ id: agent.id }, { type: 'turn/start' })
    await expect(tool('browser_snapshot')({}, { agent, signal })).resolves.toEqual({ text: 'ok' })
    expect(h.requestTool).toHaveBeenCalledTimes(3)
  })

  it('admits screenshot bytes through Host storage and renders a real image block, including inside run_code', async () => {
    const h = makeHarness()
    const attachment = { attachmentId: 'synthetic-image', mediaType: 'image/jpeg', bytes: 4, width: 800, height: 600, name: 'Browser viewport.jpg' }
    const saveImage = vi.fn(async () => attachment)
    Object.assign(h.ctx, { get: vi.fn(() => ({ saveImage })) })
    h.requestTool.mockResolvedValueOnce({ text: 'Synthetic design canvas', screenshotRef: 'shot_00000000-0000-4000-8000-000000000001',
      width: 1000, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 2, mediaType: 'image/jpeg', data: '/9j/2Q==' })
    registerBrowserTools(h.ctx, h.bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = h.registered.find(item => item.name === 'browser_screenshot')!.definition
    const execute = tool.execute as (args: unknown, exec: unknown) => Promise<{ text: string; attachment: unknown }>
    const value = await execute({}, { signal: new AbortController().signal, agent: { id: 'image-session' } })
    expect(h.requestTool).toHaveBeenCalledWith('browser_screenshot', {}, expect.any(AbortSignal), 1000, 'image-session')
    expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from('/9j/2Q==', 'base64'), mediaType: 'image/jpeg', name: 'Browser viewport.jpg' })
    expect(value).not.toHaveProperty('data')
    const render = (tool.output as { render: (args: unknown, value: unknown) => unknown }).render
    expect(render({}, value)).toEqual([{ type: 'text', text: expect.stringContaining('next model step') }, { type: 'image', attachment }])
  })

  it('does not acquire image bytes when Host attachment storage is unavailable', async () => {
    const h = makeHarness(); Object.assign(h.ctx, { get: () => undefined })
    registerBrowserTools(h.ctx, h.bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = h.registered.find(item => item.name === 'browser_screenshot')!.definition
    await expect((tool.execute as (a: unknown, e: unknown) => Promise<unknown>)({}, { signal: new AbortController().signal })).rejects.toThrow('attachment service')
    expect(h.requestTool).not.toHaveBeenCalled()
  })

  it('keeps screenshot coordinates separate from DOM element refs and strips unrecognized fields', async () => {
    const h = makeHarness(); registerBrowserTools(h.ctx, h.bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = h.registered.find(item => item.name === 'browser_click_at')!.definition
    const signal = new AbortController().signal
    await (tool.execute as (a: unknown, e: unknown) => Promise<unknown>)({ screenshotRef: 'shot_synthetic', x: 0.25, y: 0.5, frame: 7, scope: 'forged' }, { signal })
    expect(h.requestTool).toHaveBeenCalledWith('browser_click_at', { screenshotRef: 'shot_synthetic', x: 0.25, y: 0.5 }, signal, 1000)
  })

  it('registers the full v1 tool set', () => {
    const { ctx, bridge, registered } = makeHarness()
    const disposers = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    expect(registered.map((r) => r.name).sort()).toEqual([...BROWSER_TOOL_NAMES].sort())
    expect(disposers.size).toBe(BROWSER_TOOL_NAMES.length)
    for (const dispose of disposers.values()) dispose()
  })

  it('reads inspector fields through the existing authorized text action and original session', async () => {
    const h = makeHarness()
    h.requestTool.mockResolvedValueOnce({ text: 'Layer: Background\nwidth: 320px\nheight: 144px\nFill: #2563eb' })
    registerBrowserTools(h.ctx, h.bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = h.registered.find(item => item.name === 'browser_read_design_styles')!.definition
    const signal = new AbortController().signal
    const result = await (tool.execute as (a: unknown, e: unknown) => Promise<{ text: string }>)({ region: ' #properties ', frame: 2, text: 'forged', sessionId: 'forged' }, { agent: { id: 'design-session' }, signal })
    expect(h.requestTool).toHaveBeenCalledExactlyOnceWith('browser_get_text', { selector: '#properties', frame: 2 }, signal, 1000, 'design-session')
    expect(result.text).toContain('untrusted data')
    const report = JSON.parse(result.text.slice(result.text.indexOf('{')))
    expect(report.properties.width.value).toBe('320px')
    expect(report.layer.value).toBe('Background')
    expect(report.properties.fontWeight).toBeUndefined()
  })

  it('measures one frame through the original session and rejects invalid selectors before dispatch', async () => {
    const h = makeHarness()
    registerBrowserTools(h.ctx, h.bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = h.registered.find(item => item.name === 'browser_measure_layout')!.definition
    const execute = tool.execute as (a: unknown, e: unknown) => Promise<unknown>
    const exec = { agent: { id: 'layout-session' }, signal: new AbortController().signal }
    for (const args of [{}, { selector: ' ' }, { selector: 'x'.repeat(501) }, { selector: '.card', referenceSelector: 1 }]) {
      await expect(execute(args, exec)).rejects.toThrow()
    }
    expect(h.requestTool).not.toHaveBeenCalled()
    await execute({ selector: ' .card ', referenceSelector: ' .hero ', frame: 2, sessionId: 'forged', javascript: 'forged' }, exec)
    expect(h.requestTool).toHaveBeenCalledExactlyOnceWith('browser_measure_layout', { selector: '.card', referenceSelector: '.hero', frame: 2 }, exec.signal, 1000, 'layout-session')
  })

  it('validates bounded design zoom and forwards only the original session and frame', async () => {
    const h = makeHarness()
    registerBrowserTools(h.ctx, h.bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const execute = h.registered.find(item => item.name === 'browser_set_design_zoom')!.definition.execute as (a: unknown, e: unknown) => Promise<unknown>
    const exec = { agent: { id: 'zoom-session' }, signal: new AbortController().signal }
    for (const percent of [undefined, NaN, 99, 201, '150']) {
      await expect(execute({ percent }, exec)).rejects.toThrow()
    }
    expect(h.requestTool).not.toHaveBeenCalled()
    await execute({ percent: 150, frame: 2, sessionId: 'forged', javascript: 'forged' }, exec)
    expect(h.requestTool).toHaveBeenCalledExactlyOnceWith('browser_set_design_zoom', { percent: 150, frame: 2 }, exec.signal, 1000, 'zoom-session')
  })

  it('can parse bounded page text without inventing an inspector selector', async () => {
    const h = makeHarness()
    registerBrowserTools(h.ctx, h.bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = h.registered.find(item => item.name === 'browser_read_design_styles')!.definition
    const signal = new AbortController().signal
    const result = await (tool.execute as (a: unknown, e: unknown) => Promise<{ text: string }>)({}, { signal })
    expect(h.requestTool).toHaveBeenCalledExactlyOnceWith('browser_get_text', {}, signal, 1000)
    expect(JSON.parse(result.text.slice(result.text.indexOf('{'))).status).toBe('unrecognized')
  })

  it('rejects invalid design regions before a browser read and preserves read failures/cancellation', async () => {
    const h = makeHarness()
    registerBrowserTools(h.ctx, h.bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = h.registered.find(item => item.name === 'browser_read_design_styles')!.definition
    const execute = tool.execute as (a: unknown, e: unknown) => Promise<unknown>
    const controller = new AbortController()
    for (const region of ['', '  ', 1, 'x'.repeat(501)]) await expect(execute({ region }, { signal: controller.signal })).rejects.toThrow()
    expect(h.requestTool).not.toHaveBeenCalled()
    h.requestTool.mockRejectedValueOnce(new Error('selected page lost'))
    await expect(execute({}, { signal: controller.signal })).rejects.toThrow('selected page lost')
    h.requestTool.mockImplementationOnce(async () => { controller.abort(); return { text: 'Layer: Old\nwidth: 320px' } })
    await expect(execute({}, { signal: controller.signal })).rejects.toThrow('cancelled')
  })

  it('executes browser_click with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ elementRef: 'obs_test:3', frame: 7 }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_click', { elementRef: 'obs_test:3', frame: 7 }, exec.signal, 1_000)
    expect(result).toEqual({ text: 'ok' })
  })

  it('associates browser calls with the owning Agent session', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = {
      signal: new AbortController().signal,
      agent: { id: 'session-browser' },
    }

    await (tool.definition.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ elementRef: 'obs_test:3' }, exec)

    expect(requestTool).toHaveBeenCalledWith(
      'browser_click',
      { elementRef: 'obs_test:3' },
      exec.signal,
      1_000,
      'session-browser',
    )
  })

  it('normalizes snapshot args (delta/region omitted when absent)', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_snapshot')!
    const exec = { signal: new AbortController().signal }
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true }, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', {}, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true, region: 'main' }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true, region: 'main' }, exec.signal, 1_000)
  })

  it('executes every remaining tool with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const byName = new Map(registered.map((r) => [r.name, r.definition]))
    const exec = { signal: new AbortController().signal }
    const run = async (name: string, args: unknown): Promise<void> => {
      await (byName.get(name)!.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<unknown>)(args, exec)
    }

    await run('browser_type', { elementRef: 'obs_test:2', text: 'hello' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { elementRef: 'obs_test:2', text: 'hello' }, exec.signal, 1_000)
    await run('browser_type', { elementRef: 'obs_test:2', text: 'hello', replace: true })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { elementRef: 'obs_test:2', text: 'hello', replace: true }, exec.signal, 1_000)
    await run('browser_type', { elementRef: 'obs_test:2', frame: 4, text: 'inside frame' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { elementRef: 'obs_test:2', frame: 4, text: 'inside frame' }, exec.signal, 1_000)
    await run('browser_select', { elementRef: 'obs_test:2', frame: 4, optionIndex: 1 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_select', { elementRef: 'obs_test:2', frame: 4, optionIndex: 1 }, exec.signal, 1_000)

    await run('browser_press', { key: 'Enter' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_press', { key: 'Enter' }, exec.signal, 1_000)

    await run('browser_scroll', { direction: 'down', amount: 200 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', amount: 200 }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'top' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'top' }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'down', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', frame: 4 }, exec.signal, 1_000)

    await run('browser_navigate', { url: 'https://example.com' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_navigate', { url: 'https://example.com' }, exec.signal, 1_000)
    await run('browser_open_tab', { url: 'https://example.com/new' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_open_tab', { url: 'https://example.com/new' }, exec.signal, 1_000)
    await run('browser_open_tab', { url: 'https://example.com/bg', active: false })
    expect(requestTool).toHaveBeenLastCalledWith(
      'browser_open_tab',
      { url: 'https://example.com/bg', active: false },
      exec.signal,
      1_000,
    )

    await run('browser_list_tabs', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_list_tabs', {}, exec.signal, 1_000)
    await run('browser_follow_tab', { tabId: 17 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_follow_tab', { tabId: 17 }, exec.signal, 1_000)
    await run('browser_close_tab', { tabId: 18 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_close_tab', { tabId: 18 }, exec.signal, 1_000)

    for (const name of ['browser_back', 'browser_forward', 'browser_reload'] as const) {
      await run(name, {})
      expect(requestTool).toHaveBeenLastCalledWith(name, {}, exec.signal, 1_000)
    }

    await run('browser_get_text', { selector: '#main' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: '#main' }, exec.signal, 1_000)
    await run('browser_get_text', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', {}, exec.signal, 1_000)
    await run('browser_get_text', { selector: 'main', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: 'main', frame: 4 }, exec.signal, 1_000)

    await run('browser_wait', { ms: 100 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { ms: 100 }, exec.signal, 1_000)
    await run('browser_wait', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', {}, exec.signal, 1_000)
    await run('browser_wait', { frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { frame: 4 }, exec.signal, 1_000)
  })

  it('normalizes every DSH parameter map to JSON Schema before registration', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    for (const { definition } of registered) {
      const params = definition.parameters as { type?: unknown; properties?: unknown }
      expect(params.type).toBe('object')
      expect(params.properties).toBeDefined()
    }
    const click = registered.find(({ name }) => name === 'browser_click')!.definition.parameters as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(click.properties.elementRef).toBeDefined()
    expect(click.required).toContain('elementRef')
  })

  it('declares cooperative timeoutMs on every tool', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    for (const { definition } of registered) {
      expect(definition.timeoutMs).toBe(5_000)
    }
  })

  it('keeps model-facing tool schemas in English', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const han = /\p{Script=Han}/u
    for (const { definition } of registered) {
      expect(String(definition.description)).not.toMatch(han)
      expect(JSON.stringify(definition.parameters)).not.toMatch(han)
    }
  })

  it('keeps model-facing tool descriptions concise', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const descriptionChars = registered.reduce((sum, { definition }) => sum + String(definition.description).length, 0)
    expect(descriptionChars).toBeLessThan(2_100)
  })

  it('exposes optional frame routing on frame-local tools only', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const byName = new Map(registered.map((entry) => [entry.name, entry.definition]))
    for (const name of ['browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_get_text', 'browser_wait']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: { type?: unknown } } }
      expect(params.properties.frame?.type).toBe('number')
    }
    for (const name of ['browser_snapshot', 'browser_navigate', 'browser_open_tab', 'browser_list_tabs', 'browser_follow_tab', 'browser_close_tab', 'browser_back', 'browser_forward', 'browser_reload']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: unknown } }
      expect(params.properties.frame).toBeUndefined()
    }
  })

  it('falls back to a no-text payload when the extension returns non-text', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockResolvedValueOnce(null)
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_wait')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(result).toEqual({ text: expect.stringContaining('no text') })
  })

  it('renders the canonical result as one text block', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const output = tool.definition.output as { render: (args: unknown, value: unknown) => unknown }
    expect(output.render({}, { text: 'hello' })).toEqual([{ type: 'text', text: 'hello' }])
  })
})
