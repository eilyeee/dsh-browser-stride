// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ServerFrame, ToolDispatchConfirmation } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { ToolExecutionFence } from '../src/background/execution-authority.ts'
import { wireToolCall } from './wire-tool-call.ts'

function call() { return wireToolCall({ t: 'tool.call', id: 'synthetic-scope', name: 'browser_press', args: { key: 'Enter' },
  sessionId: 'session-a', execution: { kind: 'run', runId: 'run-a', controlRevision: 2 }, expiresAt: Date.now() + 5000 }) as Extract<ServerFrame, { t: 'tool.call' }> }
const accepted = async (payload: ToolDispatchConfirmation) => ({ ...payload, confirmed: true })

describe('original Host execution confirmation', () => {
  it('cannot replace a Host expected target with a new local proposal', async () => {
    const request = vi.fn(accepted)
    const fence = new ToolExecutionFence({ ...call(), targetBinding: 'page_a' }, () => true, 'page_b')
    expect(await fence.confirm(request, new AbortController().signal)).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it('requires the accepted native target to match its proposal', async () => {
    const fence = new ToolExecutionFence(call(), () => true, 'page_a')
    expect(await fence.confirm(async payload => ({ ...payload, confirmed: true, targetBinding: 'page_b' }), new AbortController().signal)).toBe(false)
  })
  it('requires confirmation and never retries or renews it', async () => {
    const request = vi.fn(accepted)
    const fence = new ToolExecutionFence(call(), () => true)
    expect(fence.current()).toBe(false)
    const signal = new AbortController().signal
    expect(await fence.confirm(request, signal)).toBe(true)
    expect(fence.current()).toBe(true)
    fence.revoke()
    await fence.confirm(request, signal)
    expect(fence.current()).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each(['run', 'revision', 'session', 'action', 'digest', 'attempt'])('rejects a mismatched %s in the confirmation', async field => {
    const fence = new ToolExecutionFence(call(), () => true)
    expect(await fence.confirm(async payload => ({ ...payload, confirmed: true,
      ...(field === 'run' ? { execution: { kind: 'run', runId: 'other-run', controlRevision: 2 } }
        : field === 'revision' ? { execution: { kind: 'run', runId: 'run-a', controlRevision: 3 } }
        : field === 'session' ? { sessionId: 'other-session' }
        : field === 'attempt' ? { id: 'other-attempt' }
        : { action: { ...payload.action, ...(field === 'action' ? { actionId: 'other-action' } : { requestDigest: 'b'.repeat(64) }) } }),
    }), new AbortController().signal)).toBe(false)
    expect(fence.current()).toBe(false)
  })
  it.each(['cancel', 'owner', 'revoke'])('withholds a grant that arrives after %s', async change => {
    let resolve!: (value: unknown) => void
    let owner = true
    const controller = new AbortController()
    const fence = new ToolExecutionFence(call(), () => owner)
    const pending = fence.confirm(() => new Promise(value => { resolve = value }), controller.signal)
    if (change === 'cancel') controller.abort()
    if (change === 'owner') owner = false
    if (change === 'revoke') fence.revoke()
    resolve(await accepted(fence.confirmation))
    expect(await pending).toBe(false)
    owner = true
    expect(fence.current()).toBe(false)
  })
  it('refuses an expired call or failed confirmation before any browser work', async () => {
    const expired = new ToolExecutionFence({ ...call(), expiresAt: 1 }, () => true)
    const request = vi.fn(accepted)
    expect(await expired.confirm(request, new AbortController().signal)).toBe(false)
    expect(request).not.toHaveBeenCalled()
    const fence = new ToolExecutionFence(call(), () => true)
    expect(await fence.confirm(async () => { throw new Error('disconnected') }, new AbortController().signal)).toBe(false)
  })
})
