// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { NATIVE_TAKEOVER_KEY, NativeTakeoverFence } from '../src/background/native-takeover.ts'

function storage(initial: Record<string, unknown> = {}) {
  let values = structuredClone(initial)
  return { get: vi.fn(async () => structuredClone(values)), set: vi.fn(async (next: Record<string, unknown>) => { values = structuredClone(next) }) }
}
describe('native takeover write fence', () => {
  it('blocks affected sessions and future sessions on the page until their own native handoff', async () => {
    const disk = storage(), fence = new NativeTakeoverFence(disk); await fence.ready
    const old = fence.capture('first', 7), other = fence.capture('other', 8)
    expect(old()).toBe(true)
    fence.block(7, ['first', 'second', undefined])
    expect(old()).toBe(false); expect(other()).toBe(true)
    expect(fence.capture('first', 8)()).toBe(false) // A model tab switch is not a handoff.
    expect(fence.capture('new-session', 7)()).toBe(false)
    expect(fence.capture(undefined, 7)()).toBe(false)
    const beforeHandoff = fence.capture('first', 7)
    expect(await fence.acknowledge(7, 'first')).toBe(true)
    expect(beforeHandoff()).toBe(false); expect(old()).toBe(false)
    expect(fence.capture('first', 7)()).toBe(true)
    expect(fence.capture('second', 7)()).toBe(false)
    expect(fence.capture('new-session', 7)()).toBe(false)
    fence.block(7, ['first', 'second'])
    expect(fence.capture('first', 7)()).toBe(false)
  })
  it('retains the deny fence across a worker restart without restoring acknowledgements', async () => {
    const disk = storage(), first = new NativeTakeoverFence(disk); await first.ready
    first.block(7, ['a', 'b']); await first.acknowledge(7, 'a')
    const next = new NativeTakeoverFence(disk)
    expect(next.capture('a', 7)()).toBe(false); await next.ready
    expect(next.capture('a', 7)()).toBe(false)
    expect(next.capture('b', 8)()).toBe(false)
    await next.acknowledge(7, 'a'); expect(next.capture('a', 7)()).toBe(true)
    expect(next.capture('b', 7)()).toBe(false)
  })
  it('merges intervention during loading and does not revive receive-time permits', async () => {
    let release!: (value: Record<string, unknown>) => void
    const disk = storage(); disk.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const fence = new NativeTakeoverFence(disk), before = fence.capture('a', 7)
    fence.block(7, ['a']); release({ [NATIVE_TAKEOVER_KEY]: { tabs: [8], sessions: ['b'] } }); await fence.ready
    expect(before()).toBe(false); expect(fence.capture('b', 8)()).toBe(false)
    await fence.acknowledge(7, 'a'); expect(before()).toBe(false)
    expect(fence.capture('a', 7)()).toBe(true)
    expect(fence.capture('b', 8)()).toBe(false)
  })
  it.each(['persisted', 'intervened', 'failed'])('does not grant writes while native handoff persistence is %s', async mode => {
    const disk = storage(), fence = new NativeTakeoverFence(disk); await fence.ready
    fence.block(7, ['a']); await fence.acknowledge(7, 'a'); fence.block(7, ['a'])
    await vi.waitFor(() => expect(disk.set.mock.calls.length).toBeGreaterThanOrEqual(3))
    let release!: () => void
    disk.set.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { release = () => mode === 'failed' ? reject(Error('offline')) : resolve() }))
    const acknowledgement = fence.acknowledge(7, 'a')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(fence.capture('a', 7)()).toBe(false)
    if (mode === 'intervened') fence.block(7, ['a'])
    release()
    expect(await acknowledgement).toBe(mode === 'persisted')
    expect(fence.capture('a', 7)()).toBe(mode === 'persisted')
  })
  it.each(['read', 'write', 'corrupt', 'capacity'])('keeps writes denied after a %s storage failure', async reason => {
    const disk = storage(reason === 'corrupt' ? { [NATIVE_TAKEOVER_KEY]: { tabs: ['7'], sessions: [] } } : {})
    if (reason === 'read') disk.get.mockRejectedValue(Error('offline'))
    const fence = new NativeTakeoverFence(disk, reason === 'capacity' ? 1 : 5000); await fence.ready
    if (reason === 'write') disk.set.mockRejectedValue(Error('offline'))
    if (reason === 'capacity') fence.block(7, ['a', 'b'])
    else fence.block(7, ['a'])
    expect(await fence.acknowledge(7, 'a')).toBe(false)
    expect(fence.capture('a', 7)()).toBe(false)
  })
})
