import { describe, expect, it, vi } from 'vitest'
import { BrowserApprovalGate } from '../src/browser-approval.ts'
import { BridgeToolError } from '../src/server.ts'

describe('browser approval retry boundary', () => {
  it('permits only target preparation after uncertain page input, and fences uncertain target changes themselves', async () => {
    const gate = new BrowserApprovalGate(), agent = {}, change = vi.fn(async () => 'reference')
    await expect(gate.request(agent, async () => { throw new BridgeToolError('timeout', 'unknown field result') }, 'browser_type')).rejects.toThrow()
    await expect(gate.request(agent, change, 'browser_open_tab')).resolves.toBe('reference')
    await expect(gate.request(agent, change, 'browser_follow_tab')).rejects.toMatchObject({ code: 'write-blocked-unconfirmed' })
    for (const name of ['browser_click', 'browser_type', 'browser_select', 'browser_navigate', 'browser_close_tab']) await expect(gate.request(agent, change, name)).rejects.toMatchObject({ code: 'write-blocked-unconfirmed' })
    await expect(gate.request(agent, async () => { throw new BridgeToolError('timeout', 'unknown open') }, 'browser_open_tab')).rejects.toThrow('unknown open')
    await expect(gate.request(agent, change, 'browser_follow_tab')).rejects.toMatchObject({ code: 'write-blocked-unconfirmed' })
    await expect(gate.request(agent, async () => 'observed', 'browser_snapshot')).resolves.toBe('observed')
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('permits another writable control after readonly refusal without clearing earlier uncertainty', async () => {
    const gate = new BrowserApprovalGate(), agent = {}, work = vi.fn(async () => 'editable')
    const refusal = new BridgeToolError('field-readonly', 'Read-only field')
    await expect(gate.request(agent, async () => { throw refusal }, 'browser_select')).rejects.toBe(refusal)
    expect(refusal.notDispatched).toBe(false)
    await expect(gate.request(agent, work, 'browser_type')).resolves.toBe('editable')
    await expect(gate.request(agent, async () => { throw new BridgeToolError('timeout', 'lost reply') }, 'browser_click')).rejects.toThrow('lost reply')
    await expect(gate.request(agent, work, 'browser_select')).rejects.toMatchObject({ code: 'write-blocked-unconfirmed' })
    expect(work).toHaveBeenCalledOnce()
  })
  it('permits another method after a Host-proven unsent refusal, while retaining unknown-write protection', async () => {
    const gate = new BrowserApprovalGate(), agent = {}, write = vi.fn(async () => 'alternative')
    await expect(gate.request(agent, async () => { throw new BridgeToolError('content-unavailable', 'Unsupported capability', true) }, 'browser_click_at')).rejects.toThrow('Unsupported capability')
    await expect(gate.request(agent, write, 'browser_click')).resolves.toBe('alternative')
    await expect(gate.request(agent, async () => { throw new BridgeToolError('timeout', 'lost reply') }, 'browser_click')).rejects.toThrow('lost reply')
    await expect(gate.request(agent, write, 'browser_click')).rejects.toMatchObject({ code: 'write-blocked-unconfirmed', notDispatched: true })
    expect(write).toHaveBeenCalledOnce()
  })

  it.each([true, false])('retains Host dispatch knowledge through design failure guidance: unsent=%s', async notDispatched => {
    const gate = new BrowserApprovalGate(), agent = {}
    await expect(gate.request(agent, async () => { throw new BridgeToolError('content-unavailable', 'Unavailable view', notDispatched) }, 'browser_set_design_zoom'))
      .rejects.toMatchObject({ notDispatched, message: expect.stringContaining('enlarge the design view manually') })
    await expect(gate.request(agent, async () => 'not reached', 'browser_snapshot'))
      .rejects.toMatchObject({ notDispatched: true })
  })

  it('does not accept an unsent claim from an arbitrary error', async () => {
    const gate = new BrowserApprovalGate(), agent = {}, write = vi.fn(async () => 'unsafe')
    const fake = Object.assign(new Error('no action sent'), { code: 'content-unavailable', notDispatched: true })
    await expect(gate.request(agent, async () => { throw fake }, 'browser_click')).rejects.toBe(fake)
    await expect(gate.request(agent, write, 'browser_click')).rejects.toThrow('unconfirmed result')
    expect(write).not.toHaveBeenCalled()
  })

  it('allows fresh observation and another method after a stale reference without applying an action', async () => {
    const gate = new BrowserApprovalGate(), agent = {}
    await expect(gate.request(agent, async () => { throw new BridgeToolError('element-stale', 'stale') }, 'browser_click')).rejects.toThrow('stale')
    await expect(gate.request(agent, async () => 'fresh', 'browser_snapshot')).resolves.toBe('fresh')
    await expect(gate.request(agent, async () => 'observed alternative', 'browser_click')).resolves.toBe('observed alternative')
  })
  it.each(['timeout', 'action-failed', 'content-unavailable'] as const)('blocks more writes after %s, retaining reads and Agent isolation', async code => {
    const gate = new BrowserApprovalGate(), agent = {}, write = vi.fn(async () => 'unsafe')
    await expect(gate.request(agent, async () => { throw new BridgeToolError(code, 'synthetic failure') }, 'browser_click')).rejects.toThrow('synthetic failure')
    await expect(gate.request(agent, write, 'browser_click')).rejects.toThrow('unconfirmed result')
    expect(write).not.toHaveBeenCalled()
    await expect(gate.request(agent, async () => 'observed', 'browser_snapshot')).resolves.toBe('observed')
    await expect(gate.request(agent, write, 'browser_click')).rejects.toThrow('unconfirmed result')
    await expect(gate.request({}, write, 'browser_click')).resolves.toBe('unsafe')
    gate.reset(agent)
    await expect(gate.request(agent, async () => 'new user turn', 'browser_click')).resolves.toBe('new user turn')
  })
  it('also fences an unconfirmed successful field readback without claiming business success', async () => {
    const gate = new BrowserApprovalGate(), agent = {}
    await gate.request(agent, async () => ({ feedback: { version: 1, state: 'readback-unconfirmed', businessChange: 'not-verified' } }), 'browser_type')
    await expect(gate.request(agent, async () => 'repeat', 'browser_type')).rejects.toThrow('Do not edit the page')
    await expect(gate.request(agent, async () => 'readback', 'browser_get_text')).resolves.toBe('readback')
  })
  it('releases only an authenticated no-selection failure for new observations or another method', async () => {
    const gate = new BrowserApprovalGate(), agent = {}, work = vi.fn(async () => 'fresh observation')
    let reject!: (error: Error) => void
    const pending = gate.request(agent, () => new Promise((_, no) => { reject = no }), 'browser_set_design_zoom')
    const outcome = expect(pending).rejects.toMatchObject({ code: 'design-zoom-not-selected', message: expect.stringContaining('fresh observation') })
    await expect(gate.request(agent, work)).rejects.toThrow('in progress')
    reject(new BridgeToolError('design-zoom-not-selected', 'No unique control'))
    await outcome
    await expect(gate.request(agent, work)).resolves.toBe('fresh observation')
    await expect(gate.request(agent, async () => 'observed alternative', 'browser_select')).resolves.toBe('observed alternative')
    expect(work).toHaveBeenCalledOnce()
  })
  it('does not release preparation for page-like messages, spoofed codes, transport loss or readback failures', async () => {
    for (const error of [new Error('No percentage selection was dispatched.'), Object.assign(new Error('fake'), { code: 'design-zoom-not-selected' }),
      new BridgeToolError('action-failed', 'No percentage selection was dispatched.'), new BridgeToolError('timeout', 'lost reply'),
      new BridgeToolError('action-failed', 'Design zoom readback failed')]) {
      const gate = new BrowserApprovalGate(), agent = {}
      await expect(gate.request(agent, async () => { throw error }, 'browser_set_design_zoom')).rejects.toThrow('Stop browser calls')
      await expect(gate.request(agent, async () => 'unsafe alternative')).rejects.toThrow('Stop browser calls')
    }
  })
  it('fences parallel work during zoom preparation, then stops that Agent on failure until a fresh turn', async () => {
    const gate = new BrowserApprovalGate(), agent = {}, other = {}, work = vi.fn(async () => 'browser')
    let reject!: (error: Error) => void
    const preparing = gate.request(agent, () => new Promise((_, no) => { reject = no }), 'browser_set_design_zoom')
    const outcome = expect(preparing).rejects.toThrow('enlarge the design view manually')
    await expect(gate.request(agent, work)).rejects.toThrow('in progress')
    expect(work).not.toHaveBeenCalled()
    reject(new BridgeToolError('content-unavailable', 'No supported control'))
    await outcome
    await expect(gate.request(agent, work)).rejects.toThrow('Stop browser calls')
    await expect(gate.request(other, work)).resolves.toBe('browser')
    gate.reset(agent)
    await expect(gate.request(agent, work)).resolves.toBe('browser')
  })
  it('releases a confirmed zoom and never lets a retired failure block a new turn', async () => {
    const gate = new BrowserApprovalGate(), agent = {}
    await gate.request(agent, async () => 'confirmed', 'browser_set_design_zoom')
    await expect(gate.request(agent, async () => 'read')).resolves.toBe('read')
    let reject!: (error: Error) => void
    const preparing = gate.request(agent, () => new Promise((_, no) => { reject = no }), 'browser_set_design_zoom')
    const outcome = expect(preparing).rejects.toThrow('Stop browser calls')
    gate.reset(agent)
    await gate.request(agent, async () => 'new')
    reject(new Error('retired failure')); await outcome
    await expect(gate.request(agent, async () => 'read')).resolves.toBe('read')
  })
  it.each([
    ['timeout', 'The browser approval request for "browser_snapshot" timed out before the user responded.'],
    ['action-failed', 'No browser side panel was available to receive or complete the approval request for "browser_snapshot".'],
    ['action-failed', 'The user denied the browser approval request for "browser_snapshot".'],
  ] as const)('stops %s approval retries without altering the failure code', async (code, message) => {
    const gate = new BrowserApprovalGate(), agent = {}, work = vi.fn(async () => 'read')
    await expect(gate.request(agent, async () => { throw new BridgeToolError(code, message) })).rejects.toMatchObject({ code, message: expect.stringContaining('send a new message') })
    await expect(gate.request(agent, work)).rejects.toThrow('paused for this turn')
    expect(work).not.toHaveBeenCalled()
    gate.reset(agent)
    await expect(gate.request(agent, work)).resolves.toBe('read')
  })
  it('does not block on read timeouts or untrusted page errors', async () => {
    const gate = new BrowserApprovalGate(), agent = {}
    for (const error of [new BridgeToolError('timeout', 'browser_wait timed out'), new Error('The browser approval request for "browser_snapshot" timed out before the user responded.')]) {
      await expect(gate.request(agent, async () => { throw error }, 'browser_snapshot')).rejects.toBe(error)
      await expect(gate.request(agent, async () => 'ok')).resolves.toBe('ok')
    }
  })
  it('does not carry a late failure from a retired turn into a new turn', async () => {
    const gate = new BrowserApprovalGate(), agent = {}
    let reject!: (error: Error) => void
    const pending = gate.request(agent, () => new Promise((_, no) => { reject = no }))
    const outcome = expect(pending).rejects.toThrow('Stop browser calls')
    gate.reset(agent)
    await gate.request(agent, async () => 'new turn')
    reject(new BridgeToolError('timeout', 'The browser approval request for "browser_snapshot" timed out before the user responded.'))
    await outcome
    await expect(gate.request(agent, async () => 'ok')).resolves.toBe('ok')
  })
})
