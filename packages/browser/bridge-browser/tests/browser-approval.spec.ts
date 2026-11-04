import { describe, expect, it, vi } from 'vitest'
import { BrowserApprovalGate } from '../src/browser-approval.ts'
import { BridgeToolError } from '../src/server.ts'

describe('browser approval retry boundary', () => {
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
  ] as const)('stops %s approval retries without altering the failure code', async (code, message) => {
    const gate = new BrowserApprovalGate(), agent = {}, work = vi.fn(async () => 'read')
    await expect(gate.request(agent, async () => { throw new BridgeToolError(code, message) })).rejects.toMatchObject({ code, message: expect.stringContaining('send a new message') })
    await expect(gate.request(agent, work)).rejects.toThrow('paused for this turn')
    expect(work).not.toHaveBeenCalled()
    gate.reset(agent)
    await expect(gate.request(agent, work)).resolves.toBe('read')
  })
  it('does not block on page timeouts, denied approvals or untrusted page errors', async () => {
    const gate = new BrowserApprovalGate(), agent = {}
    for (const error of [new BridgeToolError('timeout', 'browser_wait timed out'), new BridgeToolError('action-failed', 'The user denied the browser approval request for "browser_snapshot".'), new Error('The browser approval request for "browser_snapshot" timed out before the user responded.')]) {
      await expect(gate.request(agent, async () => { throw error })).rejects.toBe(error)
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
